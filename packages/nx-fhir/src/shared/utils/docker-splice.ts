import { render } from 'ejs';
import { existsSync, readFileSync } from 'fs';
import { join, posix } from 'path';
import { starterImageZipUrl } from '../constants/versions';

/**
 * The text that a frontend adds to the HAPI starter's own Docker files.
 * Each value is LF text that ends with a newline.
 */
export interface DockerFragments {
  frontendStage: string;
  copyFrontend: string;
  dockerignoreLines: string;
}

/**
 * Renders the fragment templates in a `generators/frontend/files` directory.
 * Returns null when the directory has no `docker-fragments` folder, so a
 * migration from a plugin version without fragments has no old side and
 * skips.
 */
export function renderDockerFragments(
  filesDir: string,
  vars: Record<string, string | boolean>,
): DockerFragments | null {
  const fragmentsDir = join(filesDir, 'docker-fragments');
  if (!existsSync(fragmentsDir)) {
    return null;
  }

  const renderFragment = (name: string) =>
    render(readFileSync(join(fragmentsDir, `${name}.template`), 'utf-8'), vars);
  return {
    frontendStage: renderFragment('build-frontend-stage'),
    copyFrontend: renderFragment('copy-frontend'),
    dockerignoreLines: renderFragment('dockerignore-lines'),
  };
}

const FROM_LINE = /^FROM\s/i;
const COPY_SOURCE_LINE = /^COPY\s+(?:--\S+\s+)*src\/\s/i;
const COPY_FRONTEND_LINE = /^COPY\s+(?:--\S+\s+)*--from=build-frontend\s/i;
const WORKDIR_LINE = /^WORKDIR\s+(\S+)\s*$/i;

function stageLine(name: string): RegExp {
  return new RegExp(`^FROM\\s+.*\\s+AS\\s+${name}\\s*$`, 'i');
}

const FRONTEND_STAGE_LINE = stageLine('build-frontend');

/**
 * Splits text on its own line ending. A file with CRLF line endings keeps
 * them, so the splice changes only the lines it adds or removes.
 */
function splitLines(text: string): { eol: string; lines: string[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: text.split(eol) };
}

function fragmentLines(fragment: string): string[] {
  return fragment.replace(/\n$/, '').split('\n');
}

function findFrontendStage(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => FRONTEND_STAGE_LINE.test(line));
  if (start === -1) {
    return null;
  }

  const nextFrom = lines.findIndex((line, index) => index > start && FROM_LINE.test(line));
  return { start, end: nextFrom === -1 ? lines.length : nextFrom };
}

/**
 * Tells the combined Dockerfile, which builds the server in its own
 * `build-server` stage, from the starter's Dockerfile, which uses
 * `build-hapi`. Starter updates do not reach the server stages of the
 * combined file, so a migration warns its owner.
 */
export function isCombinedDockerfile(content: string): boolean {
  const { lines } = splitLines(content);
  const hasStage = (name: string) => lines.some((line) => stageLine(name).test(line));
  return hasStage('build-server') && !hasStage('build-hapi');
}

/**
 * Tells whether the frontend lines go into the starter's own Docker files.
 * The combined Dockerfile goes in the parent directory of the frontend. For
 * a server at the workspace root with the frontend directly beneath it, that
 * directory is the server root, which already holds the starter's Dockerfile.
 */
export function isServerRootLayout(serverRoot: string, frontendRoot: string): boolean {
  return serverRoot === '.' && posix.dirname(frontendRoot) === '.';
}

/**
 * Returns the starter's Dockerfile with the frontend build stage above the
 * first `FROM` line and the COPY of the frontend build after the
 * `COPY src/ ` line. Every other line keeps its exact bytes, so a later
 * three-way merge sees only starter changes in the starter's lines.
 *
 * Parser directives and global `ARG` lines must stay before every stage, so
 * the stage goes directly above the first `FROM` line.
 *
 * Returns null when the file has no `FROM` line or no `COPY src/ ` line,
 * because the splice has no anchor in such a file.
 */
export function insertFrontendLines(dockerfile: string, fragments: DockerFragments): string | null {
  const { eol, lines } = splitLines(dockerfile);
  const firstFrom = lines.findIndex((line) => FROM_LINE.test(line));
  const copySource = lines.findIndex((line) => COPY_SOURCE_LINE.test(line));

  if (firstFrom === -1 || copySource === -1) {
    return null;
  }

  // The COPY goes in first because the stage above it moves its index.
  lines.splice(copySource + 1, 0, ...fragmentLines(fragments.copyFrontend));
  lines.splice(firstFrom, 0, ...fragmentLines(fragments.frontendStage), '');
  return lines.join(eol);
}

