import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  gt,
  gte,
  gtr,
  lt,
  minVersion,
  satisfies,
  valid,
  validRange,
} from 'semver';
import { DependencyAdvisory } from './dependency-advisories';

export type DependencySection = 'dependencies' | 'devDependencies';

export type DependencyKind =
  'added' | 'routine' | 'risky' | 'ahead' | 'unmanaged' | 'unchanged';

export interface DependencyChange {
  name: string;
  section: DependencySection;
  from?: string;
  to: string;
  kind: DependencyKind;
  reason?: string;
  advisory?: DependencyAdvisory;
}

type DependencyMaps = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export const OUT_OF_RANGE_NOTE =
  'outside your current range, no notes from nx-fhir';

const SECTIONS: DependencySection[] = ['dependencies', 'devDependencies'];

/**
 * The lowest version a range accepts, or undefined for a range that is not
 * semver or that no version satisfies.
 */
function rangeFloor(range: string): string | undefined {
  return validRange(range) ? minVersion(range)?.version : undefined;
}

/**
 * Decides, for each template dependency, whether the update may write the
 * template range over the project's range. The project keeps any range that
 * is not a semver range or that is already ahead of the template, so an update
 * never lowers a version.
 */
export function classifyDependencies(
  template: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  },
  project: DependencyMaps,
  installedVersion: (name: string) => string | undefined,
  advisories: DependencyAdvisory[],
): DependencyChange[] {
  const changes: DependencyChange[] = [];

  for (const templateSection of SECTIONS) {
    for (const [name, templateRange] of Object.entries(
      template[templateSection],
    )) {
      // A package the user moved to the other section stays where they put it.
      const section =
        [templateSection, ...SECTIONS].find(
          (candidate) => project[candidate]?.[name] !== undefined,
        ) ?? templateSection;
      const projectRange = project[section]?.[name];

      if (projectRange === undefined) {
        changes.push({ name, section, to: templateRange, kind: 'added' });
        continue;
      }

      const keep = (kind: DependencyKind): DependencyChange => ({
        name,
        section,
        from: projectRange,
        to: projectRange,
        kind,
      });

      if (projectRange === templateRange) {
        changes.push(keep('unchanged'));
        continue;
      }

      const projectFloor = rangeFloor(projectRange);
      const templateFloor = rangeFloor(templateRange);
      if (!projectFloor || !templateFloor) {
        changes.push(keep('unmanaged'));
        continue;
      }

      const installed = installedVersion(name);
      if (
        gt(projectFloor, templateFloor) ||
        (installed && gtr(installed, templateRange))
      ) {
        changes.push(keep('ahead'));
        continue;
      }

      // Devkit writes a dependency only when its floor rises, so a range
      // that differs by operator alone stays as it is
      if (projectFloor === templateFloor) {
        changes.push({ ...keep('unchanged'), reason: 'kept your range' });
        continue;
      }

      const current = installed ?? projectFloor;
      const advisory = advisories.find(
        (candidate) =>
          candidate.packageName === name &&
          lt(current, candidate.boundary) &&
          gte(templateFloor, candidate.boundary),
      );
      const risky =
        advisory !== undefined || !satisfies(templateFloor, projectRange);

      changes.push({
        name,
        section,
        from: projectRange,
        to: templateRange,
        kind: risky ? 'risky' : 'routine',
        ...(risky && { reason: advisory?.note ?? OUT_OF_RANGE_NOTE }),
        ...(advisory && { advisory }),
      });
    }
  }

  return changes;
}

/**
 * Reads the installed version of a package, searching `node_modules` from
 * `startDir` up to and including `stopDir` so that hoisted workspace installs
 * are found.
 */
export function findInstalledVersion(
  startDir: string,
  stopDir: string,
  packageName: string,
): string | undefined {
  const stop = resolve(stopDir);
  let dir = resolve(startDir);

  for (;;) {
    const manifest = join(dir, 'node_modules', packageName, 'package.json');
    if (existsSync(manifest)) {
      return (
        valid(JSON.parse(readFileSync(manifest, 'utf-8')).version) ?? undefined
      );
    }
    if (dir === stop || dirname(dir) === dir) {
      return undefined;
    }
    dir = dirname(dir);
  }
}
