/* eslint-disable no-continue */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-param-reassign */
import { URL } from 'url';
import BrowserClient from '../browserclient/BrowserClient';
import Project from '../storage/base/Project';
import Resource from '../storage/base/Resource';
import Plugin, { PluginOpts } from '../plugins/Plugin';
import PluginStore from '../pluginstore/PluginStore';
import { getLogger } from '../logger/Logger';
import Storage from '../storage/base/Storage';
import { scenarios, mergePluginOpts } from '../scenarios/scenarios';
import Exporter, { ExportOptions } from '../export/Exporter';
import CsvExporter from '../export/CsvExporter';
import ZipExporter from '../export/ZipExporter';
import { decode } from '../confighash/config-hash';

/*
scraper is:
- browser agnostic (init browser client outside scraper)
- storage agnostic (init storage outside scraper)
*/

export type ScrapeDefinition = {
  url: string,
  scenario: string,
  pluginOpts: PluginOpts[]
}
export default class Scraper {
  logger = getLogger('Scraper');

  storage: Storage;
  browserClient:BrowserClient;
  project: Project;

  constructor(storage: Storage, browserClient:BrowserClient) {
    this.storage = storage;
    this.browserClient = browserClient;
  }

  async preScrape():Promise<void> {
    if (PluginStore.store.size === 0) {
      await PluginStore.init();
      this.logger.info(`PluginStore initialized, ${PluginStore.store.size} plugins found`);
    }

    if (!this.storage.isConnected) {
      await this.storage.connect();
      this.logger.info('Storage connected');
    }

    if (!this.browserClient.isLaunched) {
      await this.browserClient.launch();
    }
  }

  async initProject(scrapeConfig: Project|ScrapeDefinition|string):Promise<Project> {
    let project:Project;

    if (scrapeConfig instanceof Project) {
      project = scrapeConfig;
    }
    else {
      const scrapeDef:ScrapeDefinition = typeof scrapeConfig === 'string' ? decode(scrapeConfig) : scrapeConfig;
      const { Project } = this.storage;
      project = new Project({
        name: new URL(scrapeDef.url).hostname,
        url: scrapeDef.url,
        pluginOpts: scenarios[scrapeDef.scenario]
          ? mergePluginOpts(scenarios[scrapeDef.scenario].defaultPluginOpts, scrapeDef.pluginOpts)
          : scrapeDef.pluginOpts,
      });
      await project.save();
      this.logger.info(`new Project ${project.name} saved`);
    }

    return project;
  }

  async postScrape() {
    await this.browserClient.close();
  }

  async scrape(project: Project):Promise<Project>
  async scrape(scrapeDefinition: ScrapeDefinition):Promise<Project>
  async scrape(scrapeHash: string):Promise<Project>
  async scrape(scrapeConfig: Project|ScrapeDefinition|string) {
    try {
      await this.preScrape();
      this.project = await this.initProject(scrapeConfig);
    }
    catch (err) {
      this.logger.error(err, 'Error preScraping operations');
      // no project > no scrape process > abort
      throw err;
    }

    this.logger.debug(this.project, 'Scraping project');
    try {
      this.project.plugins = this.project.initPlugins();
    }
    catch (err) {
      this.logger.error(err, 'Error instantiating plugin definitions for project %s', this.project.name);
      // no plugins > no scrape process > abort
      throw err;
    }

    /*
    scrapeResource always starts by retrieving a (static) resource from db
    in case of dynamic actions, each valid dynamic action found will create a dynamic resource
    scrapeResource will be triggered again with the newly created dynamic resource
    only a single dynamic action (from a single plugin) can be triggered in a scrapeResource call

    when scrapeResource returns null => there are no more resources to be scraped in db, stop scraping
    */
    let resource: Resource;
    do {
      resource = await this.scrapeResource(this.project);
    }
    while (resource);

    await this.postScrape();

    return this.project;
  }

