import { logger, Tree } from '@nx/devkit';
import { join, relative } from 'path';
import { readdirSync, statSync, readFileSync } from 'fs';
import { isDeepStrictEqual } from 'util';
import { diffLines } from 'diff';
import { diff3Merge } from 'node-diff3';
import { parse as parseYaml } from 'yaml';

export interface Diff3Conflict {
  a: string[];
  aIndex: number;
  o: string[];
  oIndex: number;
  b: string[];
  bIndex: number;
}

export interface MergeResult {
  path: string;
  status: 'unchanged' | 'added' | 'removed' | 'merged' | 'conflict';
  content?: string;
  conflicts?: Diff3Conflict[];
}

export interface MigrationSummary {
  added: number;
  removed: number;
  merged: number;
  conflicts: number;
  unchanged: number;
  results: MergeResult[];
}

/**
 * Recursively get all files in a directory. Returned paths are relative.
 */
export function getAllFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      files.push(relative(baseDir, fullPath));
    }
  }

  return files;
}

/**
 * All merge comparisons run on LF text; toLf brings each side there. The
 * written result is converted back to the working copy's own line endings,
 * so a CRLF checkout neither reads as a fully edited file nor comes out of
 * a migration rewritten to LF.
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Collapses runs of spaces and tabs and trims the result, one line at a time.
 *
 * Carriage returns are left alone; merge callers compare LF text, and for
 * any other caller a line ending difference is a real change.
 */
function normalizeWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/^ | $/g, ''))
    .join('\n');
}

/**
 * Returns `current` with every change that is whitespace only reverted to the
 * base text.
 *
 * Editors, formatters and serializers rewrite indentation and comment
 * alignment without changing meaning. A line based merge cannot tell such a
 * rewrite apart from a real edit, so it conflicts whenever the new version
 * touches the same region. Reverting the whitespace only changes first leaves
 * the merge with the semantic edits alone, and returns every other region to
 * the exact upstream bytes.
 *
 * A line is only reverted when it holds the same content once the whitespace
 * inside it is collapsed. This is a text level heuristic and cannot see
 * language semantics, so merge callers must go through
 * discardVerifiedWhitespaceOnlyEdits, which parser-checks the result.
 */
export function discardWhitespaceOnlyEdits(
  base: string,
  current: string
): string {
  if (base === current) {
    return current;
  }

  const parts = diffLines(base, current);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (!part.added && !part.removed) {
      result.push(part.value);
      continue;
    }

    if (part.removed) {
      const replacement = parts[i + 1];
      const baseLines = part.value.split('\n');
      const currentLines = replacement?.added
        ? replacement.value.split('\n')
        : [];

      // Only a replacement of the same shape can be judged line by line.
      // Anything else is a real insertion or deletion.
      if (currentLines.length !== baseLines.length) {
        continue;
      }

      result.push(
        baseLines
          .map((baseLine, index) =>
            normalizeWhitespace(baseLine) ===
            normalizeWhitespace(currentLines[index])
              ? baseLine
              : currentLines[index]
          )
          .join('\n')
      );
      i++;
      continue;
    }

    result.push(part.value);
  }

  return result.join('');
}

/**
 * The subset of the prettier API the formatting probe needs. Prettier is not a
 * dependency of this plugin; it is resolved from the workspace the generator
 * runs in, so the shape is declared here instead of imported.
 */
interface PrettierApi {
  format(source: string, options: { parser: string }): Promise<string>;
  getFileInfo(filePath: string): Promise<{ inferredParser: string | null }>;
}

/**
 * Loads prettier from the workspace. Prettier v3 exposes its API as named
 * exports, v2 exposes it under `.default`. Returns null when prettier is not
 * installed.
 */
async function importPrettier(): Promise<PrettierApi | null> {
  try {
    const imported = (await import('prettier')) as Partial<PrettierApi> & {
      default?: PrettierApi;
    };
    return imported.getFileInfo ? (imported as PrettierApi) : (imported.default ?? null);
  } catch {
    return null;
  }
}

/**
 * Reports whether `current` differs from `base` by formatting alone.
 *
 * Workspaces created before the generators stopped running prettier over
 * vendored and template content hold files that differ from the merge base by
 * formatting only. Those files carry no user edit, so the caller can take the
 * incoming content instead of merging noise.
 *
 * Both sides are formatted in the same call with the same fixed options rather
 * than with the workspace prettier configuration. The answer therefore never
 * depends on how the workspace is configured, and a prettier upgrade cannot
 * change the outcome of a comparison that already happened. Anything prettier
 * cannot parse, and any formatting error, reports false so the caller falls
 * back to the normal three-way merge.
 */
