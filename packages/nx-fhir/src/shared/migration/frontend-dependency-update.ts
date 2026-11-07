import {
  addDependenciesToPackageJson,
  detectPackageManager,
  joinPathFragments,
  logger,
  readJson,
  Tree,
} from '@nx/devkit';
import { select } from '@inquirer/prompts';
import { existsSync } from 'fs';
import { join } from 'path';
import { getFrontendDependencies } from '../../generators/frontend/frontend';
import { isDryRun } from '../utils/dry-run';
import { isRootWorkspaceMember } from '../utils/frontend-integration';
import { isInteractive } from '../utils/interactive';
import { getExecuteCommand, getInstallCommand } from '../utils/package-manager';
import { DEPENDENCY_ADVISORIES } from './dependency-advisories';
import {
  classifyDependencies,
  DependencyChange,
  findInstalledVersion,
} from './dependency-policy';
import { installDependencies } from './install-dependencies';
import {
  CHECK_SCRIPTS,
  CheckResult,
  compareChecks,
  runCommand,
  runProjectChecks,
} from './project-checks';
import { createVerificationCopy } from './verification-copy';
import { discardTreeChanges } from '../utils/discard-tree-changes';

type Answer = 'keep' | 'undo';

export interface UpdateDecision {
  decision: Answer | 'ask';
  defaultAnswer?: Answer;
  reason: 'no-question' | 'flag' | 'no-terminal' | 'user';
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

interface FixRun {
  command: string;
  files: string[];
  passed: boolean;
  output: string;
}

const WRITTEN_KINDS = new Set(['added', 'routine', 'risky']);

/**
 * One decision covers the whole update, because merged template code depends
 * on the new versions. A terminal is asked only when something is risky,
 * newly failing, or conflicted.
 */
export function decideUpdate(input: {
  riskyCount: number;
  newFailureCount: number;
  hasConflicts: boolean;
  acceptBreaking: boolean;
  interactive: boolean;
}): UpdateDecision {
  const { riskyCount, newFailureCount, hasConflicts } = input;
  if (riskyCount === 0 && newFailureCount === 0 && !hasConflicts) {
    return { decision: 'keep', reason: 'no-question' };
  }
  if (input.acceptBreaking) {
    return { decision: 'keep', reason: 'flag' };
  }
  if (!input.interactive) {
    return { decision: 'undo', reason: 'no-terminal' };
  }
  return {
    decision: 'ask',
    defaultAnswer: newFailureCount === 0 ? 'keep' : 'undo',
    reason: 'user',
  };
}

/**
 * Classifies the template dependencies against the project package.json in
 * the tree. Reads only, so an unattended run can skip before any merge.
 */
export function planDependencyChanges(
  tree: Tree,
  projectRoot: string,
  template: string,
): DependencyChange[] {
  const projectAbs = join(tree.root, projectRoot);
  return classifyDependencies(
    getFrontendDependencies(template),
    readJson<PackageJson>(tree, `${projectRoot}/package.json`),
    (name) => findInstalledVersion(projectAbs, tree.root, name),
    DEPENDENCY_ADVISORIES,
  );
}

function describeChange(change: DependencyChange): string {
  switch (change.kind) {
    case 'added':
      return `${change.name}: not present -> ${change.to}`;
    case 'routine':
      return `${change.name}: ${change.from} -> ${change.to}`;
    case 'risky':
      return `${change.name}: ${change.from} -> ${change.to} (risky: ${change.reason})`;
    case 'ahead':
      return `${change.name}: kept ${change.from}, ahead of the template`;
    case 'unmanaged':
      return `${change.name}: kept ${change.from}, not a semver range`;
    case 'unchanged':
      return change.reason ? `${change.name}: ${change.reason} ${change.from}` : '';
  }
}

/** Prints the dependency section of the report, shared with the pre-merge skip. */
export function printDependencyChanges(
  projectName: string,
  changes: DependencyChange[],
): void {
  const lines = changes.map(describeChange).filter((line) => line !== '');
  logger.info(`\nDependency changes for ${projectName}:`);
  if (lines.length === 0) {
    logger.info('  none');
  }
  for (const line of lines) {
    logger.info(`  ${line}`);
  }
}

function writeChanges(
  tree: Tree,
  projectRoot: string,
  changes: DependencyChange[],
): PackageJson {
  const written = changes.filter((change) => WRITTEN_KINDS.has(change.kind));
  const bySection = (section: DependencyChange['section']) =>
    Object.fromEntries(
      written
        .filter((change) => change.section === section)
        .map((change) => [change.name, change.to]),
    );
  const packageJsonPath = `${projectRoot}/package.json`;
  addDependenciesToPackageJson(
    tree,
    bySection('dependencies'),
    bySection('devDependencies'),
    packageJsonPath,
  );
  return readJson<PackageJson>(tree, packageJsonPath);
}

function hasWorkspaceRange(packageJson: PackageJson): boolean {
  return Object.values({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }).some((range) => range.startsWith('workspace:'));
}

function printChecks(
  baseline: CheckResult[] | undefined,
  after: CheckResult[],
  fixes: FixRun[],
): void {
  for (const fix of fixes) {
    logger.info(
      fix.passed
        ? `  fix ${fix.command}: ran`
        : `  fix ${fix.command}: failed\n${fix.output}`,
    );
  }
  const status = (result: CheckResult) => (result.passed ? 'passed' : 'failed');
  // Every script with a result on either side gets a line, so a baseline
  // that ran stays visible when the copy install stopped the checks
  const scripts = [...new Set([...(baseline ?? []), ...after].map((r) => r.script))];
  for (const script of scripts) {
    const before = baseline?.find((entry) => entry.script === script);
    const result = after.find((entry) => entry.script === script);
    const baselineStatus = before ? `baseline ${status(before)}` : 'no baseline';
    const afterStatus = result ? `after update ${status(result)}` : 'after update skipped';
    logger.info(`  ${script}: ${baselineStatus}, ${afterStatus}`);
  }
  const { newFailures, alreadyFailing } = compareChecks(baseline, after);
  // The output shows whether the cause of a failure moved with the update
  for (const result of alreadyFailing) {
    logger.info(
      `  ${result.script}: already failing before the update, output after the update:\n${result.output}`,
    );
  }
  for (const result of newFailures) {
    logger.info(`  ${result.script}: new failure\n${result.output}`);
  }
}

function printUndo(reason: UpdateDecision['reason']): void {
  logger.info(
    `\nDecision: undo (${reason}). Nothing from this run is written, a server update made in the same run included.`,
  );
  logger.info(
    'A combined run (nx g nx-fhir:update or nx migrate --run-migrations) can be repeated with Skip for the frontend to keep only the server update.',
  );
}

async function resolveDecision(decision: UpdateDecision): Promise<Answer> {
  if (decision.decision !== 'ask') {
    return decision.decision;
  }
  return select<Answer>({
    message: 'Keep this frontend update?',
    choices: [
      { name: 'Keep the update', value: 'keep' },
      { name: 'Undo the update', value: 'undo' },
    ],
    default: decision.defaultAnswer,
  });
}

/**
 * Applies the classified dependency changes, verifies them in a throwaway
 * copy of the project, and asks or decides whether to keep the update. Undo
 * takes every change of the generator run back out of the tree, so Nx
 * writes nothing and the run ends normally.
 */
export async function updateFrontendDependencies(options: {
  tree: Tree;
  projectName: string;
  projectRoot: string;
  changes: DependencyChange[];
  hasConflicts: boolean;
  acceptBreaking: boolean;
}): Promise<'kept' | 'dry-run' | 'undone'> {
  const { tree, projectName, projectRoot, changes, hasConflicts } = options;
  printDependencyChanges(projectName, changes);

  const packageJson = writeChanges(tree, projectRoot, changes);
  if (isDryRun()) {
    return 'dry-run';
  }

  const riskyCount = changes.filter((change) => change.kind === 'risky').length;
  const fixes = changes.flatMap((change) =>
    change.kind === 'risky' && change.advisory?.fix ? [change.advisory.fix] : [],
  );
  const decide = (newFailureCount: number) =>
    decideUpdate({
      riskyCount,
      newFailureCount,
      hasConflicts,
      acceptBreaking: options.acceptBreaking,
      interactive: isInteractive(),
    });
  const settle = async (
    decision: UpdateDecision,
    beforeKeep?: () => void,
  ): Promise<'kept' | 'undone'> => {
    if ((await resolveDecision(decision)) === 'undo') {
      printUndo(decision.reason);
      discardTreeChanges(tree);
      return 'undone';
    }
    beforeKeep?.();
    logger.info(`\nDecision: keep (${decision.reason}).`);
    await installDependencies(tree, projectRoot, packageJson);
    return 'kept';
  };

  if (hasConflicts) {
    logger.info(
      '\nThe merge has conflicts, so the checks and the fix commands did not run.',
    );
    if (fixes.length > 0) {
      const packageManager = detectPackageManager(tree.root);
      for (const fix of fixes) {
        logger.info(
          `  After resolving the conflicts, run: ${getExecuteCommand(packageManager, fix.command)}`,
        );
      }
    }
    logger.info('  Then run the build, check, and test scripts.');
    return settle(decide(0));
  }

  const scripts = packageJson.scripts;
  const hasChecks = CHECK_SCRIPTS.some((script) => scripts?.[script]);
  if (!hasChecks && fixes.length === 0) {
    return settle(decide(0));
  }

  const packageManager = detectPackageManager(tree.root);
  // Without installed modules every baseline script fails and hides what
  // the update breaks. Root modules count only for a root workspace member
  const projectAbs = join(tree.root, projectRoot);
  const hasModules =
    existsSync(join(projectAbs, 'node_modules')) ||
    ((await isRootWorkspaceMember(tree, projectRoot)) &&
      existsSync(join(tree.root, 'node_modules')));
  const baseline = hasModules
    ? await runProjectChecks(projectAbs, packageManager, scripts)
    : undefined;

  const copy = createVerificationCopy({ tree, projectRoot, packageJson });
  try {
    const fixRuns: FixRun[] = [];
    let after: CheckResult[];
    const install = await runCommand(getInstallCommand(packageManager), copy.dir);
    if (!install.passed) {
      // The copy sits outside the workspace, so a workspace range cannot resolve there
      const output = hasWorkspaceRange(packageJson)
        ? `${install.output}\nThe package.json has workspace: ranges, which cannot install outside the workspace and are the likely cause.`
        : install.output;
      after = [{ script: 'install', passed: false, output }];
    } else {
      for (const fix of fixes) {
        const command = getExecuteCommand(packageManager, fix.command);
        const result = await runCommand(command, copy.dir);
        fixRuns.push({ command, files: fix.files, ...result });
      }
      after = await runProjectChecks(copy.dir, packageManager, scripts);
    }

    logger.info('\nVerification in a copy of the project:');
    printChecks(baseline, after, fixRuns);
    const decision = decide(compareChecks(baseline, after).newFailures.length);
    // The checks verified the copy as the fixes left it, so the kept
    // project gets the declared files of every fix that ran, failed or not
    return await settle(decision, () => {
      for (const fix of fixRuns) {
        for (const file of fix.files) {
          const content = copy.readFile(file);
          if (content !== null) {
            tree.write(joinPathFragments(projectRoot, file), content);
          }
        }
      }
    });
  } finally {
    copy.dispose();
  }
}
