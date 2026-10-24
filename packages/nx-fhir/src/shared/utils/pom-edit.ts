import { Tree } from '@nx/devkit';

const DEFAULT_INDENT_UNIT = '    ';

function indentOf(text: string): string {
  return text.slice(0, text.length - text.trimStart().length);
}

function lineStartOf(pom: string, index: number): number {
  return pom.lastIndexOf('\n', index - 1) + 1;
}

/** The first `<tag>value</tag>` text in a snippet, used as its identity in the pom. */
function firstElement(xml: string, tag: string): string {
  const element = new RegExp(`<${tag}>[^<]*</${tag}>`).exec(xml)?.[0];
  if (!element) {
    throw new Error(`The pom snippet has no <${tag}> element: ${xml}`);
  }
  return element;
}

/**
 * Re-indents a snippet so its outermost lines start at `indent`. The snippet's
 * own nesting is kept, and its common margin and blank edge lines are dropped,
 * so callers may pass an indented template literal.
 */
function indentSnippet(xml: string, indent: string): string {
  const lines = xml
    .replace(/^\s*\n/, '')
    .trimEnd()
    .split('\n');
  const margin = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => indentOf(line).length),
  );
  return lines
    .map((line) => (line.trim() ? indent + line.slice(margin) : ''))
    .join('\n');
}

/**
 * Inserts `xml` as the last child of the element that opens at `open` and
 * closes at `close`, indented like the first existing `childTag` in it. The pom
 * is edited as text so every byte outside the insertion stays identical to the
 * starter, which the update-server three-way merge diffs against.
 */
function insertChild(
  pom: string,
  open: number,
  close: number,
  childTag: string,
  xml: string,
): string {
  const closeLineStart = lineStartOf(pom, close);
  const closeLead = pom.slice(closeLineStart, close);
  const closeIndent = indentOf(closeLead);
  const child = pom.indexOf(childTag, open);
  const childIndent =
    child >= 0 && child < close
      ? indentOf(pom.slice(lineStartOf(pom, child), child))
      : '';
  const block = indentSnippet(
    xml,
    childIndent.length > closeIndent.length
      ? childIndent
      : closeIndent + DEFAULT_INDENT_UNIT,
  );
  // A close tag that shares its line with other markup, such as
  // <dependencies></dependencies>, is split onto its own line.
  return closeLead.trim()
    ? `${pom.slice(0, close)}\n${block}\n${closeIndent}${pom.slice(close)}`
    : `${pom.slice(0, closeLineStart)}${block}\n${pom.slice(closeLineStart)}`;
}

/**
 * Adds a `<dependency>` element to the project-level `<dependencies>` of a
 * pom. Returns false, writing nothing, when that block already names the
 * snippet's artifactId outside an XML comment.
 */
export function addPomDependency(
  tree: Tree,
  pomPath: string,
  dependencyXml: string,
): boolean {
  const artifactId = firstElement(dependencyXml, 'artifactId');
  const pom = tree.read(pomPath, 'utf-8') ?? '';
  // Plugin and profile dependency lists follow <build>, so the project list is
  // the last one before it. A dependencyManagement list there is not a target:
  // a dependency without a version is invalid in it.
  const build = pom.indexOf('<build>');
  const limit = build < 0 ? pom.length : build;
  const close = pom.lastIndexOf('</dependencies>', limit);
  if (close < 0 || close < pom.lastIndexOf('</dependencyManagement>', limit)) {
    throw new Error(
      `Cannot add ${artifactId} to ${pomPath}: there is no project <dependencies> element before <build>. ` +
        'Add an empty <dependencies></dependencies> element after </dependencyManagement> and run the generator again.',
    );
  }
  const open = pom.lastIndexOf('<dependencies>', close);
  const uncommented = pom.slice(open, close).replace(/<!--[\s\S]*?-->/g, '');
  if (uncommented.includes(artifactId)) {
    return false;
  }
  tree.write(
    pomPath,
    insertChild(pom, open, close, '<dependency>', dependencyXml),
  );
  return true;
}
