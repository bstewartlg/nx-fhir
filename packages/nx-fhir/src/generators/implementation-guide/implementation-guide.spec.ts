import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';

import { ImplementationGuideGeneratorSchema } from './schema';
import { implementationGuideGenerator } from './implementation-guide';
import { ServerProjectConfiguration } from '../../shared/models';
import { Document, parseDocument } from 'yaml';

describe('implementation-guide generator', () => {
  let tree: Tree;
  const options: ImplementationGuideGeneratorSchema = { 
    project: 'test',
    id: 'example.fhir.implementationguide',
    igVersion: '1.0.0',
    install: true,
    skipOps: true
  };

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('test-project/src/main/java/', '');
    addProjectConfiguration(tree, 'test', {
      root: 'test-project',
      projectType: 'application',
      packageBase: 'com.example',
      fhirVersion: 'R4',
    } as ServerProjectConfiguration);

    const doc = new Document({
      hapi: {
        fhir: {
          implementationguides: {
            'initialguide': {
              name: 'some.initial.guide',
              version: '1.0.0',
              install: 'STORE_ONLY',
            },
          },
        },
      },
    });
    tree.write('test-project/src/main/resources/application.yaml', doc.toString());
  });

  it('should generate basic IG configuration', async () => {
    const projectConfig = readProjectConfiguration(tree, 'test');
    expect(projectConfig).toBeDefined();

    const serverConfigBefore = parseDocument(tree.read('test-project/src/main/resources/application.yaml', 'utf-8') || '');
    const igPackagesBefore = serverConfigBefore.toJSON().hapi.fhir.implementationguides;
    expect(igPackagesBefore).toBeDefined();
    expect(igPackagesBefore['initialguide']).toBeDefined();
    expect(igPackagesBefore['initialguide'].name).toBe('some.initial.guide');
    expect(igPackagesBefore['initialguide'].version).toBe('1.0.0');
    expect(igPackagesBefore['initialguide'].install).toBe('STORE_ONLY');
    expect(Object.keys(igPackagesBefore)).toHaveLength(1);



    await implementationGuideGenerator(tree, options);
    const serverConfigAfter = parseDocument(tree.read('test-project/src/main/resources/application.yaml', 'utf-8') || '');
    console.log('IG Package Section:', serverConfigAfter.toJSON().hapi.fhir.implementationguides);
    const igPackagesAfter = serverConfigAfter.toJSON().hapi.fhir.implementationguides;

    expect(igPackagesAfter).toBeDefined();
    expect(igPackagesAfter['examplefhirimplementationguide']).toBeDefined();
    expect(igPackagesAfter['examplefhirimplementationguide'].name).toBe('example.fhir.implementationguide');
    expect(igPackagesAfter['examplefhirimplementationguide'].version).toBe('1.0.0');
    expect(igPackagesAfter['examplefhirimplementationguide'].installMode).toBe('STORE_AND_INSTALL');
    expect(Object.keys(igPackagesAfter)).toHaveLength(2);

  });
});
