import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { ExecutorContext, logger } from '@nx/devkit';
import executor from './executor';
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
});
