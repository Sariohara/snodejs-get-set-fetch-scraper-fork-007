import { assert } from 'chai';
import Project, { IStaticProject } from '../../../src/storage/base/Project';
import Resource, { IStaticResource } from '../../../src/storage/base/Resource';
import Storage from '../../../src/storage/base/Storage';
import ModelStorage from '../../../src/storage/ModelStorage';

export default function crudResource(storage: Storage) {
  describe(`CRUD Resource using ${storage.config.client}`, () => {
    let Resource: IStaticResource;
    let expectedResource: Resource;
    let project: Project;
    let modelStorage: ModelStorage;

    before(async () => {
      modelStorage = new ModelStorage(storage);
      await modelStorage.connect();
      const modelCombination = await modelStorage.getModels();
      Resource = modelCombination.Resource;

      // Queue and Resource are linked to a project instance, create a project to add the linkage
      project = new (<IStaticProject>modelCombination.Project)({ name: 'projA' });
      await project.save();
    });

    beforeEach(async () => {
      expectedResource = new Resource({
        url: 'urlA',
        depth: 1,
        scrapedAt: new Date(new Date().setMilliseconds(0)), // round up to seconds
      });
      expectedResource.id = await expectedResource.save();

      // saving the resources, adds the missing fields as null, add that to expected resource
      Object.assign(expectedResource, {
        data: null,
        content: null,
        status: null,
        contentType: null,
        parent: null,
        actions: null,
      });
    });

    afterEach(async () => {
      await Resource.delAll();
    });

    after(async () => {
      await project.del();
      await modelStorage.close();
    });

    it(`${storage.config.client} resource get`, async () => {
      const resourceById = await Resource.get(expectedResource.id);
      assert.deepEqual(resourceById, expectedResource);
    });

    it(`${storage.config.client} resource getPagedResources - offset, limit`, async () => {
      await Resource.delAll();
      for (let i = 1; i < 4; i += 1) {
        const resource = new Resource({ url: `urlA${i}`, content: [ [ `title${i}` ] ] });
        // eslint-disable-next-line no-await-in-loop
        await resource.save();
      }

      const page1Resources = await Resource.getPagedResources({ offset: 0, limit: 2 });
      const page1Urls = page1Resources.map(resource => resource.url);
      const page1Content = page1Resources.map(resource => resource.content);
      assert.sameMembers(page1Urls, [ 'urlA1', 'urlA2' ]);
      assert.sameDeepMembers(page1Content, [ [ [ 'title1' ] ], [ [ 'title2' ] ] ]);

      const page2Resources = await Resource.getPagedResources({ offset: 2, limit: 2 });
      const page2Urls = page2Resources.map(resource => resource.url);
      const page2Content = page2Resources.map(resource => resource.content);
      assert.sameMembers(page2Urls, [ 'urlA3' ]);
      assert.sameDeepMembers(page2Content, [ [ [ 'title3' ] ] ]);
    });

    it(`${storage.config.client} resource getPagedResources - cols, offset, limit`, async () => {
      await Resource.delAll();
      for (let i = 1; i < 4; i += 1) {
        const resource = new Resource({ url: `urlA${i}`, content: [ [ `title${i}` ] ] });
        // eslint-disable-next-line no-await-in-loop
        await resource.save();
      }

      const page1Resources = await Resource.getPagedResources({ offset: 0, limit: 2, cols: [ 'url' ] });
      const page1Urls = page1Resources.map(resource => resource.url);
      const page1Content = page1Resources.map(resource => resource.content);
      assert.sameMembers(page1Urls, [ 'urlA1', 'urlA2' ]);
      assert.sameDeepMembers(page1Content, [ undefined, undefined ]);

      const page2Resources = await Resource.getPagedResources({ offset: 2, limit: 2, cols: [ 'url' ] });
      const page2Urls = page2Resources.map(resource => resource.url);
      const page2Content = page2Resources.map(resource => resource.content);
      assert.sameMembers(page2Urls, [ 'urlA3' ]);
      assert.sameDeepMembers(page2Content, [ undefined ]);
    });

    it(`${storage.config.client} resource getPagedResources - cols, whereNotNull(data, content)`, async () => {
      await Resource.delAll();
      for (let i = 1; i < 5; i += 1) {
        const resource = new Resource({ url: `urlA${i}` });
        if (i % 2 === 0) {
          resource.content = [ [ `title${i}` ] ];
        }
        else {
          const buffer = Buffer.from(`data${i}`);
          resource.data = Uint8Array.from(buffer);
        }
        // eslint-disable-next-line no-await-in-loop
        await resource.save();
      }

      const textResources = await Resource.getPagedResources({ whereNotNull: [ 'content' ], cols: [ 'url', 'content' ] });
      const page1Urls = textResources.map(resource => resource.url);
      const page1Content = textResources.map(resource => resource.content);
      assert.sameMembers(page1Urls, [ 'urlA2', 'urlA4' ]);
      assert.sameDeepMembers(page1Content, [ [ [ 'title2' ] ], [ [ 'title4' ] ] ]);

      const binaryResources = await Resource.getPagedResources({ whereNotNull: [ 'data' ], cols: [ 'url', 'data' ] });
      const page2Urls = binaryResources.map(resource => resource.url);
      const page2Content = binaryResources.map(resource => Buffer.from(resource.data).toString('utf8'));
      assert.sameMembers(page2Urls, [ 'urlA1', 'urlA3' ]);
      assert.sameDeepMembers(page2Content, [ 'data1', 'data3' ]);
    });

    it(`${storage.config.client} resource del`, async () => {
      await expectedResource.del();

      const actualResource = await Resource.get(expectedResource.id);
      assert.isUndefined(actualResource);
    });

    it(`${storage.config.client} resource delAll`, async () => {
      await Resource.delAll();
      const actualResource = await Resource.get(expectedResource.id);

      assert.isUndefined(actualResource);
    });
  });
}
