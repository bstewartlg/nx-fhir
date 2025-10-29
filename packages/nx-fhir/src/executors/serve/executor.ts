import { detectPackageManager, ExecutorContext, logger } from '@nx/devkit';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServeExecutorSchema } from './schema';

export default async function serveExecutor(
  options: ServeExecutorSchema,
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

  // Detect project type by looking for characteristic files
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
      return await serveServer(options, fullProjectPath);
    } else {
      return await serveFrontend(options, fullProjectPath);
    }
  } catch (error) {
    logger.error(`Failed to serve ${context.projectName}: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false };
  }
}

async function serveServer(
  options: ServeExecutorSchema,
  projectPath: string
): Promise<{ success: boolean }> {
  logger.info('🚀 Starting HAPI FHIR Server...');

  // Build Maven command
  const args = ['spring-boot:run'];

  if (options.port) {
    args.push(`-Dspring-boot.run.arguments="--server.port=${options.port.toString()}"`);
  }
  
  if (options.profile) {
    args.push(`-Dspring-boot.run.profiles=${options.profile}`);
  }
  
  if (options.debug) {
    args.push('-Dspring-boot.run.jvmArguments="-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=n,address=5005"');
    logger.info('🐛 Debug mode enabled on port 5005');
  }

  return new Promise((resolve) => {
    const child = spawn('mvn', args, {
      cwd: projectPath,
      stdio: 'inherit',
      shell: true,
    });

    // Handle process termination
    process.on('SIGINT', () => {
      child.kill('SIGINT');
      resolve({ success: true });
    });

    process.on('SIGTERM', () => {
      child.kill('SIGTERM');
      resolve({ success: true });
    });

    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve({ success: true });
      } else {
        logger.error(`Maven process exited with code ${code}`);
        resolve({ success: false });
      }
    });
  });
}

async function serveFrontend(
  options: ServeExecutorSchema,
  projectPath: string
): Promise<{ success: boolean }> {
  logger.info('🚀 Starting Next.js Frontend...');

  // Build command
  const args = ['run', 'dev', '--'];
  
  if (options.port) {
    args.push('--port', options.port.toString());
  }
  
  if (options.host) {
    args.push('--hostname', options.host);
  }

  if (options.debug) {
    logger.info('🐛 Debug mode enabled');
  }

  return new Promise((resolve) => {
    const child = spawn(detectPackageManager(), args, {
      cwd: projectPath,
      stdio: 'inherit',
      shell: true,
    });

    // Handle process termination
    process.on('SIGINT', () => {
      child.kill('SIGINT');
      resolve({ success: true });
    });

    process.on('SIGTERM', () => {
      child.kill('SIGTERM');
      resolve({ success: true });
    });

    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve({ success: true });
      } else {
        logger.error(`npm process exited with code ${code}`);
        resolve({ success: false });
      }
    });
  });
}
