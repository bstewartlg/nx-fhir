import { logger, Tree } from '@nx/devkit';
import { join, relative } from 'path';
import { readdirSync, statSync, readFileSync } from 'fs';
import { diffLines } from 'diff';
import { diff3Merge } from 'node-diff3';

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
    } else {
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
export function migrateWithThreeWayMerge(
  tree: Tree,
  projectRoot: string,
  oldVersionDir: string,
  newVersionDir: string,
  oldVersion: string,
  newVersion: string
): MigrationSummary {
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
        // Check if user modified it
        const oldContent = readFileSync(oldFilePath, 'utf-8');
        const currentContent = tree.read(currentFilePath, 'utf-8');

        if (oldContent !== currentContent) {
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
      const oldContent = readFileSync(oldFilePath, 'utf-8');
      const newContent = readFileSync(newFilePath, 'utf-8');
      const currentContent = existsInCurrent
        ? tree.read(currentFilePath, 'utf-8')
        : oldContent;

      // Check if file changed between versions
      const baseToNewDiff = diffLines(oldContent, newContent);
      const hasUpstreamChanges = baseToNewDiff.some(
        (part) => part.added || part.removed
      );

      // Check if user modified the file
      const baseToCurrentDiff = diffLines(oldContent, currentContent);
      const hasUserChanges = baseToCurrentDiff.some(
        (part) => part.added || part.removed
      );

      if (!hasUpstreamChanges && !hasUserChanges) {
        // No changes anywhere, skip
        unchangedCount++;
        continue;
      }

      if (hasUpstreamChanges && !hasUserChanges) {
        // Only upstream changed, take new version
        // logger.info(`📝 Updating file (no user changes): ${relativePath}`);
        tree.write(currentFilePath, newContent);
        results.push({ path: relativePath, status: 'merged' });
        mergedCount++;
        continue;
      }

      if (!hasUpstreamChanges && hasUserChanges) {
        // Only user changed, keep current
        logger.info(`✓ Keeping user changes: ${relativePath}`);
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

      tree.write(currentFilePath, mergeResult.content!);
      results.push(mergeResult);

      if (mergeResult.status === 'conflict') {
        conflictCount++;
        logger.warn(
          `⚠️  CONFLICT in ${relativePath} - ${mergeResult.conflicts!.length} conflict(s)`
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
