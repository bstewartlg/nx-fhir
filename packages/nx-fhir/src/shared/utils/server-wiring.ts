import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { readdirSync } from 'node:fs';
import * as path from 'path';
import { parse } from 'yaml';

const SERVER_FILES_DIR = path.join(
  __dirname,
  '..',
  '..',
  'generators',
  'server',
  'files',
);

const HAPI_STARTER_PACKAGE = 'ca.uhn.fhir.jpa.starter';

/** The class the HAPI starter boots from, and the fallback when detection finds none. */
const DEFAULT_APPLICATION_CLASS = `${HAPI_STARTER_PACKAGE}.Application`;

/**
 * Relative output paths a template directory produces, applying the same
 * `.template` strip and `__key__` file name substitution that generateFiles
 * applies, so a predicted path matches the file generateFiles writes.
 */
export function listTemplateOutputs(
  dir: string,
  substitutions: Record<string, string> = {},
  prefix = '',
): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listTemplateOutputs(
          path.join(dir, entry.name),
          substitutions,
          path.join(prefix, entry.name),
        )
      : [
          Object.entries(substitutions).reduce(
            (name, [key, value]) => name.split(`__${key}__`).join(value),
            path.join(prefix, entry.name.replace(/\.template$/, '')),
          ),
        ],
  );
}

function findApplicationClass(tree: Tree, dir: string): string | undefined {
  for (const child of tree.children(dir)) {
    const childPath = path.join(dir, child);
    if (!tree.isFile(childPath)) {
      const nested = findApplicationClass(tree, childPath);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (!child.endsWith('.java')) {
      continue;
    }
    const content = tree.read(childPath, 'utf-8') ?? '';
    const annotation = content.indexOf('@SpringBootApplication');
    if (annotation < 0) {
      continue;
    }
    const javaPackage = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1];
    const className = /\bclass\s+(\w+)/.exec(content.slice(annotation))?.[1];
    if (javaPackage && className) {
      return `${javaPackage}.${className}`;
    }
  }
  return undefined;
}

/**
 * Fully qualified name of the server's @SpringBootApplication class. A server
 * whose sources carry no such class falls back to the HAPI starter's own class.
 */
export function detectApplicationClass(tree: Tree, projectRoot: string): string {
  const javaRoot = path.join(projectRoot, 'src', 'main', 'java');
  const detected = tree.exists(javaRoot)
    ? findApplicationClass(tree, javaRoot)
    : undefined;
  return detected ?? DEFAULT_APPLICATION_CLASS;
}

/**
 * The packages application.yaml adds to the Spring component scan through
 * hapi.fhir.custom-bean-packages. The starter passes the property to
 * @ComponentScan as one value, so several packages are comma separated. A yaml
 * list is also accepted.
 */
function readCustomBeanPackages(tree: Tree, projectRoot: string): string[] {
  const configPath = path.join(
    projectRoot,
    'src',
    'main',
    'resources',
    'application.yaml',
  );
  const config = tree.read(configPath, 'utf-8');
  if (!config) {
    return [];
  }
  const value = parse(config)?.hapi?.fhir?.['custom-bean-packages'];
  const packages = Array.isArray(value) ? value : String(value ?? '').split(',');
  return packages.map((entry) => String(entry).trim()).filter(Boolean);
}

/**
 * Creates the shared base classes and the CustomServerConfig component scan
 * for a server that is missing any of them. Servers created by the server
 * generator ship with all of them; a server added by import-server has only a
 * project.json, and generated components need this wiring to compile and be
 * picked up by Spring. Files that already exist are never modified.
 */
export function ensureServerWiring(
  tree: Tree,
  project: { root: string; packageBase: string },
): void {
  const packagePath = project.packageBase.replace(/\./g, '/');
  const substitutions = { packageBase: project.packageBase };

  // CustomServerConfig carries the component scan of packageBase and lives in the starter
  // package, where Spring only reaches it when the application class sits there too. A
  // repackaged application picks the generated beans up only when packageBase is inside its
  // own scan root, so any other layout would wire up components nothing ever loads.
  // hapi.fhir.custom-bean-packages widens that scan root, so a package it names counts too.
  const applicationPackage = detectApplicationClass(tree, project.root).replace(
    /\.[^.]+$/,
    '',
  );
  const coversPackageBase = (scanRoot: string) =>
    project.packageBase === scanRoot ||
    project.packageBase.startsWith(`${scanRoot}.`);
  if (
    applicationPackage !== HAPI_STARTER_PACKAGE &&
    !coversPackageBase(applicationPackage) &&
    !readCustomBeanPackages(tree, project.root).some(coversPackageBase)
  ) {
    throw new Error(
      `The server application class is in package '${applicationPackage}', which does not cover the Java package base '${project.packageBase}'. ` +
        `Spring never loads the generated components from there. Pass --packageBase with a package at or under '${applicationPackage}', ` +
        `or add '${project.packageBase}' to hapi.fhir.custom-bean-packages in application.yaml.`,
    );
  }

  generateFiles(
    tree,
    path.join(SERVER_FILES_DIR, 'custom'),
    path.join(project.root, 'src', 'main', 'java', packagePath),
    substitutions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );
  generateFiles(
    tree,
    path.join(SERVER_FILES_DIR, 'hapi-starter'),
    project.root,
    substitutions,
    { overwriteStrategy: OverwriteStrategy.KeepExisting },
  );
}
