import { spawn } from 'child_process';
import { PackageManager } from '@nx/devkit';
import treeKill from 'tree-kill';
import { getRunCommand } from '../utils/package-manager';

export const CHECK_SCRIPTS = ['build', 'check', 'test'] as const;

export const COMMAND_TIMEOUT_MS = 900000;

const OUTPUT_TAIL_LINES = 40;

// Bound on retained output so a stream with no newlines cannot grow
const OUTPUT_TAIL_CHARS = 64 * 1024;

// Bound on the wait for tree-kill, whose process walk has no timeout of its own
const KILL_WAIT_MS = 5000;

export interface CommandResult {
  passed: boolean;
  output: string;
}

export interface CheckResult extends CommandResult {
  script: string;
}

// Keeps the last lines plus the open line a later chunk may continue
function keepTail(buffer: string): string {
  const kept = buffer.split('\n').slice(-(OUTPUT_TAIL_LINES + 1)).join('\n');
  return kept.slice(-OUTPUT_TAIL_CHARS);
}

function tail(output: string): string {
  return output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join('\n');
}

/**
 * Runs a shell command and resolves with its outcome and the last lines of
 * its combined output. CI is set so test runners do not enter watch mode,
 * stdin is closed so a prompt cannot wait for input, and a command that
 * outlives the timeout is killed with its whole process tree. The result
 * settles a bounded time after the deadline even when a descendant keeps
 * the output pipes open or the kill itself never completes.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let killWait: NodeJS.Timeout | undefined;
    const collect = (chunk: string) => (output = keepTail(output + chunk));
    // Decoding per stream keeps a multibyte character whole across chunks
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => collect(error.message));

    // Whichever of close, the kill callback, and the kill wait fires first
    // settles the promise, and the later ones are no-ops. The streams are
    // destroyed because a descendant that survived the kill may hold them.
    const finish = (passed: boolean) => {
      clearTimeout(timer);
      clearTimeout(killWait);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        passed,
        output: timedOut
          ? `${tail(output)}\nTimed out after ${timeoutMs} ms`
          : tail(output),
      });
    };

    // A spawn that failed has no pid and closes long before the timer fires
    const timer = setTimeout(() => {
      timedOut = true;
      killWait = setTimeout(() => finish(false), KILL_WAIT_MS);
      if (child.pid !== undefined) {
        treeKill(child.pid, 'SIGKILL', () => finish(false));
      }
    }, timeoutMs);

    child.on('close', (code) => finish(code === 0 && !timedOut));
  });
}

/**
 * Runs each check script the project defines, in CHECK_SCRIPTS order.
 */
export async function runProjectChecks(
  cwd: string,
  packageManager: PackageManager,
  scripts: Record<string, string> | undefined
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const script of CHECK_SCRIPTS) {
    if (!scripts?.[script]) {
      continue;
    }
    const result = await runCommand(getRunCommand(packageManager, script), cwd);
    results.push({ script, ...result });
  }
  return results;
}

/**
 * Splits the failures of a run by whether the same script already failed in
 * the baseline. With no baseline every failure counts as new.
 */
export function compareChecks(
  baseline: CheckResult[] | undefined,
  after: CheckResult[]
): { newFailures: CheckResult[]; alreadyFailing: CheckResult[] } {
  const failedBefore = new Set(
    (baseline ?? []).filter((r) => !r.passed).map((r) => r.script)
  );
  const failures = after.filter((r) => !r.passed);
  return {
    newFailures: failures.filter((r) => !failedBefore.has(r.script)),
    alreadyFailing: failures.filter((r) => failedBefore.has(r.script)),
  };
}
