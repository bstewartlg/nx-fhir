import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorContext } from '@nx/devkit';
import executor from './executor';
import * as fs from 'fs';
import * as child_process from 'child_process';

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');

describe('Serve Executor', () => {
  let context: ExecutorContext;
  let mockSpawn: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSpawn = {
      on: vi.fn(),
      kill: vi.fn(),
    };
    
    vi.mocked(child_process.spawn).mockReturnValue(mockSpawn as any);

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
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('pom.xml');
    });

    // Mock spawn to call exit callback immediately
    mockSpawn.on.mockImplementation((event: string, callback: any) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    const result = await executor({}, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'mvn',
      ['spring-boot:run'],
      expect.objectContaining({
        cwd: '/workspace/apps/test-project',
      })
    );
    expect(result.success).toBe(true);
  });

  it('should detect and serve a frontend project', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('package.json');
    });

    mockSpawn.on.mockImplementation((event: string, callback: any) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    const result = await executor({ port: 3000 }, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev', '--', '--port', '3000'],
      expect.objectContaining({
        cwd: '/workspace/apps/test-project',
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
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('pom.xml');
    });

    mockSpawn.on.mockImplementation((event: string, callback: any) => {
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
        expect.stringContaining('-Xdebug'),
      ]),
      expect.any(Object)
    );
  });

  it('should pass Spring profile to server', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('pom.xml');
    });

    mockSpawn.on.mockImplementation((event: string, callback: any) => {
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
    vi.mocked(fs.existsSync).mockImplementation((path: any) => {
      return path.toString().endsWith('package.json');
    });

    mockSpawn.on.mockImplementation((event: string, callback: any) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
      return mockSpawn;
    });

    await executor({ port: 4200, host: '0.0.0.0' }, context);

    expect(child_process.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev', '--', '--port', '4200', '--hostname', '0.0.0.0'],
      expect.objectContaining({
        cwd: '/workspace/apps/test-project',
      })
    );
  });
});
