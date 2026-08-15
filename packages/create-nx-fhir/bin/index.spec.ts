import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createRequire } from 'node:module';
import {
  CURRENT_DIR_SENTINEL,
  initExistingDirectory,
  isPackageManagerAvailable,
  stageAnalyticsPreference,
  resolveDirectory,
  resolvePackageManager,
  sanitizeDirectory,
  SUPPORTED_PACKAGE_MANAGERS,
} from './index';
import type { CliArgs, PackageManager } from './index';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

vi.mock('create-nx-workspace', () => ({
  createWorkspace: vi.fn(),
}));

vi.mock('@nx/devkit', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockExecSync, mockExistsSync, mockWriteFileSync, mockReadFileSync } =
  vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockExistsSync: vi.fn(() => false),
    mockWriteFileSync: vi.fn(),
    mockReadFileSync: vi.fn(() => '{}'),
  }));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  default: { execSync: mockExecSync },
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  default: {
    existsSync: mockExistsSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
  },
}));

const { version: PACKAGE_VERSION } = createRequire(import.meta.url)(
  '../package.json',
) as { version: string };


describe('create-nx-fhir CLI utilities', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  describe('sanitizeDirectory', () => {
    it('should convert to lowercase', () => {
      expect(sanitizeDirectory('MyWorkspace')).toBe('myworkspace');
      expect(sanitizeDirectory('TEST-WORKSPACE')).toBe('test-workspace');
    });

    it('should replace spaces with dashes', () => {
      expect(sanitizeDirectory('my new workspace')).toBe('my-new-workspace');
      expect(sanitizeDirectory('test   workspace')).toBe('test-workspace');
    });

    it('should replace special characters with dashes', () => {
      expect(sanitizeDirectory('my@workspace')).toBe('my-workspace');
      expect(sanitizeDirectory('test!workspace#')).toBe('test-workspace');
      expect(sanitizeDirectory('work_space')).toBe('work-space');
    });

    it('should collapse multiple dashes into one', () => {
      expect(sanitizeDirectory('my---workspace')).toBe('my-workspace');
      expect(sanitizeDirectory('test--workspace')).toBe('test-workspace');
    });

    it('should remove leading and trailing dashes', () => {
      expect(sanitizeDirectory('---my-workspace---')).toBe('my-workspace');
      expect(sanitizeDirectory('-test-')).toBe('test');
    });

    it('should trim whitespace', () => {
      expect(sanitizeDirectory('  my-workspace  ')).toBe('my-workspace');
      expect(sanitizeDirectory('\ntest\n')).toBe('test');
    });

    it('should handle complex combinations', () => {
      expect(sanitizeDirectory('  My New Workspace!@#  ')).toBe(
        'my-new-workspace',
      );
      expect(sanitizeDirectory('TEST___WORKSPACE')).toBe('test-workspace');
    });

    it('should preserve valid alphanumeric characters and dashes', () => {
      expect(sanitizeDirectory('test-workspace-123')).toBe(
        'test-workspace-123',
      );
      expect(sanitizeDirectory('my-cool-app-v2')).toBe('my-cool-app-v2');
    });

    it('should handle empty strings after sanitization', () => {
      expect(sanitizeDirectory('   ')).toBe('');
      expect(sanitizeDirectory('---')).toBe('');
      expect(sanitizeDirectory('@@@')).toBe('');
    });

    it('should handle strings with only numbers', () => {
      expect(sanitizeDirectory('123')).toBe('123');
      expect(sanitizeDirectory('123-456')).toBe('123-456');
    });

    it('should handle unicode characters by removing non-ASCII', () => {
      expect(sanitizeDirectory('café')).toBe('caf');
      expect(sanitizeDirectory('über-app')).toBe('ber-app');
    });
  });

  describe('resolveDirectory', () => {
    it('should use directory option when provided', async () => {
      const args: CliArgs = { directory: 'my-workspace' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-workspace');
    });

    it('should sanitize directory option', async () => {
      const args: CliArgs = { directory: 'My Workspace!' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-workspace');
    });

    it('should use positional argument when provided', async () => {
      const args: CliArgs = { _: ['test-workspace'] };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace');
    });

    it('should sanitize positional argument', async () => {
      const args: CliArgs = { _: ['Test Workspace!'] };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace');
    });

    it('should prefer directory option over positional argument', async () => {
      const args: CliArgs = {
        directory: 'option-workspace',
        _: ['positional-workspace'],
      };
      const result = await resolveDirectory(args);
      expect(result).toBe('option-workspace');
    });

    it('should prompt when no directory or positional arg provided', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('prompted-workspace');

      const args: CliArgs = {};
      const result = await resolveDirectory(args);

      expect(result).toBe('prompted-workspace');
      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Workspace directory (enter "." to use the current directory):',
          validate: expect.any(Function),
        }),
      );
    });

    it('should prompt when positional argument is not a string', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('prompted-workspace');

      const args: CliArgs = { _: [123] };
      const result = await resolveDirectory(args);

      expect(result).toBe('prompted-workspace');
    });

    it('should validate directory starts with a letter', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('workspace');

      const args: CliArgs = {};
      await resolveDirectory(args);

      const validateFn = vi.mocked(input).mock.calls[0][0].validate;
      if (!validateFn) {
        throw new Error('Expected input prompt to define a validate function.');
      }

      expect(validateFn('123-workspace')).toBe(
        'Directory must start with a letter and contain only lowercase letters, numbers and dashes.',
      );
      expect(validateFn('workspace-123')).toBe(true);
      expect(validateFn('a-123')).toBe(true);
    });

    it('should validate directory is not empty after sanitization', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('workspace');

      const args: CliArgs = {};
      await resolveDirectory(args);

      const validateFn = vi.mocked(input).mock.calls[0][0].validate;
      if (!validateFn) {
        throw new Error('Expected input prompt to define a validate function.');
      }

      expect(validateFn('   ')).toBe(
        'Please enter a valid directory (alphanumeric and dashes).',
      );
      expect(validateFn('---')).toBe(
        'Please enter a valid directory (alphanumeric and dashes).',
      );
      expect(validateFn('workspace')).toBe(true);
    });

    it('should handle complex directory names', async () => {
      const args: CliArgs = { directory: '  My Super Cool Workspace v2!  ' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-super-cool-workspace-v2');
    });

    it('should handle directory with multiple special characters', async () => {
      const args: CliArgs = { directory: 'test@#$%workspace^&*()123' };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace-123');
    });
  });

  describe('isPackageManagerAvailable', () => {
    afterEach(() => {
      mockExecSync.mockReset();
    });

    it('should return true for supported package manager', () => {
      SUPPORTED_PACKAGE_MANAGERS.forEach((pm) => {
        expect(isPackageManagerAvailable(pm)).toBe(true);
      });
    });

    it('should return false for unsupported package manager', () => {
      expect(
        isPackageManagerAvailable('nonexistent-pm' as PackageManager),
      ).toBe(false);
    });

    it('should not run the version check for an unsupported package manager', () => {
      isPackageManagerAvailable('yarn' as PackageManager);

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('should return false when the version check fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      expect(isPackageManagerAvailable('bun')).toBe(false);
      expect(mockExecSync).toHaveBeenCalledWith('bun --version', {
        stdio: 'ignore',
      });
    });
  });

  describe('resolveDirectory -- current directory support', () => {
    it('should return "." when directory option is "."', async () => {
      const args: CliArgs = { directory: '.' };
      const result = await resolveDirectory(args);
      expect(result).toBe(CURRENT_DIR_SENTINEL);
    });

    it('should return "." when positional argument is "."', async () => {
      const args: CliArgs = { _: ['.'] };
      const result = await resolveDirectory(args);
      expect(result).toBe(CURRENT_DIR_SENTINEL);
    });

    it('should return "." when directory option is "." with whitespace', async () => {
      const args: CliArgs = { directory: ' . ' };
      const result = await resolveDirectory(args);
      expect(result).toBe(CURRENT_DIR_SENTINEL);
    });

    it('should accept "." during prompt validation', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('workspace');

      await resolveDirectory({});

      const validateFn = vi.mocked(input).mock.calls[0][0].validate;
      if (!validateFn) {
        throw new Error('Expected input prompt to define a validate function.');
      }

      expect(validateFn('.')).toBe(true);
      expect(validateFn(' . ')).toBe(true);
    });

    it('should return "." when prompted with "."', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('.');
      const args: CliArgs = {};
      const result = await resolveDirectory(args);
      expect(result).toBe(CURRENT_DIR_SENTINEL);
    });
  });

  describe('initExistingDirectory', () => {
    it('should create package.json when missing', async () => {
      mockExistsSync.mockReturnValue(false);

      await initExistingDirectory('npm', '1.0.0', {});

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.stringContaining('"version": "0.0.0"'),
      );
    });

    it('should create nx.json when missing', async () => {
      mockExistsSync.mockReturnValue(false);

      await initExistingDirectory('npm', '1.0.0', {});

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('nx.json'),
        expect.stringContaining('"plugins": []'),
      );
    });

    it('should preserve existing package.json', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', {});

      expect(mockWriteFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining('package.json'),
        expect.anything(),
      );
    });

    it('should run npm install with correct packages', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.2.3', {});

      expect(mockExecSync).toHaveBeenCalledWith(
        'npm install --save-dev nx @nx/devkit nx-fhir@1.2.3',
        expect.objectContaining({ stdio: 'inherit' }),
      );
    });

    it('should run bun add with correct packages', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('bun', '1.2.3', {});

      expect(mockExecSync).toHaveBeenCalledWith(
        'bun add --dev nx @nx/devkit nx-fhir@1.2.3',
        expect.objectContaining({ stdio: 'inherit' }),
      );
    });

    it('should run preset generator with options as flags', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', {
        server: true,
        serverDirectory: 'backend',
        packageBase: 'com.org.fhir',
        fhirVersion: 'R4',
      });

      // Second execSync call is the generator
      const generatorCall = mockExecSync.mock.calls[1];
      expect(generatorCall[0]).toContain('npx nx g nx-fhir:preset');
      expect(generatorCall[0]).toContain('--server=true');
      expect(generatorCall[0]).toContain('--serverDirectory=backend');
      expect(generatorCall[0]).toContain('--packageBase=com.org.fhir');
      expect(generatorCall[0]).toContain('--fhirVersion=R4');
    });

    it('should pass the release option as a flag', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', { release: '8.10.0-3' });

      expect(mockExecSync.mock.calls[1][0]).toContain('--release=8.10.0-3');
    });

    it('should pass server=false as a flag', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', { server: false });

      expect(mockExecSync.mock.calls[1][0]).toContain('--server=false');
    });

    it('should run the generator without flags when no options are given', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', {});

      expect(mockExecSync.mock.calls[1][0]).toBe('npx nx g nx-fhir:preset');
    });

    it('should record the analytics preference before running the generator', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{"plugins": []}');

      await initExistingDirectory('npm', '1.0.0', {});

      const [nxJsonPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(nxJsonPath).toContain('nx.json');
      expect(JSON.parse(contents).analytics).toBe(false);
      expect(mockWriteFileSync.mock.invocationCallOrder[0]).toBeLessThan(
        mockExecSync.mock.invocationCallOrder[1],
      );
    });

    it('should run both commands in the current working directory', async () => {
      mockExistsSync.mockReturnValue(true);

      await initExistingDirectory('npm', '1.0.0', {});

      for (const call of mockExecSync.mock.calls) {
        expect(call[1]).toEqual({ stdio: 'inherit', cwd: process.cwd() });
      }
    });
  });

  describe('stageAnalyticsPreference', () => {
    it('should record the preference when nx.json does not carry one', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{"plugins": []}');

      stageAnalyticsPreference('/workspace');

      const [nxJsonPath, contents] = mockWriteFileSync.mock.calls[0];
      expect(nxJsonPath).toContain('nx.json');
      expect(JSON.parse(contents)).toEqual({ plugins: [], analytics: false });
    });

    it('should keep a preference the workspace already recorded', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{"analytics": true}');

      stageAnalyticsPreference('/workspace');

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('should do nothing without an nx.json', () => {
      mockExistsSync.mockReturnValue(false);

      stageAnalyticsPreference('/workspace');

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('resolvePackageManager', () => {
    afterEach(() => {
      mockExecSync.mockReset();
    });

    it('should return requested package manager if available', () => {
      SUPPORTED_PACKAGE_MANAGERS.forEach((pm) => {
        const result = resolvePackageManager(pm);
        expect(result).toBe(pm);
      });
    });

    it('should default to bun if no requested package manager provided and bun is available', () => {
      const result = resolvePackageManager();
      expect(result).toBe('bun');
    });

    it('should return first available supported package manager if requested is not available', () => {
      const result = resolvePackageManager('nonexistent-pm' as PackageManager);
      expect(SUPPORTED_PACKAGE_MANAGERS).toContain(result);
    });

    it('should warn and fall back to npm when the requested manager is unavailable', async () => {
      const { logger } = await import('@nx/devkit');
      mockExecSync.mockImplementation((command: string) => {
        if (command.startsWith('bun')) {
          throw new Error('command not found');
        }
        return '';
      });

      expect(resolvePackageManager('bun')).toBe('npm');
      expect(logger.warn).toHaveBeenCalledWith(
        "Package manager 'bun' is not available. Falling back to 'npm'.",
      );
    });

    it('should exit when neither the requested manager nor npm is available', async () => {
      const { logger } = await import('@nx/devkit');
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      resolvePackageManager('bun');

      expect(logger.error).toHaveBeenCalledWith(
        'npm is not available. Please install npm to continue.',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });
});

describe('create-nx-fhir CLI entrypoint', () => {
  const originalArgv = process.argv;
  const originalNodeEnv = process.env.NODE_ENV;
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    process.env.NODE_ENV = 'development';
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env.NODE_ENV = originalNodeEnv;
    exitSpy.mockRestore();
    vi.resetModules();
  });

  async function loadMocks() {
    const { createWorkspace } = await import('create-nx-workspace');
    const { logger } = await import('@nx/devkit');
    return { createWorkspace: vi.mocked(createWorkspace), logger };
  }

  // Importing the module runs the CLI because NODE_ENV is no longer 'test'
  async function runCli(args: string[]) {
    process.argv = ['node', 'create-nx-fhir', ...args];
    await import('./index');
  }

  it('should create a workspace with the resolved directory and preset version', async () => {
    const { createWorkspace, logger } = await loadMocks();
    createWorkspace.mockResolvedValue({
      directory: 'my-app',
    } as Awaited<ReturnType<typeof createWorkspace>>);

    await runCli(['My App']);
    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

    expect(createWorkspace).toHaveBeenCalledWith(
      `nx-fhir@${PACKAGE_VERSION}`,
      expect.objectContaining({
        name: 'my-app',
        nxCloud: 'skip',
        packageManager: 'bun',
        interactive: false,
        analytics: false,
        server: undefined,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Successfully created the workspace here: my-app.',
    );
  });

  it('should forward every preset option to the workspace creation', async () => {
    const { createWorkspace } = await loadMocks();
    createWorkspace.mockResolvedValue({
      directory: 'fhir-app',
    } as Awaited<ReturnType<typeof createWorkspace>>);

    await runCli([
      'fhir-app',
      '--packageManager=npm',
      '--server',
      '--serverDirectory=backend',
      '--packageBase=com.org.fhir',
      '--release=8.10.0-3',
      '--fhirVersion=R4B',
    ]);
    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

    expect(createWorkspace).toHaveBeenCalledWith(
      `nx-fhir@${PACKAGE_VERSION}`,
      expect.objectContaining({
        name: 'fhir-app',
        packageManager: 'npm',
        server: true,
        serverDirectory: 'backend',
        packageBase: 'com.org.fhir',
        release: '8.10.0-3',
        fhirVersion: 'R4B',
      }),
    );
  });

  it('should omit preset options that were not provided', async () => {
    const { createWorkspace } = await loadMocks();
    createWorkspace.mockResolvedValue({
      directory: 'bare-app',
    } as Awaited<ReturnType<typeof createWorkspace>>);

    await runCli(['bare-app']);
    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

    const options = createWorkspace.mock.calls[0][1];
    expect(options).not.toHaveProperty('serverDirectory');
    expect(options).not.toHaveProperty('packageBase');
    expect(options).not.toHaveProperty('release');
    expect(options).not.toHaveProperty('fhirVersion');
  });

  it('should initialize the current directory instead of creating a workspace', async () => {
    const { createWorkspace, logger } = await loadMocks();
    mockExistsSync.mockReturnValue(true);

    await runCli(['.', '--server=false', '--release=8.10.0-3']);
    await vi.waitFor(() => expect(mockExecSync).toHaveBeenCalledTimes(3));

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalledWith(
      `bun add --dev nx @nx/devkit nx-fhir@${PACKAGE_VERSION}`,
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      'npx nx g nx-fhir:preset --server=false --release=8.10.0-3',
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Successfully initialized nx-fhir in the current directory.',
    );
  });

  it('should prompt for the directory when no name is given', async () => {
    const { createWorkspace } = await loadMocks();
    const { input } = await import('@inquirer/prompts');
    vi.mocked(input).mockResolvedValue('prompted-app');
    createWorkspace.mockResolvedValue({
      directory: 'prompted-app',
    } as Awaited<ReturnType<typeof createWorkspace>>);

    await runCli([]);
    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalled());

    expect(createWorkspace).toHaveBeenCalledWith(
      `nx-fhir@${PACKAGE_VERSION}`,
      expect.objectContaining({ name: 'prompted-app' }),
    );
  });

  it('should log the error message and exit when workspace creation fails', async () => {
    const { createWorkspace, logger } = await loadMocks();
    createWorkspace.mockRejectedValue(new Error('workspace creation failed'));

    await runCli(['broken-app']);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(logger.error).toHaveBeenCalledWith('workspace creation failed');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should log a thrown value that carries no message', async () => {
    const { createWorkspace, logger } = await loadMocks();
    createWorkspace.mockRejectedValue('plain failure');

    await runCli(['broken-app']);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(logger.error).toHaveBeenCalledWith('plain failure');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should log the thrown object when its message is undefined', async () => {
    const { createWorkspace, logger } = await loadMocks();
    const failure = { message: undefined };
    createWorkspace.mockRejectedValue(failure);

    await runCli(['broken-app']);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(logger.error).toHaveBeenCalledWith(failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should not run the CLI when NODE_ENV is test', async () => {
    const { createWorkspace } = await loadMocks();
    process.env.NODE_ENV = 'test';

    await runCli(['skipped-app']);

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
