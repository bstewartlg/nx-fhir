import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { newTestFileSkipReason } from './new-test-files';

const projectRoot = 'frontend';
const subject = 'src/components/patient-header.tsx';
const testFile = 'src/components/patient-header.test.tsx';

describe('newTestFileSkipReason', () => {
  let tree: Tree;
  let oldDir: string;
  let newDir: string;

  const writeTemplateFile = (dir: string, path: string, content: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const skipReason = (relativePath: string) =>
    newTestFileSkipReason(relativePath, { tree, projectRoot, oldDir, newDir });

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    oldDir = mkdtempSync(join(tmpdir(), 'nx-fhir-test-files-old-'));
    newDir = mkdtempSync(join(tmpdir(), 'nx-fhir-test-files-new-'));
  });

  afterEach(() => {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('returns undefined for a file that is not a test', () => {
    writeTemplateFile(oldDir, 'src/lib/utils.ts', 'old\n');

    expect(skipReason('src/lib/utils.ts')).toBeUndefined();
  });

  it('adds a test whose subject is unchanged from the old template', () => {
    writeTemplateFile(oldDir, subject, 'template\n');
    writeTemplateFile(newDir, subject, 'template\n');
    tree.write(`${projectRoot}/${subject}`, 'template\n');

    expect(skipReason(testFile)).toBeUndefined();
  });

  it('skips a test whose subject the project edited to match the new template', () => {
    writeTemplateFile(oldDir, subject, 'old template\n');
    writeTemplateFile(newDir, subject, 'new template\n');
    tree.write(`${projectRoot}/${subject}`, 'new template\n');

    expect(skipReason(testFile)).toBe(
      'not added because you changed src/components/patient-header.tsx'
    );
  });

  it('skips a test whose subject the project changed', () => {
    writeTemplateFile(oldDir, subject, 'template\n');
    writeTemplateFile(newDir, subject, 'template\n');
    tree.write(`${projectRoot}/${subject}`, 'user rewrite\n');

    expect(skipReason(testFile)).toBe(
      'not added because you changed src/components/patient-header.tsx'
    );
  });

  it('skips a test whose subject the project removed', () => {
    writeTemplateFile(oldDir, subject, 'template\n');
    writeTemplateFile(newDir, subject, 'template\n');

    expect(skipReason(testFile)).toBe(
      'not added because src/components/patient-header.tsx is missing'
    );
  });

  it('adds a test whose subject is also new in this template', () => {
    writeTemplateFile(newDir, subject, 'template\n');

    expect(skipReason(testFile)).toBeUndefined();
  });

  it('adds a test whose new subject the project already has with the template bytes', () => {
    writeTemplateFile(newDir, subject, 'template\n');
    tree.write(`${projectRoot}/${subject}`, 'template\n');

    expect(skipReason(testFile)).toBeUndefined();
  });

  it('skips a test whose new subject the project already has with other bytes', () => {
    writeTemplateFile(newDir, subject, 'template\n');
    tree.write(`${projectRoot}/${subject}`, 'project widget\n');

    expect(skipReason(testFile)).toBe(
      'not added because you already have a different src/components/patient-header.tsx'
    );
  });

  it('recognizes .spec and .test before ts, tsx, js, and jsx', () => {
    const subjects: Record<string, string> = {
      'src/a.spec.ts': 'src/a.ts',
      'src/b.test.jsx': 'src/b.jsx',
      'src/c.test.tsx': 'src/c.tsx',
      'src/d.spec.js': 'src/d.js',
    };
    for (const subjectPath of Object.values(subjects)) {
      writeTemplateFile(oldDir, subjectPath, 'template\n');
    }

    for (const [testPath, subjectPath] of Object.entries(subjects)) {
      expect(skipReason(testPath)).toBe(
        `not added because ${subjectPath} is missing`
      );
    }
  });
});
