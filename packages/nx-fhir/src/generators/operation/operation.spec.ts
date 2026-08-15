import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationDefinition } from 'fhir/r5';

import { operationGenerator } from './operation';
import { getClassName, getEmptyHapiOperation, getHapiOperation } from './lib';
import { OperationGeneratorSchema } from './schema';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const input = vi.hoisted(() => vi.fn());
const select = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ input, select }));

describe('operation generator', () => {
  let tree: Tree;
  const options: OperationGeneratorSchema = {
    name: 'test',
    project: 'test',
    defContent: `{
      "resourceType": "OperationDefinition",
      "name": "TestOperation",
      "code": "test-operation",
    }`,
    directory: 'com/example/providers'
  };

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('test-project/src/main/java/', '');
    addProjectConfiguration(tree, 'test', {
      root: 'test-project',
      projectType: 'application',
      packageBase: 'com.example',
      fhirVersion: 'R4'
    } as ServerProjectConfiguration);
  });

  it('should generate an operation', async () => {
    await operationGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test');
    expect(config).toBeDefined();
    expect(tree.exists('test-project/src/main/java/com/example/providers/TestOperation.java')).toBeTruthy();
  });
});

const patientEverything = {
  resourceType: 'OperationDefinition',
  id: 'patient-everything',
  url: 'http://example.org/OperationDefinition/patient-everything',
  name: 'PatientEverything',
  code: 'everything',
  resource: ['Patient'],
  system: false,
  type: true,
  instance: true,
  parameter: [
    { name: 'start', use: 'in', min: 0, max: '1', type: 'date' },
    { name: 'return', use: 'out', min: 1, max: '1', type: 'Bundle' },
  ],
};

const providerPath =
  'test-project/src/main/java/com/example/providers/PatientEverythingProvider.java';

function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write('test-project/pom.xml', '<project></project>');
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function okResponse(body: unknown) {
  return { ok: true, statusText: 'OK', text: async () => JSON.stringify(body) };
}

function expectPatientEverythingProvider(tree: Tree) {
  const content = tree.read(providerPath, 'utf-8');
  expect(content).toContain('package com.example.providers;');
  expect(content).toContain('import org.hl7.fhir.r4.model.*;');
  expect(content).toContain('import ca.uhn.fhir.rest.annotation.IdParam;');
  expect(content).toContain('import ca.uhn.fhir.rest.annotation.OperationParam;');
  expect(content).toContain('import com.example.common.BaseProvider;');
  expect(content).toContain(
    'public class PatientEverythingProvider extends BaseProvider {',
  );
  expect(content).toContain('name = "$everything"');
  expect(content).toContain('type = Patient.class');
  expect(content).toContain(
    'canonicalUrl = "http://example.org/OperationDefinition/patient-everything"',
  );
  expect(content).toContain(
    '@OperationParam(name = "start", min = 0, max = 1, type = DateType.class) DateType theStart',
  );
  expect(content).toContain('public Bundle patientEverything(');
  expect(content).toContain('@IdParam IdType theId,');
  expect(content).not.toContain('manualResponse = true');
}

