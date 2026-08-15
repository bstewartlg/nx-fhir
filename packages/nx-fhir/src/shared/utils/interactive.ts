/**
 * Reports whether the process can ask the user a question.
 *
 * Generators are also run from CI and from wrapper CLIs that close stdin. An
 * @inquirer prompt in that situation never resolves, so callers must fall back
 * to a default instead of prompting.
 */
export function isInteractive(): boolean {
  // Nx sets NX_INTERACTIVE to 'false' for --interactive=false.
  if (process.env.NX_INTERACTIVE === 'false') {
    return false;
  }
  const ci = process.env.CI;
  const runningInCi = Boolean(ci) && ci !== 'false' && ci !== '0';
  return Boolean(process.stdin.isTTY) && !runningInCi;
}
