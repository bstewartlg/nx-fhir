/**
 * A known breaking change that a semver range still accepts. An update that
 * moves a project from below `boundary` to `boundary` or above is risky. The
 * project's own range accepts the new version, so the range check does not
 * catch it.
 */
export interface DependencyAdvisory {
  packageName: string;
  boundary: string;
  note: string;
  fix?: { command: string; files: string[] };
}

export const DEPENDENCY_ADVISORIES: DependencyAdvisory[] = [
  {
    packageName: '@biomejs/biome',
    boundary: '2.6.0',
    note: 'New lint rules can flag code that passed before, and the biome.json schema version changes.',
    fix: { command: 'biome migrate --write', files: ['biome.json', 'biome.jsonc'] },
  },
];
