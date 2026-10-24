import { detectPackageManager, ExecutorContext, logger } from '@nx/devkit';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { OTEL_JAVAAGENT_VERSION } from '../../shared/constants/versions';
import { ServerProjectConfiguration } from '../../shared/models';
import { ServeExecutorSchema } from './schema';

export default async function serveExecutor(
  options: ServeExecutorSchema,
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

  // spawn resolves mvn.cmd and npm.cmd through a shell on Windows, and a
  // shell makes argument content executable, so option values stay
  // restricted to characters with no shell meaning.
  if (options.profile && !SAFE_PROFILE.test(options.profile)) {
    logger.error(
      `Invalid profile "${options.profile}". Allowed characters: letters, digits, and . _ - ,`
    );
    return { success: false };
  }

  if (options.host && !SAFE_HOST.test(options.host)) {
    logger.error(
      `Invalid host "${options.host}". Allowed characters: letters, digits, and . : _ -`
    );
    return { success: false };
  }

  if (options.port !== undefined && !Number.isInteger(Number(options.port))) {
    logger.error(`Invalid port "${options.port}". The port must be an integer.`);
    return { success: false };
  }

  if (
    isServer &&
    options.otel &&
    (projectConfig as ServerProjectConfiguration).features?.otel?.options?.serve !== true
  ) {
    logger.error(
      `The otel flag needs the otel feature with the serve option. Install it with: nx g nx-fhir:feature-otel --project=${context.projectName} --serve`
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

const SAFE_PROFILE = /^[A-Za-z0-9._,-]+$/;
// Hostnames, IPv4, and IPv6 addresses; the colon carries no shell meaning.
const SAFE_HOST = /^[A-Za-z0-9.:_-]+$/;

async function serveServer(
  options: ServeExecutorSchema,
  projectPath: string
): Promise<{ success: boolean }> {
  logger.info('🚀 Starting HAPI FHIR Server...');

  // Build Maven command
  const args = ['spring-boot:run'];

  // These values are passed to Maven as single argv entries without a shell,
  // so they must not contain quotes, and none of them may contain spaces
  // because the spring-boot plugin splits property values on whitespace.
  if (options.port) {
    args.push(`-Dspring-boot.run.arguments=--server.port=${options.port.toString()}`);
  }

  if (options.profile) {
    args.push(`-Dspring-boot.run.profiles=${options.profile}`);
  }

  if (options.debug) {
    args.push('-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005');
    logger.info('🐛 Debug mode enabled on port 5005');
  }

  let env: NodeJS.ProcessEnv | undefined;
  if (options.otel) {
    logger.info(`Fetching the OpenTelemetry Java agent ${OTEL_JAVAAGENT_VERSION}`);
    const fetchCode = await runMaven(
      [
        '-q',
        'dependency:copy',
        `-Dartifact=io.opentelemetry.javaagent:opentelemetry-javaagent:${OTEL_JAVAAGENT_VERSION}`,
        '-DoutputDirectory=target',
        '-Dmdep.stripVersion=true',
      ],
      projectPath
    );
    if (fetchCode !== 0) {
      logger.error(
        `Could not download the OpenTelemetry Java agent. Maven exited with code ${fetchCode}`
      );
      return { success: false };
    }
    args.push('-Dspring-boot.run.agents=target/opentelemetry-javaagent.jar');
    // A configuration file the user names in the environment wins.
    env = { OTEL_JAVAAGENT_CONFIGURATION_FILE: 'otel/agent.properties', ...process.env };
  }

  const code = await runMaven(args, projectPath, env);
  if (code === 0 || code === null) {
    return { success: true };
  }
  logger.error(`Maven process exited with code ${code}`);
  return { success: false };
}

/**
 * Resolves with the Maven exit code, or null when Maven stops on a signal,
 * so each caller decides whether a signal counts as success. Rejects when
 * Maven cannot start, for example when mvn is not on the PATH.
 */
function runMaven(
  args: string[],
  projectPath: string,
  env?: NodeJS.ProcessEnv
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('mvn', args, {
      cwd: projectPath,
      stdio: 'inherit',
      // Maven is mvn.cmd on Windows, which spawn only resolves through a shell
      shell: process.platform === 'win32',
      ...(env && { env }),
    });

    // Handle process termination
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
      resolve(null);
    };
    const stopForwarding = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('exit', (code) => {
      stopForwarding();
      resolve(code);
    });
    child.on('error', (error) => {
      stopForwarding();
      reject(error);
    });
  });
}

async function serveFrontend(
  options: ServeExecutorSchema,
  projectPath: string
): Promise<{ success: boolean }> {
  logger.info('🚀 Starting Vite Frontend...');

  // Build command
  const args = ['run', 'dev', '--'];
  
  if (options.port) {
    args.push('--port', options.port.toString());
  }
  
  if (options.host) {
    args.push('--host', options.host);
  }

  if (options.debug) {
    logger.info('🐛 Debug mode enabled');
  }

  return new Promise((resolve) => {
    const child = spawn(detectPackageManager(), args, {
      cwd: projectPath,
      stdio: 'inherit',
      // npm and bun are .cmd/.exe shims on Windows and need a shell to resolve
      shell: process.platform === 'win32',
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
        logger.error(`Vite process exited with code ${code}`);
        resolve({ success: false });
      }
    });
  });
}
