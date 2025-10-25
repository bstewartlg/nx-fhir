import { ExecutorContext, logger } from '@nx/devkit';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { TestExecutorSchema } from './schema';

export default async function testExecutor(
  options: TestExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectConfig = context.projectsConfigurations?.projects[context.projectName!];
  
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

  try {
    if (isServer) {
      return testServer(options, fullProjectPath);
    } else {
      return testFrontend(options, fullProjectPath);
    }
  } catch (error) {
    logger.error(`Failed to test ${context.projectName}: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false };
  }
}

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
  logger.info('🧪 Running Next.js Frontend tests...');

  const args = ['run', 'test'];
  
  if (options.watch) {
    args.push('--', '--watch');
  }
  
  if (options.coverage) {
    args.push('--', '--coverage');
  }
  
  if (options.testFile) {
    args.push('--', options.testFile);
  }

  const command = `npm ${args.join(' ')}`;
  
  try {
    execSync(command, {
      cwd: projectPath,
      stdio: 'inherit',
    });
    
    logger.info('✅ Frontend tests passed');
    return { success: true };
  } catch (error) {
    logger.error(`npm tests failed: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false };
  }
}
