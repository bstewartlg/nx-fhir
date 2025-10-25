import { ExecutorContext, logger } from '@nx/devkit';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { BuildExecutorSchema } from './schema';

export default async function buildExecutor(
  options: BuildExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const projectConfig =
    context.projectsConfigurations?.projects[context.projectName!];

  if (!projectConfig) {
    logger.error(
      `Could not find project configuration for ${context.projectName}`,
    );
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
      `Unknown project type for ${context.projectName}. Expected pom.xml (server) or package.json (frontend) in ${fullProjectPath}`,
    );
    return { success: false };
  }

  try {
    if (isServer) {
      return buildServer(options, fullProjectPath);
    } else {
      return buildFrontend(options, fullProjectPath);
    }
  } catch (error) {
    logger.error(
      `Failed to build ${context.projectName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { success: false };
  }
}

function buildServer(
  options: BuildExecutorSchema,
  projectPath: string,
): { success: boolean } {
  logger.info('🔨 Building HAPI FHIR Server...');

  // Build Maven command
  const args = [];

  if (options.clean) {
    args.push('clean');
  }

  args.push('package');

  if (options.skipTests) {
    args.push('-DskipTests');
  }

  if (options.production) {
    args.push('-Pprod');
  }

  const command = `mvn ${args.join(' ')}`;

  try {
    execSync(command, {
      cwd: projectPath,
      stdio: 'inherit',
    });

    logger.info('✅ Server build completed successfully');
    return { success: true };
  } catch (error) {
    logger.error(
      `Maven build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { success: false };
  }
}

function buildFrontend(
  options: BuildExecutorSchema,
  projectPath: string,
): { success: boolean } {
  logger.info('🔨 Building Next.js Frontend...');

  try {
    execSync('npm run build', {
      cwd: projectPath,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: options.production ? 'production' : 'development',
      },
    });

    logger.info('✅ Frontend build completed successfully');
    return { success: true };
  } catch (error) {
    logger.error(
      `npm build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { success: false };
  }
}