describe('operation generator definition sources', () => {
  let tree: Tree;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nx-fhir-operation-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tree = createServerTree();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('generates a provider class from inline definition content', async () => {
    await operationGenerator(tree, {
      project: 'server',
      directory: 'com/example/providers',
      defContent: JSON.stringify(patientEverything),
    });

    expect(tree.exists(providerPath)).toBe(true);
    expectPatientEverythingProvider(tree);
  });

  it('generates a provider class from a definition file on disk', async () => {
    // getDefinitionFromLocation reads local paths with the real fs, not the Tree.
    const definitionPath = join(tempDir, 'patient-everything.json');
    writeFileSync(definitionPath, JSON.stringify(patientEverything), 'utf-8');

    await operationGenerator(tree, {
      project: 'server',
      directory: 'com/example/providers',
      defLocation: definitionPath,
    });

    expect(tree.exists(providerPath)).toBe(true);
    expectPatientEverythingProvider(tree);
  });

  it('fetches a definition from a json url', async () => {
    const fetchMock = vi.fn(async () => okResponse(patientEverything));
    vi.stubGlobal('fetch', fetchMock);

    await operationGenerator(tree, {
      project: 'server',
      directory: 'com/example/providers',
      defLocation: 'https://example.org/definitions/patient-everything.json',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.org/definitions/patient-everything.json',
    );
    expect(tree.exists(providerPath)).toBe(true);
  });

  it('rewrites a canonical url to the json artifact url before fetching', async () => {
    const fetchMock = vi.fn(async () => okResponse(patientEverything));
    vi.stubGlobal('fetch', fetchMock);

    await operationGenerator(tree, {
      project: 'server',
      directory: 'com/example/providers',
      defLocation: 'http://example.org/OperationDefinition/patient-everything',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.org/OperationDefinition-patient-everything.json',
    );
    expect(tree.exists(providerPath)).toBe(true);
  });

  it('throws when the definition url responds with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, statusText: 'Not Found' })),
    );

    await expect(
      operationGenerator(tree, {
        project: 'server',
        directory: 'ops',
        defLocation: 'https://example.org/missing.json',
      }),
    ).rejects.toThrow(
      'Failed to fetch definition from https://example.org/missing.json: Not Found',
    );
  });

  it('throws when the local definition file does not exist', async () => {
    const missingPath = join(tempDir, 'absent.json');

    await expect(
      operationGenerator(tree, {
        project: 'server',
        directory: 'ops',
        defLocation: missingPath,
      }),
    ).rejects.toThrow(`Local definition file does not exist: ${missingPath}`);
  });

  it('prompts for a definition location when neither content nor location is given', async () => {
    const definitionPath = join(tempDir, 'prompted.json');
    writeFileSync(definitionPath, JSON.stringify(patientEverything), 'utf-8');
    input.mockResolvedValueOnce(`  ${definitionPath}  `);

    await operationGenerator(tree, { project: 'server', directory: 'com/example/providers' });

    expect(input).toHaveBeenCalledTimes(1);
    expect(tree.exists(providerPath)).toBe(true);
  });
});

describe('operation generator naming', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('falls back to the definition code when the definition has no name', async () => {
    await operationGenerator(tree, {
      project: 'server',
      directory: 'ops',
      defContent: JSON.stringify({
        resourceType: 'OperationDefinition',
        id: 'expand-codes',
        code: 'expand-codes',
        system: true,
        type: false,
        instance: false,
      }),
    });

    const content = tree.read(
      'test-project/src/main/java/ops/ExpandCodesOperation.java',
      'utf-8',
    );
    expect(content).toContain(
      'public class ExpandCodesOperation extends BaseProvider {',
    );
    expect(content).toContain('name = "$expand-codes"');
    expect(content).toContain('public void expandCodes(');
  });

  it('falls back to the code when the definition has neither an id nor a name', async () => {
    await operationGenerator(tree, {
      project: 'server',
      directory: 'ops',
      defContent: JSON.stringify({
        resourceType: 'OperationDefinition',
        code: 'expand-codes',
        system: true,
        type: false,
        instance: false,
      }),
    });

    const content = tree.read(
      'test-project/src/main/java/ops/ExpandCodesOperation.java',
      'utf-8',
    );
    expect(content).toContain(
      'public class ExpandCodesOperation extends BaseProvider {',
    );
    expect(content).toContain('name = "$expand-codes"');
  });

  it('throws when the definition has neither a name nor a code', async () => {
    await expect(
      operationGenerator(tree, {
        project: 'server',
        directory: 'ops',
        defContent: JSON.stringify({
          resourceType: 'OperationDefinition',
          system: true,
          type: false,
          instance: false,
        }),
      }),
    ).rejects.toThrow('No name found in the OperationDefinition.');
  });

  it('throws when the definition is another resource type', async () => {
    await expect(
      operationGenerator(tree, {
        project: 'server',
        directory: 'ops',
        defContent: JSON.stringify({ resourceType: 'Patient', name: 'Nope' }),
      }),
    ).rejects.toThrow(
      'Provided definition is not a valid OperationDefinition resource.',
    );
  });

  it('throws when the definition content is not valid json', async () => {
    await expect(
      operationGenerator(tree, {
        project: 'server',
        directory: 'ops',
        defContent: '{ "resourceType": "OperationDefinition", }',
      }),
    ).rejects.toThrow(SyntaxError);
  });

  it('prompts for an operation name when no definition is available', async () => {
    input.mockResolvedValueOnce('');
    input.mockResolvedValueOnce('  reindex all  ');

    await operationGenerator(tree, { project: 'server', directory: 'ops' });

    expect(input).toHaveBeenNthCalledWith(2, {
      message: 'What name would you like to use for the operation?',
      required: true,
    });
    expect(
      tree.exists('test-project/src/main/java/ops/ReindexAllOperation.java'),
    ).toBe(true);
  });

  it('throws when the prompted operation name is blank', async () => {
    input.mockResolvedValueOnce('');
    input.mockResolvedValueOnce('   ');

    await expect(
      operationGenerator(tree, { project: 'server', directory: 'ops' }),
    ).rejects.toThrow(
      'Operation name could not be determined. Please provide a valid OperationDefinition or specify a name.',
    );
  });

  it('generates an empty stub from the given name and ignores the definition content', async () => {
    await operationGenerator(tree, {
      name: 'my custom op',
      project: 'server',
      directory: 'ops',
      defContent: JSON.stringify(patientEverything),
    });

    const content = tree.read(
      'test-project/src/main/java/ops/MyCustomOpOperation.java',
      'utf-8',
    );
    expect(content).toContain('public class MyCustomOpOperation extends BaseProvider {');
    expect(content).toContain('name = "$mycustomop"');
    expect(content).toContain('manualResponse = true');
    expect(content).toContain('public void myCustomOp(');
    expect(content).toContain('HttpServletResponse theServletResponse');
    expect(content).not.toContain('import org.hl7.fhir.r4.model.*;');
    expect(tree.exists(providerPath)).toBe(false);
  });
});