export async function isFormattingOnlyDifference(
  base: string,
  current: string,
  filePath: string
): Promise<boolean> {
  const prettier = await importPrettier();
  if (!prettier) {
    return false;
  }

  try {
    const { inferredParser } = await prettier.getFileInfo(filePath);
    if (!inferredParser) {
      return false;
    }

    const options = { parser: inferredParser };
    const [formattedBase, formattedCurrent] = await Promise.all([
      prettier.format(base, options),
      prettier.format(current, options),
    ]);

    return formattedBase === formattedCurrent;
  } catch {
    return false;
  }
}

/**
 * Reports whether two YAML documents parse to the same data. Comments and
 * layout do not take part in the comparison. Any parse failure reports false.
 */
function isSameYamlDocument(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(parseYaml(a), parseYaml(b));
  } catch {
    return false;
  }
}

/**
 * Returns `current` with whitespace only edits reverted to the base text,
 * but only when a parser confirms the reverted text still means the same
 * thing as `current`. Whitespace can be meaning: YAML nesting depends on
 * indentation and quoted strings contain their spacing. YAML files are
 * parsed and compared as data, everything else goes through the prettier
 * probe, and without a parser verdict `current` is returned untouched.
 */
export async function discardVerifiedWhitespaceOnlyEdits(
  base: string,
  current: string,
  filePath: string
): Promise<string> {
  const healed = discardWhitespaceOnlyEdits(base, current);
  if (healed === current) {
    return current;
  }

  if (/\.ya?ml$/i.test(filePath)) {
    return isSameYamlDocument(healed, current) ? healed : current;
  }

  return (await isFormattingOnlyDifference(healed, current, filePath))
    ? healed
    : current;
}

/**
 * Content is binary when it does not survive a UTF-8 round trip, or when it
 * holds NUL bytes, which round-trip but mark formats whose 0x0D 0x0A bytes
 * are data rather than line endings.
 */
function isBinaryContent(buffer: Buffer): boolean {
  return (
    buffer.includes(0) ||
    !Buffer.from(buffer.toString('utf-8'), 'utf-8').equals(buffer)
  );
}

/**
 * Perform 3-way merge on a file
 */
export function threeWayMerge(
  baseContent: string,
  currentContent: string,
  newContent: string,
  filePath: string
): MergeResult {
  // Split content into lines for diff3
  const baseLines = baseContent.split('\n');
  const currentLines = currentContent.split('\n');
  const newLines = newContent.split('\n');

  // Perform 3-way merge
  const mergeResult = diff3Merge(currentLines, baseLines, newLines);

  // Check if there are conflicts
  const conflicts: Diff3Conflict[] = [];
  const mergedLines: string[] = [];
  let hasConflicts = false;

  for (const chunk of mergeResult) {
    if (chunk.ok) {
      // No conflict, use the merged content
      mergedLines.push(...chunk.ok);
    } else if (chunk.conflict) {
      // Conflict detected
      hasConflicts = true;
      const conflict: Diff3Conflict = {
        a: chunk.conflict.a,
        aIndex: chunk.conflict.aIndex,
        o: chunk.conflict.o,
        oIndex: chunk.conflict.oIndex,
        b: chunk.conflict.b,
        bIndex: chunk.conflict.bIndex,
      };
      conflicts.push(conflict);

      // Add conflict markers
      mergedLines.push('<<<<<<< CURRENT (Your changes)');
      mergedLines.push(...chunk.conflict.a);
      mergedLines.push('||||||| BASE');
      mergedLines.push(...chunk.conflict.o);
      mergedLines.push('=======');
      mergedLines.push(...chunk.conflict.b);
      mergedLines.push('>>>>>>> NEW');
    }
  }

  return {
    path: filePath,
    status: hasConflicts ? 'conflict' : 'merged',
    content: mergedLines.join('\n'),
    conflicts: hasConflicts ? conflicts : undefined,
  };
}

/**
 * Perform a three-way merge migration between two versions
 * 
 * @param tree The Nx tree to write changes to
 * @param projectRoot The root path of the project being migrated
 * @param oldVersionDir The temporary directory containing the old version files
 * @param newVersionDir The temporary directory containing the new version files
 * @param oldVersion The old version name (for logging)
 * @param newVersion The new version name (for logging)
 * @returns Migration summary with counts and results
 */
