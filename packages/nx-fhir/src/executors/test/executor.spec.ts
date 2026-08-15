import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext } from '@nx/devkit';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  fatal: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock('@nx/devkit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logger,
}));

vi.mock('fs');
vi.mock('child_process');

import executor from './executor';

const projectPath = join('/workspace', 'apps/test-project');

function existsOnly(fileName: string) {
  return (candidate: fs.PathLike) => candidate.toString().endsWith(fileName);
}

describe('Test Executor', () => {
  let context: ExecutorContext;

  beforeEach(() => {
    vi.resetAllMocks();

    context = {
      root: '/workspace',
      projectName: 'test-project',
      projectsConfigurations: {
        version: 2,
        projects: {
          'test-project': {
            root: 'apps/test-project',
          },
        },
      },
      cwd: '/workspace',
      isVerbose: false,
      nxJsonConfiguration: {},
      projectGraph: {
        nodes: {},
        dependencies: {},
      },
    };
  });

  describe('project resolution', () => {
    it('should fail when the project configuration is missing', async () => {
      const result = await executor(
        {},
        { ...context, projectName: 'unknown-project' },
      );

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('unknown-project'),
      );
    });

    it('should fail when the executor runs without a project name', async () => {
      const result = await executor({}, { ...context, projectName: undefined });

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
    });

    it('should fail when neither pom.xml nor package.json is present', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Unknown project type for test-project'),
      );
    });
  });

  describe('server projects', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));
    });

    it('should run Maven tests in the project directory', async () => {
      const result = await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith('mvn test', {
        cwd: projectPath,
        stdio: 'inherit',
      });
      expect(result).toEqual({ success: true });
    });

    it('should add the JaCoCo report goal for coverage', async () => {
      await executor({ coverage: true }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test jacoco:report',
        expect.any(Object),
      );
    });

    it('should limit Maven to a single test class', async () => {
      await executor({ testFile: 'PatientProviderTest' }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test -Dtest=PatientProviderTest',
        expect.any(Object),
      );
    });

    it('should combine coverage and test file options', async () => {
      await executor(
        { coverage: true, testFile: 'PatientProviderTest' },
        context,
      );

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test jacoco:report -Dtest=PatientProviderTest',
        expect.any(Object),
      );
    });

    it('should take precedence when package.json is also present', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test',
        expect.any(Object),
      );
    });

    it('should fail when Maven exits with a non-zero code', async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error('Command failed: mvn test');
      });

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Maven tests failed'),
      );
    });
  });

  describe('testFile validation', () => {
    it('should reject a testFile containing shell metacharacters', async () => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));

      const result = await executor(
        { testFile: 'PatientTest; rm -rf /' },
        context,
      );

      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid testFile'),
      );
      expect(result).toEqual({ success: false });
    });

    it('should reject command substitution in a frontend testFile', async () => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('package.json'));

      const result = await executor({ testFile: '$(touch pwned)' }, context);

      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false });
    });

    it('should accept Maven patterns, method filters, and paths', async () => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));

      await executor({ testFile: 'Patient*Test#create,ca/uhn/FooTest' }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test -Dtest=Patient*Test#create,ca/uhn/FooTest',
        expect.any(Object),
      );
    });

    it('should accept Maven exclusions and drive-letter paths', async () => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));

      await executor({ testFile: '!FlakyTest,C:/work/server/FooTest' }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn test -Dtest=!FlakyTest,C:/work/server/FooTest',
        expect.any(Object),
      );
    });

    it.runIf(process.platform !== 'win32')(
      'should reject a backslash where sh would strip it',
      async () => {
        vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));

        const result = await executor(
          { testFile: 'C:\\work\\server\\FooTest' },
          context,
        );

        expect(child_process.execSync).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false });
      },
    );

    it('should reject selectors the shell would expand', async () => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));

      for (const testFile of [
        'Outer$Inner',
        '%regex[.*Test]',
        'FooTest, BarTest',
      ]) {
        const result = await executor({ testFile }, context);

        expect(result).toEqual({ success: false });
      }
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid testFile'),
      );
    });

    it.runIf(process.platform !== 'win32')(
      'should assemble a command whose selector survives real shell parsing',
      async (ctx) => {
        vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));
        const selector =
          'Patient*Test#create,ca/uhn/FooTest,!FlakyTest,C:/work/FooTest,a+b.java?';

        await executor({ testFile: selector }, context);

        const [assembled] = vi.mocked(child_process.execSync).mock.calls[0];

        const { execSync: realExecSync } = await vi.importActual<
          typeof import('child_process')
        >('child_process');
        const { mkdtempSync } = await vi.importActual<typeof import('fs')>(
          'fs',
        );
        const { tmpdir } = await vi.importActual<typeof import('os')>('os');

        try {
          realExecSync('true');
        } catch {
          // The environment forbids spawning a shell, so the round-trip
          // cannot be observed here; the command assembly is still asserted
          // by the mocked tests above.
          ctx.skip();
        }

        // An empty directory keeps the glob characters * and ? from matching
        // a file, mirroring a server project where no file matches the
        // selector literally.
        const emptyDir = mkdtempSync(join(tmpdir(), 'nx-fhir-shell-'));

        // Rerun the exact assembled command with mvn replaced by an argv
        // echo, so the assertion covers what the shell hands to Maven.
        const observed = realExecSync(
          String(assembled).replace(/^mvn /, "printf '%s\\n' "),
          { cwd: emptyDir },
        )
          .toString()
          .trimEnd()
          .split('\n');

        expect(observed).toEqual(['test', `-Dtest=${selector}`]);
      },
    );
  });

  describe('frontend projects', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('package.json'));
      // Pin the package manager so the assembled commands do not depend on
      // what detectPackageManager finds in this repository.
      process.env.PACKAGE_MANAGER = 'npm';
    });

    afterEach(() => {
      delete process.env.PACKAGE_MANAGER;
    });

    it('should run the npm test script in the project directory', async () => {
      const result = await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith('npm run test', {
        cwd: projectPath,
        stdio: 'inherit',
      });
      expect(result).toEqual({ success: true });
    });

    it('should run the bun test script without an argument separator', async () => {
      process.env.PACKAGE_MANAGER = 'bun';

      await executor({ coverage: true, testFile: 'src/app.spec.ts' }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'bun run test --coverage src/app.spec.ts',
        expect.any(Object),
      );
    });

    it('should pass the watch flag through to Vitest', async () => {
      await executor({ watch: true }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run test -- --watch',
        expect.any(Object),
      );
    });

    it('should pass the coverage flag through to Vitest', async () => {
      await executor({ coverage: true }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run test -- --coverage',
        expect.any(Object),
      );
    });

    it('should reject an option-shaped testFile that would reach Vitest as a flag', async () => {
      const result = await executor({ testFile: '--help' }, context);

      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false });
    });

    it('should pass a single test file through to Vitest', async () => {
      await executor({ testFile: 'src/app.spec.ts' }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run test -- src/app.spec.ts',
        expect.any(Object),
      );
    });

    it('should forward every option after a single separator', async () => {
      await executor(
        { watch: true, coverage: true, testFile: 'src/app.spec.ts' },
        context,
      );

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run test -- --watch --coverage src/app.spec.ts',
        expect.any(Object),
      );
    });

    it('should fail when the test command exits with a non-zero code', async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error('Command failed: npm run test');
      });

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Frontend tests failed'),
      );
    });
  });
});