describe('operation generator placement', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('prompts for a directory defaulting to the package base providers folder', async () => {
    input.mockResolvedValueOnce('com/example/custom');

    await operationGenerator(tree, {
      project: 'server',
      defContent: JSON.stringify(patientEverything),
    });

    expect(input).toHaveBeenCalledWith({
      message:
        'Enter the path (relative from src/main/java root) where the operation should be created:',
      default: 'com/example/providers',
      required: true,
    });
    expect(
      tree.exists(
        'test-project/src/main/java/com/example/custom/PatientEverythingProvider.java',
      ),
    ).toBe(true);
  });

  it('defaults the directory prompt to providers when the project has no package base', async () => {
    addProjectConfiguration(tree, 'bare', {
      root: 'bare-project',
      projectType: 'application',
      fhirVersion: FhirVersion.R4,
    } as ServerProjectConfiguration);
    tree.write('bare-project/src/main/java/.gitkeep', '');
    input.mockResolvedValueOnce('providers');

    await operationGenerator(tree, {
      project: 'bare',
      defContent: JSON.stringify(patientEverything),
    });

    expect(input).toHaveBeenCalledWith({
      message:
        'Enter the path (relative from src/main/java root) where the operation should be created:',
      default: 'providers',
      required: true,
    });
    expect(
      tree.exists(
        'bare-project/src/main/java/providers/PatientEverythingProvider.java',
      ),
    ).toBe(true);
  });

  it('collapses redundant separators in the directory into a java package', async () => {
    await operationGenerator(tree, {
      project: 'server',
      directory: 'com//example///providers/',
      defContent: JSON.stringify(patientEverything),
    });

    expect(tree.read(providerPath, 'utf-8')).toContain(
      'package com.example.providers;',
    );
  });

  it('throws when the project has no java source directory', async () => {
    addProjectConfiguration(tree, 'no-java', {
      root: 'no-java-project',
      projectType: 'application',
      packageBase: 'com.example',
      fhirVersion: FhirVersion.R4,
    } as ServerProjectConfiguration);

    await expect(
      operationGenerator(tree, {
        project: 'no-java',
        directory: 'ops',
        defContent: JSON.stringify(patientEverything),
      }),
    ).rejects.toThrow(
      "Java source directory 'no-java-project/src/main/java' does not exist in project 'no-java'.",
    );
  });

  it('throws when the named project is not in the workspace', async () => {
    await expect(
      operationGenerator(tree, {
        project: 'missing',
        directory: 'ops',
        defContent: JSON.stringify(patientEverything),
      }),
    ).rejects.toThrow("Cannot find configuration for 'missing'");
  });

  it('uses the only server project when no project is given', async () => {
    await operationGenerator(tree, {
      directory: 'com/example/providers',
      defContent: JSON.stringify(patientEverything),
    });

    expect(select).not.toHaveBeenCalled();
    expect(tree.exists(providerPath)).toBe(true);
  });

  it('prompts to select a server project when the workspace has several', async () => {
    addProjectConfiguration(tree, 'second', {
      root: 'second-project',
      projectType: 'application',
      packageBase: 'com.second',
      fhirVersion: FhirVersion.R4,
    } as ServerProjectConfiguration);
    tree.write('second-project/src/main/java/.gitkeep', '');
    tree.write('second-project/pom.xml', '<project></project>');
    select.mockResolvedValueOnce('second');

    await operationGenerator(tree, {
      directory: 'com/second/providers',
      defContent: JSON.stringify(patientEverything),
    });

    expect(select).toHaveBeenCalledWith({
      message: 'Select a server project to add the operation to:',
      choices: ['server', 'second'],
    });
    expect(
      tree.exists(
        'second-project/src/main/java/com/second/providers/PatientEverythingProvider.java',
      ),
    ).toBe(true);
  });
});