export async function migrateWithThreeWayMerge(
  tree: Tree,
  projectRoot: string,
  oldVersionDir: string,
  newVersionDir: string,
  oldVersion: string,
  newVersion: string
): Promise<MigrationSummary> {
  // Get all files from both versions
  const oldFiles = new Set(getAllFiles(oldVersionDir));
  const newFiles = new Set(getAllFiles(newVersionDir));
  const allFiles = new Set([...oldFiles, ...newFiles]);

  const results: MergeResult[] = [];
  let conflictCount = 0;
  let mergedCount = 0;
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  // Process each file
  for (const relativePath of allFiles) {
    const oldFilePath = join(oldVersionDir, relativePath);
    const newFilePath = join(newVersionDir, relativePath);
    const currentFilePath = join(projectRoot, relativePath);

    const existsInOld = oldFiles.has(relativePath);
    const existsInNew = newFiles.has(relativePath);
    const existsInCurrent = tree.exists(currentFilePath);

    // File was removed in new version
    if (existsInOld && !existsInNew) {
      if (existsInCurrent) {
        // UTF-8 decoding maps distinct binary bytes to the same text, so
        // modification is decided on bytes first. Text files then discount
        // whitespace-only and line ending differences.
        const oldBuffer = readFileSync(oldFilePath);
        const currentBuffer = tree.read(currentFilePath) ?? oldBuffer;
        let isModified = !currentBuffer.equals(oldBuffer);
        if (
          isModified &&
          !isBinaryContent(oldBuffer) &&
          !isBinaryContent(currentBuffer)
        ) {
          const oldContent = toLf(oldBuffer.toString('utf-8'));
          const currentContent = await discardVerifiedWhitespaceOnlyEdits(
            oldContent,
            toLf(currentBuffer.toString('utf-8')),
            relativePath
          );
          isModified = oldContent !== currentContent;
        }

        if (isModified) {
          logger.warn(
            `⚠️  File removed in ${newVersion} but you modified it: ${relativePath}`
          );
          logger.warn('    Keeping your modified version.');
          results.push({ path: relativePath, status: 'unchanged' });
          unchangedCount++;
        } else {
          logger.info(
            `🗑️  Removing file (deleted in ${newVersion}): ${relativePath}`
          );
          tree.delete(currentFilePath);
          results.push({ path: relativePath, status: 'removed' });
          removedCount++;
        }
      }
      continue;
    }

    // File is new in the new version
    if (!existsInOld && existsInNew) {
      logger.info(`✨ Adding new file: ${relativePath}`);
      const newContent = readFileSync(newFilePath);
      tree.write(currentFilePath, newContent);
      results.push({ path: relativePath, status: 'added' });
      addedCount++;
      continue;
    }

    // File exists in both versions - need to check for changes and merge
    if (existsInOld && existsInNew) {
      const oldBuffer = readFileSync(oldFilePath);
      const newBuffer = readFileSync(newFilePath);
      const currentBuffer = existsInCurrent
        ? tree.read(currentFilePath) ?? oldBuffer
        : oldBuffer;

      // Byte-identical sides need no merge and no write, so an unchanged
      // file, text or binary, is never re-encoded or rewritten.
      if (oldBuffer.equals(newBuffer) && currentBuffer.equals(oldBuffer)) {
        unchangedCount++;
        continue;
      }

      // A line-based text merge re-encodes binary content through UTF-8 and
      // corrupts it, so binary files are compared and written as bytes.
      const isBinary = [oldBuffer, newBuffer, currentBuffer].some(
        isBinaryContent
      );
      if (isBinary) {
        if (currentBuffer.equals(oldBuffer)) {
          logger.info(`🔀 Updating binary file: ${relativePath}`);
          tree.write(currentFilePath, newBuffer);
          results.push({ path: relativePath, status: 'merged' });
          mergedCount++;
        } else if (oldBuffer.equals(newBuffer)) {
          unchangedCount++;
        } else {
          logger.warn(
            `⚠️  Binary file changed in ${newVersion} and locally: ${relativePath}`
          );
          logger.warn(
            '    Keeping your version. Apply the upstream file manually if needed.'
          );
          results.push({ path: relativePath, status: 'unchanged' });
          unchangedCount++;
        }
        continue;
      }

      const rawCurrentContent = currentBuffer.toString('utf-8');
      // Comparison and merging happen on LF text; written results keep the
      // working copy's line endings. A file only counts as CRLF when every
      // line ending is CRLF; converting a mixed file back would rewrite
      // line endings the merge never touched.
      const usesCrlf =
        rawCurrentContent.includes('\r\n') &&
        !rawCurrentContent.replace(/\r\n/g, '').includes('\n');
      const restoreEol = (text: string): string =>
        usesCrlf ? text.replace(/\r?\n/g, '\r\n') : text;
      const oldContent = toLf(oldBuffer.toString('utf-8'));
      const newContent = toLf(newBuffer.toString('utf-8'));
      // Reverting reformatting keeps it out of the merge, where it would
      // otherwise collide with an upstream edit in the same region.
      const currentContent = await discardVerifiedWhitespaceOnlyEdits(
        oldContent,
        toLf(rawCurrentContent),
        relativePath
      );

      // Check if file changed between versions
      const baseToNewDiff = diffLines(oldContent, newContent);
      const hasUpstreamChanges = baseToNewDiff.some(
        (part) => part.added || part.removed
      );

      // Check if user modified the file
      const baseToCurrentDiff = diffLines(oldContent, currentContent);
      let hasUserChanges = baseToCurrentDiff.some(
        (part) => part.added || part.removed
      );

      // What is left may still be a whole file reformat that collapsing
      // whitespace cannot recognise, such as changed quoting or rewrapped
      // lines. Prettier answers that for the file types it can parse.
      if (
        hasUserChanges &&
        (await isFormattingOnlyDifference(
          oldContent,
          currentContent,
          relativePath
        ))
      ) {
        logger.info(`🧹 Discarding formatting-only changes: ${relativePath}`);
        hasUserChanges = false;
      }

      if (!hasUserChanges) {
        // Nothing to preserve, so the new content is what belongs on disk.
        // Writing it also restores the upstream bytes, which keeps the next
        // migration free of the same noise.
        const desiredContent = restoreEol(newContent);
        if (rawCurrentContent === desiredContent) {
          unchangedCount++;
        } else {
          tree.write(currentFilePath, desiredContent);
          results.push({ path: relativePath, status: 'merged' });
          mergedCount++;
        }
        continue;
      }

      if (!hasUpstreamChanges) {
        // Only the user changed the file, so keep their version with the
        // reformatting reverted
        logger.info(`✓ Keeping user changes: ${relativePath}`);
        const desiredContent = restoreEol(currentContent);
        if (rawCurrentContent !== desiredContent) {
          tree.write(currentFilePath, desiredContent);
        }
        unchangedCount++;
        continue;
      }

      // Both changed - need 3-way merge
      logger.info(`🔀 3-way merging: ${relativePath}`);
      const mergeResult = threeWayMerge(
        oldContent,
        currentContent,
        newContent,
        relativePath
      );

      tree.write(currentFilePath, restoreEol(mergeResult.content ?? ''));
      results.push(mergeResult);

      if (mergeResult.status === 'conflict') {
        conflictCount++;
        logger.warn(
          `⚠️  CONFLICT in ${relativePath} - ${mergeResult.conflicts?.length ?? 0} conflict(s)`
        );
        logger.warn('    Review and resolve conflict markers in the file.');
      } else {
        mergedCount++;
      }
    }
  }

  return {
    added: addedCount,
    removed: removedCount,
    merged: mergedCount,
    conflicts: conflictCount,
    unchanged: unchangedCount,
    results,
  };
}

/**
 * Log a migration summary
 */
export function logMigrationSummary(
  summary: MigrationSummary,
  oldVersion: string,
  newVersion: string
): void {
  logger.info('\n📊 Migration Summary:');
  logger.info(`  ✨ Added: ${summary.added} files`);
  logger.info(`  🗑️ Removed: ${summary.removed} files`);
  logger.info(`  🔀 Merged: ${summary.merged} files`);
  logger.info(`  ⚠️ Conflicts: ${summary.conflicts} files`);
  logger.info(`  ☑️ Unchanged: ${summary.unchanged} files`);

  if (summary.conflicts > 0) {
    logger.warn('\n⚠️  WARNING: Merge conflicts detected!');
    logger.warn('You must manually resolve conflicts in the following files:');
    summary.results
      .filter((r) => r.status === 'conflict')
      .forEach((r) => logger.warn(`  - ${r.path}`));
    logger.warn('\nLook for conflict markers:');
    logger.warn('  <<<<<<< CURRENT (Your changes)');
    logger.warn(`  ||||||| BASE (${oldVersion})`);
    logger.warn('  =======');
    logger.warn(`  >>>>>>> NEW (${newVersion})`);
  }
}
