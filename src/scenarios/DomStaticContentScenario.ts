import { IScenario } from './scenarios';

const scenario:IScenario = {
  defaultPluginOpts: [
    {
      name: 'SelectResourcePlugin',
    },
    {
      name: 'NodeFetchPlugin',
    },
    {
      name: 'ExtractUrlsPlugin',
      domRead: false,
    },
    {
      name: 'ExtractHtmlContentPlugin',
      domRead: false,
    },
    {
      name: 'InsertResourcesPlugin',
    },
    {
      name: 'UpsertResourcePlugin',
    },
  ],

};

export default scenario;