describe('getClassName', () => {
  it('appends Operation when no resource types are bound', () => {
    expect(getClassName('patient-everything')).toBe('PatientEverythingOperation');
    expect(getClassName('patient-everything', [])).toBe(
      'PatientEverythingOperation',
    );
  });

  it('appends Provider when resource types are bound', () => {
    expect(getClassName('patient-everything', ['Patient'])).toBe(
      'PatientEverythingProvider',
    );
  });
});

describe('getEmptyHapiOperation', () => {
  it('builds a system level stub from a name alone', () => {
    expect(getEmptyHapiOperation('Reindex All', 'com.example.providers')).toEqual({
      id: 'Reindex All',
      url: '',
      name: 'Reindex All',
      code: 'reindex-all',
      resource: [],
      system: true,
      type: false,
      instance: false,
      resourceDataTypes: [],
      className: 'ReindexAllOperation',
      targetPackage: 'com.example.providers',
      methodName: 'reindexAll',
      inputParameters: [],
      outputType: undefined,
    });
  });
});

describe('getHapiOperation', () => {
  it('maps a full definition onto the HAPI operation model', () => {
    const operation = getHapiOperation(
      patientEverything as OperationDefinition,
      'com.example.providers',
      FhirVersion.R4,
    );

    expect(operation).toMatchObject({
      id: 'patient-everything',
      url: 'http://example.org/OperationDefinition/patient-everything',
      name: 'PatientEverything',
      code: 'everything',
      resource: ['Patient'],
      system: false,
      type: true,
      instance: true,
      resourceDataTypes: ['Patient'],
      className: 'PatientEverythingProvider',
      targetPackage: 'com.example.providers',
      methodName: 'patientEverything',
      modelPackageVersion: 'r4',
    });
    expect(operation.inputParameters).toEqual([
      {
        name: 'start',
        use: 'in',
        min: 0,
        max: '1',
        type: 'date',
        dataType: 'DateType',
        methodParameterName: 'theStart',
      },
    ]);
    expect(operation.outputType).toEqual({
      name: 'return',
      use: 'out',
      min: 1,
      max: '1',
      type: 'Bundle',
      dataType: 'Bundle',
    });
  });

  it('falls back to the name for the id, code and empty url', () => {
    const operation = getHapiOperation(
      {
        resourceType: 'OperationDefinition',
        name: 'Validate Thing',
      } as OperationDefinition,
      'ops',
      FhirVersion.R5,
    );

    expect(operation).toMatchObject({
      id: 'Validate Thing',
      url: '',
      code: 'validate-thing',
      resource: [],
      className: 'ValidateThingOperation',
      methodName: 'validateThing',
      modelPackageVersion: 'r5',
      inputParameters: [],
      outputType: undefined,
    });
    expect(operation.resourceDataTypes).toBeUndefined();
  });

  it('maps untyped parameters and Resource types to IAnyResource', () => {
    const operation = getHapiOperation(
      {
        resourceType: 'OperationDefinition',
        name: 'Submit',
        code: 'submit',
        resource: ['Resource'],
        parameter: [
          { name: 'payload', use: 'in', min: 1, max: '*' },
          { name: 'outcome', use: 'out', min: 0, max: '1' },
        ],
      } as OperationDefinition,
      'ops',
      FhirVersion.STU3,
    );

    expect(operation.resourceDataTypes).toEqual(['IAnyResource']);
    expect(operation.inputParameters[0]).toMatchObject({
      dataType: 'IAnyResource',
      methodParameterName: 'thePayload',
    });
    expect(operation.outputType).toMatchObject({ dataType: 'IAnyResource' });
  });

  it('reduces primitive output types to void', () => {
    const operation = getHapiOperation(
      {
        resourceType: 'OperationDefinition',
        name: 'Ping',
        code: 'ping',
        parameter: [{ name: 'message', use: 'out', min: 0, max: '1', type: 'string' }],
      } as OperationDefinition,
      'ops',
      FhirVersion.R4B,
    );

    expect(operation.outputType).toMatchObject({ dataType: 'void' });
    expect(operation.modelPackageVersion).toBe('r4b');
  });
});