/**
 * Returns the Dockerfile without the `build-frontend` stage and without
 * every `COPY --from=build-frontend` line. The stage runs from its `FROM`
 * line to the line before the next `FROM` line, or to the end of the file.
 * This gives back the starter's lines with the user's own changes, which
 * a migration uses as the common ground of its merge sides.
 *
 * Returns null when the file has no `build-frontend` stage, so a non-null
 * result also tells that the file has the stage.
 */
export function removeFrontendLines(dockerfile: string): string | null {
  const { eol, lines } = splitLines(dockerfile);
  const stage = findFrontendStage(lines);

  if (stage === null) {
    return null;
  }

  return lines
    .filter((line, index) => (index < stage.start || index >= stage.end) && !COPY_FRONTEND_LINE.test(line))
    .join(eol);
}

/**
 * Tells whether the `build-frontend` stage builds the frontend at
 * `frontendRoot`. Every rendered stage runs its build from a
 * `WORKDIR /app/<frontendRoot>` line, and that line stays when a user
 * deletes the COPY line of the frontend build. The image holds one frontend
 * stage, so the lines of a second frontend under the same server must not
 * replace it.
 */
export function frontendStageBuilds(dockerfile: string, frontendRoot: string): boolean {
  const { lines } = splitLines(dockerfile);
  const stage = findFrontendStage(lines);
  return (
    stage !== null &&
    lines.slice(stage.start, stage.end).some((line) => WORKDIR_LINE.exec(line)?.[1] === `/app/${frontendRoot}`)
  );
}

/**
 * Adds the frontend ignore lines at the end of a `.dockerignore`. The
 * starter's file has no final newline, so a newline goes in first to keep
 * its last line separate from the first added line.
 */
export function appendDockerignoreLines(content: string, lines: string): string {
  const { eol } = splitLines(content);
  const separator = content === '' || content.endsWith('\n') ? '' : eol;
  return content + separator + lines.replace(/\n/g, eol);
}

/**
 * Drops every line that exactly equals a non-empty line of `lines`. A line
 * that the user changed does not match, so it stays.
 */
export function removeDockerignoreLines(content: string, lines: string): string {
  const { eol, lines: contentLines } = splitLines(content);
  const added = new Set(fragmentLines(lines).filter((line) => line !== ''));
  return contentLines.filter((line) => !added.has(line)).join(eol);
}

/**
 * Builds the merge sides for a frontend template update from the project's
 * own Dockerfile. Both sides hold the user's changes, so the merge applies
 * only the change between the old and the new frontend lines.
 *
 * Returns null when the file has no `build-frontend` stage or when the
 * frontend lines have no anchor in what is left.
 */
export function dockerfileMergeSides(
  current: string,
  oldFragments: DockerFragments,
  newFragments: DockerFragments,
): { base: string; next: string } | null {
  const withoutFrontend = removeFrontendLines(current);
  if (withoutFrontend === null) {
    return null;
  }

  const base = insertFrontendLines(withoutFrontend, oldFragments);
  const next = insertFrontendLines(withoutFrontend, newFragments);
  return base === null || next === null ? null : { base, next };
}

/**
 * Tells the owner of a combined Dockerfile how to move to the starter's own
 * Dockerfile with the frontend lines added. The combined file has its own
 * server stages, so starter updates never reach them.
 */
export function legacyDockerWarning(release: string | undefined, fragments: DockerFragments): string[] {
  const download = release
    ? [`1. Download the HAPI starter for release ${release}:`, `   ${starterImageZipUrl(release)}`]
    : ["1. Download the HAPI starter for your server's HAPI release."];

  return [
    'The server stages in the combined Dockerfile do not get HAPI starter updates.',
    'To use the starter Dockerfile with the frontend build, do these steps:',
    ...download,
    '2. Keep a copy of the combined Dockerfile and .dockerignore, then replace them with the files from the starter.',
    '3. Reapply your own changes from Dockerfile.orig and .dockerignore.orig.',
    '   These files hold the starter files as they were when the frontend was added.',
    '4. Carry over, from that copy, any change you made to the combined files after the frontend was added.',
    '5. Add these lines above the first FROM line of the Dockerfile:',
    ...fragmentLines(fragments.frontendStage),
    '6. Add this line after the COPY src/ line of the Dockerfile:',
    ...fragmentLines(fragments.copyFrontend),
    '7. Add these lines at the end of .dockerignore:',
    ...fragmentLines(fragments.dockerignoreLines),
    '8. After the switch, you can delete Dockerfile.orig and .dockerignore.orig.',
  ];
}
