import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { ExecutorContext, logger } from '@nx/devkit';
import executor from './executor';
import { OTEL_JAVAAGENT_VERSION } from '../../shared/constants/versions';
import * as fs from 'fs';
import * as child_process from 'child_process';
import type { ChildProcess } from 'child_process';
import * as path from 'path';

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');

describe('Serve Executor', () => {
  let context: ExecutorContext;
  let mockSpawn: { on: Mock; kill: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSpawn = {
      on: vi.fn(),
      kill: vi.fn(),
    };
    
    vi.mocked(child_process.spawn).mockReturnValue(
      mockSpawn as unknown as ChildProcess,
    );

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

  it('should detect and serve a server project', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('pom.xml');
    });

    // Mock spawn to call exit callback immediately
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    const result = await executor({}, context);

    const expectedCwd = path.join('/workspace', 'apps/test-project');
    expect(child_process.spawn).toHaveBeenCalledWith(
      'mvn',
      ['spring-boot:run'],
      expect.objectContaining({
        cwd: expectedCwd,
      })
    );
    expect(result.success).toBe(true);
  });

  it('should detect and serve a frontend project', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('package.json');
    });

    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    const result = await executor({ port: 3000 }, context);

    const expectedCwd = path.join('/workspace', 'apps/test-project');
    expect(child_process.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^(npm|pnpm|bun)$/),
      ['run', 'dev', '--', '--port', '3000'],
      expect.objectContaining({
        cwd: expectedCwd,
      })
    );
    expect(result.success).toBe(true);
  });

  it('should fail when project type cannot be determined', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await executor({}, context);

    expect(result.success).toBe(false);
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it('should pass debug options to server', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('pom.xml');
    });

    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ debug: true }, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'mvn',
      expect.arrayContaining([
        'spring-boot:run',
        '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005',
      ]),
      expect.any(Object)
    );
  });

  it('should pass Spring profile to server', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('pom.xml');
    });

    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ profile: 'production' }, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'mvn',
      expect.arrayContaining([
        'spring-boot:run',
        '-Dspring-boot.run.profiles=production',
      ]),
      expect.any(Object)
    );
  });

  it('should pass custom port and host to frontend', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('package.json');
    });

    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ port: 4200, host: '0.0.0.0' }, context);

    const expectedCwd = path.join('/workspace', 'apps/test-project');
    expect(child_process.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^(npm|pnpm|bun)$/),
      ['run', 'dev', '--', '--port', '4200', '--host', '0.0.0.0'],
      expect.objectContaining({
        cwd: expectedCwd,
      })
    );
  });

  it('should reject a profile containing shell metacharacters', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('pom.xml');
    });

    const result = await executor({ profile: 'prod&calc.exe' }, context);

    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  it('should reject a host containing shell metacharacters', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('package.json');
    });

    const result = await executor({ host: '127.0.0.1|whoami' }, context);

    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  it('should accept an IPv6 host and reject a non-integer port', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
      return path.toString().endsWith('package.json');
    });

    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ host: '::' }, context);
    expect(child_process.spawn).toHaveBeenCalledTimes(1);

    const result = await executor(
      { port: '8080; rm -rf /' as unknown as number },
      context,
    );
    expect(child_process.spawn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: false });
  });

  it('should fail when the context names no project', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const result = await executor({}, { ...context, projectName: undefined });

    expect(result).toEqual({ success: false });
    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not find project configuration'),
    );
    errorSpy.mockRestore();
  });

  it('should pass the port to the server as a Spring Boot run argument', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('pom.xml'),
    );
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ port: 8081 }, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'mvn',
      ['spring-boot:run', '-Dspring-boot.run.arguments=--server.port=8081'],
      expect.any(Object),
    );
  });

  it('should report failure when the Maven process exits non-zero', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('pom.xml'),
    );
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(1), 10);
      }
      return mockSpawn;
    });

    const result = await executor({}, context);

    expect(result).toEqual({ success: false });
    expect(errorSpy).toHaveBeenCalledWith('Maven process exited with code 1');
    errorSpy.mockRestore();
  });

  it('should treat a Maven process killed by a signal as success', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('pom.xml'),
    );
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        // A signalled process reports a null code, which Ctrl-C produces.
        setTimeout(() => callback(null), 10);
      }
      return mockSpawn;
    });

    expect(await executor({}, context)).toEqual({ success: true });
  });

  it('should report failure when the Vite process exits non-zero', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('package.json'),
    );
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(2), 10);
      }
      return mockSpawn;
    });

    const result = await executor({}, context);

    expect(result).toEqual({ success: false });
    expect(errorSpy).toHaveBeenCalledWith('Vite process exited with code 2');
    errorSpy.mockRestore();
  });

  it('should log debug mode for a frontend without changing the command', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('package.json'),
    );
    mockSpawn.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ debug: true }, context);

    expect(infoSpy).toHaveBeenCalledWith('🐛 Debug mode enabled');
    expect(child_process.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['run', 'dev', '--'],
      expect.any(Object),
    );
    infoSpy.mockRestore();
  });

  it('should report the message when spawning throws an Error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('pom.xml'),
    );
    vi.mocked(child_process.spawn).mockImplementation(() => {
      throw new Error('mvn not found');
    });

    const result = await executor({}, context);

    expect(result).toEqual({ success: false });
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to serve test-project: mvn not found',
    );
    errorSpy.mockRestore();
  });

  it('should stringify a non-Error thrown while spawning', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
      path.toString().endsWith('package.json'),
    );
    vi.mocked(child_process.spawn).mockImplementation(() => {
      throw 'EACCES';
    });

    const result = await executor({}, context);

    expect(result).toEqual({ success: false });
    expect(errorSpy).toHaveBeenCalledWith('Failed to serve test-project: EACCES');
    errorSpy.mockRestore();
  });

  describe('otel', () => {
    const originalAgentConfig = process.env.OTEL_JAVAAGENT_CONFIGURATION_FILE;
    const agentArg = '-Dspring-boot.run.agents=target/opentelemetry-javaagent.jar';

    function fakeChild(event: 'exit' | 'error', value: unknown): ChildProcess {
      const child = {
        on: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
          if (name === event) {
            setTimeout(() => callback(value), 10);
          }
          return child;
        }),
        kill: vi.fn(),
      };
      return child as unknown as ChildProcess;
    }

    function exitWith(code: number | null) {
      vi.mocked(child_process.spawn).mockReturnValue(fakeChild('exit', code));
    }

    function signalListenerCounts() {
      return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    }

    beforeEach(() => {
      delete process.env.OTEL_JAVAAGENT_CONFIGURATION_FILE;
      vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
        path.toString().endsWith('pom.xml'),
      );
      exitWith(0);
      Object.assign(context.projectsConfigurations.projects['test-project'], {
        features: { otel: { version: 1, options: { serve: true } } },
      });
    });

    afterEach(() => {
      if (originalAgentConfig === undefined) {
        delete process.env.OTEL_JAVAAGENT_CONFIGURATION_FILE;
      } else {
        process.env.OTEL_JAVAAGENT_CONFIGURATION_FILE = originalAgentConfig;
      }
    });

    it('fetches the agent then runs with the agent path when otel is set', async () => {
      const result = await executor({ otel: true }, context);

      const expectedCwd = path.join('/workspace', 'apps/test-project');
      expect(child_process.spawn).toHaveBeenCalledTimes(2);
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        1,
        'mvn',
        [
          '-q',
          'dependency:copy',
          '-Dartifact=io.opentelemetry.javaagent:opentelemetry-javaagent:2.32.0',
          '-DoutputDirectory=target',
          '-Dmdep.stripVersion=true',
        ],
        expect.objectContaining({ cwd: expectedCwd }),
      );
      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'mvn',
        ['spring-boot:run', agentArg],
        expect.objectContaining({ cwd: expectedCwd }),
      );
      const [fetchCall, runCall] = vi.mocked(child_process.spawn).mock.calls;
      expect(fetchCall[2]).not.toHaveProperty('env');
      expect(runCall[2].env).toEqual({
        OTEL_JAVAAGENT_CONFIGURATION_FILE: 'otel/agent.properties',
        ...process.env,
      });
      expect(result).toEqual({ success: true });
    });

    it('passes no env override to Maven without otel', async () => {
      await executor({}, context);

      expect(child_process.spawn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(child_process.spawn).mock.calls[0][2]).not.toHaveProperty('env');
    });

    it('removes its signal handlers after the fetch and after the run', async () => {
      const before = signalListenerCounts();
      const countsAtSpawn: number[][] = [];
      vi.mocked(child_process.spawn).mockImplementation(() => {
        countsAtSpawn.push(signalListenerCounts());
        return fakeChild('exit', 0);
      });

      await executor({ otel: true }, context);

      expect(countsAtSpawn).toEqual([before, before]);
      expect(signalListenerCounts()).toEqual(before);
    });

    it('fails without starting the server when Maven cannot start for the fetch', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const before = signalListenerCounts();
      vi.mocked(child_process.spawn).mockReturnValue(
        fakeChild('error', new Error('spawn mvn ENOENT')),
      );

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: false });
      expect(child_process.spawn).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('Failed to serve test-project: spawn mvn ENOENT');
      expect(signalListenerCounts()).toEqual(before);
      errorSpy.mockRestore();
    });

    it('fails when Maven cannot start for the run', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const before = signalListenerCounts();
      vi.mocked(child_process.spawn)
        .mockReturnValueOnce(fakeChild('exit', 0))
        .mockReturnValueOnce(fakeChild('error', new Error('spawn mvn ENOENT')));

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: false });
      expect(child_process.spawn).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith('Failed to serve test-project: spawn mvn ENOENT');
      expect(signalListenerCounts()).toEqual(before);
      errorSpy.mockRestore();
    });

    it('uses the shared OTEL_JAVAAGENT_VERSION constant in the artifact coordinate', async () => {
      await executor({ otel: true }, context);

      expect(child_process.spawn).toHaveBeenNthCalledWith(
        1,
        'mvn',
        expect.arrayContaining([
          `-Dartifact=io.opentelemetry.javaagent:opentelemetry-javaagent:${OTEL_JAVAAGENT_VERSION}`,
        ]),
        expect.any(Object),
      );
    });

    it('fails when the agent fetch exits non-zero and does not start the server', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      exitWith(1);

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: false });
      expect(child_process.spawn).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Could not download the OpenTelemetry Java agent. Maven exited with code 1',
      );
      errorSpy.mockRestore();
    });

    it('does not start the server when the agent fetch is stopped by a signal', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      exitWith(null);

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: false });
      expect(child_process.spawn).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it('keeps a user-set OTEL_JAVAAGENT_CONFIGURATION_FILE', async () => {
      process.env.OTEL_JAVAAGENT_CONFIGURATION_FILE = '/mine.properties';

      await executor({ otel: true }, context);

      expect(vi.mocked(child_process.spawn).mock.calls[1][2].env).toEqual({
        ...process.env,
        OTEL_JAVAAGENT_CONFIGURATION_FILE: '/mine.properties',
      });
    });

    it('combines otel with debug without touching jvmArguments', async () => {
      await executor({ otel: true, debug: true }, context);

      expect(child_process.spawn).toHaveBeenNthCalledWith(
        2,
        'mvn',
        [
          'spring-boot:run',
          '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005',
          agentArg,
        ],
        expect.any(Object),
      );
    });

    it('fails before spawning when the manifest lacks serve: true', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      context.projectsConfigurations.projects['test-project'] = { root: 'apps/test-project' };

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: false });
      expect(child_process.spawn).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        'The otel flag needs the otel feature with the serve option. Install it with: nx g nx-fhir:feature-otel --project=test-project --serve',
      );
      errorSpy.mockRestore();
    });

    it('ignores otel for a frontend project', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) =>
        path.toString().endsWith('package.json'),
      );
      context.projectsConfigurations.projects['test-project'] = { root: 'apps/test-project' };

      const result = await executor({ otel: true }, context);

      expect(result).toEqual({ success: true });
      expect(child_process.spawn).toHaveBeenCalledTimes(1);
      expect(child_process.spawn).toHaveBeenCalledWith(
        expect.any(String),
        ['run', 'dev', '--'],
        expect.any(Object),
      );
    });
  });
});