  async scrapeResource(project: Project, resource: Resource = null):Promise<Resource> {
    // dynamic resource, a resource that was modified by a dynamic action: scroll, click, ..
    if (resource && resource.actions) {
      this.logger.info('Started re-scraping a dynamic resource from project %s, url %s, dynamic action %s', project.name, resource.url, resource.actions);
    }
    else {
      this.logger.info('Started scraping a new resource from project %s', project.name);
    }

    let pluginIdx: number;
    try {
      /*
      will execute the plugins in the order they are defined
      apply each plugin to the current (project, resource) pair
      */
      for (pluginIdx = 0; pluginIdx < project.plugins.length; pluginIdx += 1) {
        const result = await this.executePlugin(project, resource, project.plugins[pluginIdx]);

        /*
        a plugin result can represent:
        - a new static resource: Resource from the db not yet scraped (ex: SelectResourcePlugin)
        - additional data/content to be merged with the current resource (ex: ExtractUrlsPlugin, ExtractHtmlContentPlugin, ...)
        */
        this.logger.debug(result || undefined, 'Plugin result');

        // current plugin did not returned a result, move on to the next one
        if (!result) continue;

        // a new static resource has been selected for scraping
        if (result instanceof Resource) {
          resource = result;
        }
        // new content has been generated to be merged wih the current resource
        else {
          Object.assign(resource, result);
        }
      }

      if (resource) {
        this.logger.debug(resource, 'Resource successfully scraped');
        this.logger.info('Resource successfully scraped %s', resource.url);
      }
      else {
        this.logger.info('No scrapable resource found for project %s', project.name);
      }
    }
    catch (err) {
      this.logger.error(
        err,
        'Crawl error for project %s , Plugin %s against resource %s',
        project.name, project.plugins[pluginIdx].constructor.name, resource ? resource.url : '',
      );

      /*
      manually update the resource, this resets the scrapeInProgress flag and adds scrapedAt date
      selecting new resources for scraping takes scrapedAt in consideration (right now only resources with scrapedAt undefined qualify)
      because of the above behavior, we don't attempt to scrape a resource that throws an error over and over again

      in future a possible approach will be just resetting the scrapeInProgress flag
        - next scrape operation will attempt to scrape it again, but atm this will just retry the same resource over and over again
        - there is no mechanism to escape the retry loop
      resource.scrapeInProgress = false;
      await resource.update(false);
      */
      if (resource) {
        /*
        unknown error occured,
        add scrapedAt field to the current resource so it won't be scraped again, possibly ending in an infinite loop retrying again and again
        */
        await resource.update();
      }
    }

    /*
    resource is a dynamic one, successfully modified by a dynamic action: scroll, click, ..
    scrape the newly generated content by re-triggering the scrape plugins
    */
    if (
      resource
      && resource.actions
      && resource.actions.length > 0
    ) {
      const dynamicResource:Resource = (
        ({ url, depth, contentType, parent, actions }) => project.createResource({ url, depth, contentType, parent, actions })
      )(resource);
      return this.scrapeResource(project, dynamicResource);
    }

    /*
    scraping of the current resource is complete
    resource can be:
    - null (no more resources to scrap)
    - static
    - dynamic with no more dynamic actions available
    */
    return resource;
  }

  async executePlugin(project: Project, resource: Resource, plugin: Plugin):Promise<void | Partial<Resource>> {
    this.logger.debug(
      'Executing plugin %s using options %o , against resource %o',
      plugin.constructor.name, plugin.opts, resource,
    );

    if (plugin.opts && (plugin.opts.domRead || plugin.opts.domWrite)) {
      return this.executePluginInDom(project, resource, plugin);
    }

    // test if plugin is aplicable
    const isApplicable = await plugin.test(project, resource);
    if (isApplicable) {
      return plugin.apply(project, resource, this.browserClient);
    }

    return null;
  }

  /*
  async run the plugin in DOM
  use a block declaration in order not to polute the global namespace
  avoiding conflicts, thus redeclaration errors
  */
  async executePluginInDom(project: Project, resource: Resource, plugin: Plugin):Promise<void | Partial<Resource>> {
    // plugins running in DOM assume a valid resource has already been fetched
    if (!resource) return null;

    const pluginClsName = plugin.constructor.name;
    const pluginInstanceName = `inst${pluginClsName}`;
    const pluginCode = PluginStore.get(pluginClsName).bundle;

    this.logger.debug('injecting plugin in browser tab: %s', pluginClsName);
    const code = `
     {
       (async function() {
         try {
           // instantiate plugin instance, one time only, multiple plugin invocations will retain the previous plugin state
           if (!window.${pluginInstanceName}) {
             ${pluginCode}
             window.${pluginInstanceName} = new ${pluginClsName}(${JSON.stringify(plugin.opts)})
           }

           // execute plugin
           let result;
           const isApplicable = await window.${pluginInstanceName}.test(${JSON.stringify((await project.toJSONAsync()))}, ${JSON.stringify(resource)});
           if (isApplicable) {
             result = await window.${pluginInstanceName}.apply(${JSON.stringify(project)}, ${JSON.stringify(resource)});
           }

           return result;
         }
         catch(err) {
           return {err: JSON.stringify(err, Object.getOwnPropertyNames(err))};
         }
       })();
     }
   `;

    const result = await this.browserClient.evaluate(code);

    if (result && result.err) {
      throw Error(result.err);
    }

    return result;
  }

  async export(filepath: string, opts: ExportOptions):Promise<void> {
    let exporter: Exporter;

    if (!(opts && opts.type)) {
      this.logger.error('specify an export type');
      return;
    }

    switch (opts.type) {
      case 'csv':
        exporter = new CsvExporter(this.project, filepath, opts);
        break;
      case 'zip':
        exporter = new ZipExporter(this.project, filepath, opts);
        break;
      default:
        this.logger.error(`unsupported export type ${opts.type}`);
        return;
    }

    await exporter.export();
  }
}
