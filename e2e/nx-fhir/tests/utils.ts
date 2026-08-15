// The outer nx task runner injects coordination variables (NX_TERMINAL_OUTPUT_PATH,
// NX_TASK_TARGET_*, NX_WORKSPACE_ROOT) and npm run injects npm_config_* into this
// process. Nested nx and npm invocations in the test workspace must not inherit
// them, or they attach to the outer orchestrator and terminate the run early.
export function buildCleanEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NX_') || key.startsWith('npm_')) {
      continue;
    }
    cleanEnv[key] = value;
  }
  return { ...cleanEnv, ...overrides };
}
