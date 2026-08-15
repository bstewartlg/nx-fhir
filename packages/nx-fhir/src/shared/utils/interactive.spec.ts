import { describe, it, expect, afterEach } from 'vitest';
import { isInteractive } from './interactive';

describe('isInteractive', () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalCi = process.env.CI;
  const originalNxInteractive = process.env.NX_INTERACTIVE;

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    restore('CI', originalCi);
    restore('NX_INTERACTIVE', originalNxInteractive);
  });

  function restore(name: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  it('prompts on a terminal outside CI', () => {
    process.stdin.isTTY = true;
    delete process.env.CI;
    delete process.env.NX_INTERACTIVE;

    expect(isInteractive()).toBe(true);
  });

  it('does not prompt when Nx reports a non-interactive run', () => {
    process.stdin.isTTY = true;
    delete process.env.CI;
    process.env.NX_INTERACTIVE = 'false';

    expect(isInteractive()).toBe(false);
  });

  it('does not prompt without a terminal even when Nx reports interactive', () => {
    process.stdin.isTTY = false;
    delete process.env.CI;
    process.env.NX_INTERACTIVE = 'true';

    expect(isInteractive()).toBe(false);
  });

  it('does not prompt in CI', () => {
    process.stdin.isTTY = true;
    process.env.CI = 'true';
    delete process.env.NX_INTERACTIVE;

    expect(isInteractive()).toBe(false);
  });
});
