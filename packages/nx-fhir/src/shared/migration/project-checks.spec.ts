import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import treeKill from 'tree-kill';
import {
  CHECK_SCRIPTS,
  CheckResult,
  compareChecks,
  runCommand,
  runProjectChecks,
} from './project-checks';

// The real tree-kill runs behind a spy so one test can make it never call back
vi.mock('tree-kill', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof treeKill }>();
  return { default: vi.fn(actual.default) };
});

const SLOW = { timeout: 30000 };

describe('project checks', () => {
  let dir: string;

  // Scripts live in files so the same double-quoted command line works in
  // cmd.exe and sh. Inline node -e code would need per-shell quoting.
  const nodeScript = (name: string, source: string) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return `"${process.execPath}" "${file}"`;
  };

  // A killed process stays in the process table as a zombie until its parent
  // reaps it, and signal 0 still reaches a zombie. PID 1 of a CI job container
  // does not reap the processes it adopts, so Linux needs the state from /proc.
  const isZombie = (pid: number) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The state follows the command name, which can hold spaces and parentheses
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return false;
    }
  };

  const waitForExit = async (pid: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      if (isZombie(pid)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  // A process the command leaves behind writes its pid to a .pid file in
  // the temp dir before it starts looping, so teardown can kill it even
  // when the test itself hung
  const pidScript = (name: string) =>
    `require('fs').writeFileSync(${JSON.stringify(join(dir, name))}, String(process.pid));
    setInterval(() => {}, 1000);`;

  const readPid = (name: string) => Number(readFileSync(join(dir, name), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nx-fhir-project-checks-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(treeKill).mockReset();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.pid'))) {
      try {
        process.kill(readPid(file), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('runCommand', () => {
    it('passes for a command that exits 0', async () => {
      const result = await runCommand(nodeScript('ok.js', 'process.exit(0)'), dir);
      expect(result.passed).toBe(true);
    });

    it('fails with the last 40 lines of combined output', async () => {
      // Separate pipes do not keep order between streams, so the early
      // lines go to stderr, and a pause before the stdout tail lets the
      // parent read the stderr chunk first on every platform.
      const command = nodeScript(
        'noisy.js',
        `for (let i = 1; i <= 20; i++) process.stderr.write('line ' + i + '\\n');
        setTimeout(() => {
          for (let i = 21; i <= 100; i++) process.stdout.write('line ' + i + '\\n');
          process.exitCode = 1;
        }, 100);`
      );
      const result = await runCommand(command, dir);
      expect(result.passed).toBe(false);
      const lines = result.output.split('\n');
      expect(lines).toHaveLength(40);
      expect(lines[0]).toBe('line 61');
      expect(lines[39]).toBe('line 100');
    });

    it('runs with CI set to true', async () => {
      vi.stubEnv('CI', undefined);
      const command = nodeScript(
        'ci.js',
        `process.exit(process.env.CI === 'true' ? 0 : 1)`
      );
      const result = await runCommand(command, dir);
      expect(result.passed).toBe(true);
    });

    it('kills the whole process tree on timeout', SLOW, async () => {
      const grandchild = join(dir, 'grandchild.js');
      writeFileSync(grandchild, pidScript('grandchild.pid'));
      const command = nodeScript(
        'parent.js',
        `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' });
        setInterval(() => {}, 1000);`
      );
      const result = await runCommand(command, dir, 2000);
      expect(result.passed).toBe(false);
      expect(result.output.endsWith('Timed out after 2000 ms')).toBe(true);
      expect(existsSync(join(dir, 'grandchild.pid'))).toBe(true);
      expect(await waitForExit(readPid('grandchild.pid'))).toBe(true);
    });

    it('settles after the deadline when a descendant outlives the parent', SLOW, async () => {
      const grandchild = join(dir, 'orphan.js');
      writeFileSync(grandchild, pidScript('orphan.pid'));
      // The grandchild inherits the output pipes and keeps them open after
      // the parent exits, so close cannot fire until the grandchild dies
      const command = nodeScript(
        'exiting-parent.js',
        `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true }).unref();`
      );
      const started = Date.now();
      const result = await runCommand(command, dir, 2000);
      const elapsed = Date.now() - started;
      expect(result.passed).toBe(false);
      expect(result.output.endsWith('Timed out after 2000 ms')).toBe(true);
      expect(elapsed).toBeLessThan(3500);
    });

    it('settles within the fallback window when the kill never calls back', SLOW, async () => {
      vi.mocked(treeKill).mockImplementationOnce(() => undefined);
      const command = nodeScript('stuck.js', pidScript('stuck.pid'));
      const started = Date.now();
      const result = await runCommand(command, dir, 1000);
      const elapsed = Date.now() - started;
      expect(treeKill).toHaveBeenCalledTimes(1);
      expect(result.passed).toBe(false);
      expect(result.output.endsWith('Timed out after 1000 ms')).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(5000);
      expect(elapsed).toBeLessThan(8000);
    });

    it('keeps only the tail of several MiB of output', SLOW, async () => {
      const command = nodeScript(
        'flood.js',
        `const line = 'x'.repeat(60);
        for (let i = 1; i <= 100000; i++) process.stdout.write(line + ' ' + i + '\\n');
        process.exitCode = 1;`
      );
      const result = await runCommand(command, dir);
      expect(result.passed).toBe(false);
      const lines = result.output.split('\n');
      expect(lines).toHaveLength(40);
      expect(lines[39].endsWith(' 100000')).toBe(true);
    });

    it('caps output that has no newlines', SLOW, async () => {
      const command = nodeScript(
        'no-newlines.js',
        `process.stdout.write('y'.repeat(3 * 1024 * 1024));
        process.exitCode = 1;`
      );
      const result = await runCommand(command, dir);
      expect(result.passed).toBe(false);
      expect(result.output.length).toBeLessThanOrEqual(64 * 1024);
      expect(result.output.endsWith('y')).toBe(true);
    });

    it('closes stdin so a prompt cannot wait', SLOW, async () => {
      const command = nodeScript(
        'stdin.js',
        `process.stdin.resume();
        process.stdin.on('end', () => process.exit(0));`
      );
      const result = await runCommand(command, dir, 5000);
      expect(result.passed).toBe(true);
    });

    it('fails when the directory does not exist', async () => {
      const missing = join(dir, 'missing');
      const result = await runCommand(nodeScript('ok.js', 'process.exit(0)'), missing);
      expect(result.passed).toBe(false);
      expect(result.output).toContain('ENOENT');
    });
  });

  describe('runProjectChecks', () => {
    it('runs only the check scripts the project defines, in order', SLOW, async () => {
      writeFileSync(
        join(dir, 'append.js'),
        `require('fs').appendFileSync('log.txt', process.argv[2] + '\\n');`
      );
      const scripts = {
        test: 'node append.js test',
        build: 'node append.js build',
        dev: 'node append.js dev',
      };
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'checked', private: true, scripts })
      );
      const results = await runProjectChecks(dir, 'npm', scripts);
      expect(results.map((r) => r.script)).toEqual(['build', 'test']);
      expect(results.every((r) => r.passed)).toBe(true);
      expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('build\ntest\n');
    });

    it('returns no results when the project has no scripts', async () => {
      expect(await runProjectChecks(dir, 'bun', undefined)).toEqual([]);
    });

    it('checks build, check, and test in that order', () => {
      expect(CHECK_SCRIPTS).toEqual(['build', 'check', 'test']);
    });
  });

  describe('compareChecks', () => {
    const result = (script: string, passed: boolean): CheckResult => ({
      script,
      passed,
      output: '',
    });

    it('counts a script that passed before and fails now as new', () => {
      const outcome = compareChecks(
        [result('build', true), result('test', true)],
        [result('build', true), result('test', false)]
      );
      expect(outcome.newFailures).toEqual([result('test', false)]);
      expect(outcome.alreadyFailing).toEqual([]);
    });

    it('reports a script that failed before as already failing', () => {
      const outcome = compareChecks(
        [result('build', false), result('test', true)],
        [result('build', false), result('test', false)]
      );
      expect(outcome.newFailures).toEqual([result('test', false)]);
      expect(outcome.alreadyFailing).toEqual([result('build', false)]);
    });

    it('counts every failure as new when there is no baseline', () => {
      const outcome = compareChecks(undefined, [
        result('build', false),
        result('test', true),
      ]);
      expect(outcome.newFailures).toEqual([result('build', false)]);
      expect(outcome.alreadyFailing).toEqual([]);
    });
  });
});
