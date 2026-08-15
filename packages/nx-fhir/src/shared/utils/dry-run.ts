/**
 * Reports whether the generator is previewing changes rather than applying
 * them. Nx keeps the flag out of generator options, so it is read from the
 * command line and from the environment variable Nx also accepts.
 */
export function isDryRun(): boolean {
  return (
    process.argv.includes('--dry-run') || process.env.NX_DRY_RUN === 'true'
  );
}
