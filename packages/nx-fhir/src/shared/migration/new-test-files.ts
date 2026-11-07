import { joinPathFragments, Tree } from '@nx/devkit';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_FILE = /\.(test|spec)(\.(ts|tsx|js|jsx))$/;

/**
 * A new template test written beside a subject the project changed tests
 * the template's code, not the project's, and fails. Returns the reason to
 * leave such a test out, or undefined to add it.
 *
 * The decision reads the project subject from the tree, so call it before
 * the merge writes the new template into that tree.
 */
export function newTestFileSkipReason(
  relativePath: string,
  context: { tree: Tree; projectRoot: string; oldDir: string; newDir: string }
): string | undefined {
  if (!TEST_FILE.test(relativePath)) {
    return undefined;
  }
  const subject = relativePath.replace(TEST_FILE, '$2');
  const projectSubject = context.tree.read(
    joinPathFragments(context.projectRoot, subject)
  );

  const oldSubjectPath = join(context.oldDir, subject);
  if (existsSync(oldSubjectPath)) {
    if (!projectSubject) {
      return `not added because ${subject} is missing`;
    }
    if (!projectSubject.equals(readFileSync(oldSubjectPath))) {
      return `not added because you changed ${subject}`;
    }
    return undefined;
  }

  if (!projectSubject) {
    return undefined;
  }
  // The merge keeps a file the project already has at the path of a new
  // template file, so the template test would run against project code.
  const newSubjectPath = join(context.newDir, subject);
  if (
    !existsSync(newSubjectPath) ||
    !projectSubject.equals(readFileSync(newSubjectPath))
  ) {
    return `not added because you already have a different ${subject}`;
  }
  return undefined;
}
