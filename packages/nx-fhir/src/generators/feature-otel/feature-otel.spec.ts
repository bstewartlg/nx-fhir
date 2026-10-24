import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';
import { readFileSync } from 'fs';
import { join } from 'path';

import { featureOtelGenerator } from './feature-otel';
import { otelFeature } from './otel';
import { FEATURES } from '../feature/registry';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const pomPath = 'test-project/pom.xml';
const yamlPath = 'test-project/src/main/resources/application.yaml';

function starterPom(hapiVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir</artifactId>
        <version>${hapiVersion}</version>
    </parent>
    <artifactId>hapi-fhir-jpaserver-starter</artifactId>
    <dependencies>
        <dependency>
            <groupId>ca.uhn.hapi.fhir</groupId>
            <artifactId>hapi-fhir-base</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function createServerTree(hapiVersion = '8.4.0'): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write(pomPath, starterPom(hapiVersion));
  tree.write(yamlPath, 'hapi:\n  fhir:\n    fhir_version: R4\n');
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

describe('feature-otel generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('forwards only defined options to runFeature', async () => {
    await featureOtelGenerator(tree, {
      project: 'server',
      dashboard: false,
      serviceName: undefined,
    });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'otel',
      project: 'server',
      options: { dashboard: false },
    });
  });

  it('is listed in the feature registry', () => {
    expect(FEATURES.some((feature) => feature.name === 'otel')).toBe(true);
  });

  it('keeps schema.json defaults aligned with collectOptions', async () => {
    const schema = JSON.parse(readFileSync(join(__dirname, 'schema.json'), 'utf-8'));

    const options = await otelFeature.collectOptions(
      tree,
      readProjectConfiguration(tree, 'server') as ServerProjectConfiguration,
      {},
    );

    expect({
      dashboard: schema.properties.dashboard.default,
      compose: schema.properties.compose.default,
      serve: schema.properties.serve.default,
    }).toEqual({ dashboard: true, compose: true, serve: true });
    expect({
      dashboard: options.dashboard,
      compose: options.compose,
      serve: options.serve,
    }).toEqual({
      dashboard: schema.properties.dashboard.default,
      compose: schema.properties.compose.default,
      serve: schema.properties.serve.default,
    });
  });
});
