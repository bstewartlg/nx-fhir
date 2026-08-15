import { ExecutorContext, logger } from '@nx/devkit';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { TestExecutorSchema } from './schema';
import {
  getPackageManager,
  getRunCommand,
} from '../../shared/utils/package-manager';

export default async function testExecutor(
  options: TestExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectConfig = context.projectName
    ? context.projectsConfigurations?.projects[context.projectName]
    : undefined;
  
  if (!projectConfig) {
    logger.error(`Could not find project configuration for ${context.projectName}`);
    return { success: false };
  }

  const projectRoot = projectConfig.root;
  const workspaceRoot = context.root;
  const fullProjectPath = join(workspaceRoot, projectRoot);

  // Detect project type
  const pomXmlPath = join(fullProjectPath, 'pom.xml');
  const packageJsonPath = join(fullProjectPath, 'package.json');
  
  const isServer = existsSync(pomXmlPath);
  const isFrontend = existsSync(packageJsonPath);

  if (!isServer && !isFrontend) {
    logger.error(
      `Unknown project type for ${context.projectName}. Expected pom.xml (server) or package.json (frontend) in ${fullProjectPath}`
    );
    return { success: false };
  }

  // The test command runs through a shell, so the file filter must not be
  // able to introduce shell syntax. Characters the shell expands unquoted
  // stay rejected, which excludes spaces, $ in nested-class names, and
  // Maven %regex[...] selectors; ? matches any character in Maven patterns,
  // so Outer?Inner selects the nested class Outer$Inner.
  // A leading dash would reach Vitest as an option (for example --help exits
  // without running any test), so testFile must name a file or selector.
  if (
    options.testFile &&
    (!SAFE_TEST_FILE.test(options.testFile) || options.testFile.startsWith('-'))
  ) {
    logger.error(
      `Invalid testFile "${options.testFile}". The value must not begin with "-". Allowed characters: letters, digits, and . _ - / : # * ? , ! + (plus \\ on Windows)`
    );
    return { success: false };
  }

  if (isServer) {
    return testServer(options, fullProjectPath);
  } else {
    return testFrontend(options, fullProjectPath);
  }
}

// sh strips an unquoted backslash while cmd.exe keeps it, so the Windows
// path separator is only accepted where it survives the shell.
const SAFE_TEST_FILE =
  process.platform === 'win32'
    ? /^[A-Za-z0-9._/\\:#*?,!+-]+$/
    : /^[A-Za-z0-9._/:#*?,!+-]+$/;

function testServer(
  options: TestExecutorSchema,
  projectPath: string
): { success: boolean } {
  logger.info('🧪 Running HAPI FHIR Server tests...');

  const args = ['test'];
  
  if (options.coverage) {
    args.push('jacoco:report');
  }
  
  if (options.testFile) {
    args.push(`-Dtest=${options.testFile}`);
  }

  const command = `mvn ${args.join(' ')}`;
  
  try {
    execSync(command, {
      cwd: projectPath,
      stdio: 'inherit',
    });
    
    logger.info('✅ Server tests passed');
    return { success: true };
  } catch (error) {
    logger.error(`Maven tests failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false };
  }
}

function testFrontend(
  options: TestExecutorSchema,
  projectPath: string
): { success: boolean } {
  logger.info('🧪 Running Vitest Frontend tests...');

  const vitestArgs: string[] = [];

  if (options.watch) {
    vitestArgs.push('--watch');
  }

  if (options.coverage) {
    vitestArgs.push('--coverage');
  }

  if (options.testFile) {
    vitestArgs.push(options.testFile);
  }

  // npm forwards script arguments only after a single -- separator; bun
  // forwards everything after the script name.
  const packageManager = getPackageManager();
  let command = getRunCommand(packageManager, 'test');
  if (vitestArgs.length > 0) {
    const separator = packageManager === 'npm' ? ' -- ' : ' ';
    command += separator + vitestArgs.join(' ');
  }

  try {
    execSync(command, {
      cwd: projectPath,
      stdio: 'inherit',
    });

    logger.info('✅ Frontend tests passed');
    return { success: true };
  } catch (error) {
    logger.error(`Frontend tests failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false };
  }
}
