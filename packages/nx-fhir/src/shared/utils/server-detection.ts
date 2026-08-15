import { joinPathFragments, Tree } from '@nx/devkit';
import { XMLParser } from 'fast-xml-parser';
import { parseDocument } from 'yaml';
import { FhirVersion } from '../models';
import {
  HAPI_RELEASE_URLS,
  SUPPORTED_HAPI_VERSIONS,
} from '../constants/versions';

export interface DetectedServer {
  /** The directory the server lives in, relative to the workspace root ('.' for the root). */
  root: string;
  /** FHIR version read from application.yaml, if determinable. */
  fhirVersion?: FhirVersion;
  /** The supported HAPI release, set only when pom.xml identifies exactly one. */
  hapiReleaseVersion?: string;
  /** All supported HAPI releases the pom.xml could correspond to. */
  hapiReleaseCandidates: string[];
  /** The base version and starter revision the pom.xml declares, if present. */
  pomImage?: PomImageIdentity;
  /** Custom Java package base detected under src/main/java, if determinable. */
  packageBase?: string;
}

const POM_FILE = 'pom.xml';
const APPLICATION_YAML = 'src/main/resources/application.yaml';
const APPLICATION_YML = 'src/main/resources/application.yml';
const JAVA_SOURCE_ROOT = 'src/main/java';
const HAPI_STARTER_PACKAGE_PREFIX = 'ca.uhn.fhir';

function underRoot(root: string, relativePath: string): string {
  return !root || root === '.' ? relativePath : joinPathFragments(root, relativePath);
}

/**
 * Detects whether the given directory already contains a HAPI FHIR JPA Starter server.
 *
 * A directory qualifies when it has a pom.xml referencing HAPI FHIR alongside the
 * expected Spring Boot application config. Metadata (FHIR version, correlated HAPI
 * release, custom package) is populated on a best-effort basis for the caller to confirm.
 */
export function detectExistingServer(tree: Tree, dir: string): DetectedServer | null {
  const root = dir && dir.trim() !== '' ? dir : '.';

  const pomPath = underRoot(root, POM_FILE);
  if (!tree.exists(pomPath)) {
    return null;
  }

  const yamlPath = tree.exists(underRoot(root, APPLICATION_YAML))
    ? underRoot(root, APPLICATION_YAML)
    : tree.exists(underRoot(root, APPLICATION_YML))
      ? underRoot(root, APPLICATION_YML)
      : null;
  if (!yamlPath) {
    return null;
  }

  const pom = tree.read(pomPath, 'utf-8') ?? '';
  if (!/hapi-fhir|jpaserver/i.test(pom)) {
    return null;
  }

  const yaml = tree.read(yamlPath, 'utf-8') ?? '';

  const hapiReleaseCandidates = detectHapiReleaseCandidates(pom);

  return {
    root,
    fhirVersion: detectFhirVersionFromYaml(yaml),
    hapiReleaseVersion:
      hapiReleaseCandidates.length === 1 ? hapiReleaseCandidates[0] : undefined,
    hapiReleaseCandidates,
    pomImage: detectPomImageIdentity(pom),
    packageBase: detectPackageBase(tree, root),
  };
}

export interface PomImageIdentity {
  /** The hapi-fhir parent version base, for example "8.10.0". */
  base: string;
  /** The starter revision property value, absent in poms that predate it. */
  revision?: string;
  /** Set when the pom declares a revision whose value cannot be read. */
  revisionUnknown?: boolean;
}

/**
 * Parses a pom.xml and returns its project element. Values stay strings and
 * comments are dropped by the parser, so commented-out blocks cannot be read
 * as live configuration. Returns undefined for unparseable content.
 */
function parsePomProject(pom: string): Record<string, unknown> | undefined {
  try {
    const parsed = new XMLParser({ parseTagValue: false }).parse(pom);
    const project = parsed?.project;
    return project && typeof project === 'object' ? project : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const HAPI_GROUP_ID = 'ca.uhn.hapi.fhir';

/** Reads the parent version base and starter revision from a pom.xml. */
export function detectPomImageIdentity(
  pom: string,
): PomImageIdentity | undefined {
  const project = parsePomProject(pom);
  const parent = project?.parent as Record<string, unknown> | undefined;
  // Only a HAPI parent names the starter release; any other parent (for
  // example spring-boot-starter-parent) carries an unrelated version.
  if (stringValue(parent?.groupId) !== HAPI_GROUP_ID) {
    return undefined;
  }
  const parentVersion = stringValue(parent?.version);
  const base = parentVersion
    ? normalizeBaseVersion(parentVersion)
    : undefined;
  if (!base) {
    return undefined;
  }

  const properties = project?.properties as
    | Record<string, unknown>
    | undefined;
  const declared = stringValue(
    properties?.['hapi.fhir.jpa.server.starter.revision'],
  )?.trim();
  const propertyReference = declared?.match(/^\$\{([^}]+)\}$/);
  const revisionValue = propertyReference
    ? stringValue(properties?.[propertyReference[1]])?.trim() ?? declared
    : declared;
  const revision =
    revisionValue && /^\d+$/.test(revisionValue) ? revisionValue : undefined;

  if (declared && !revision) {
    // A declared revision that cannot be read names an unknown image.
    return { base, revisionUnknown: true };
  }
  return revision ? { base, revision } : { base };
}

/**
 * Collects the version of every element anywhere in a parsed pom whose
 * groupId names HAPI. Versions of unrelated coordinates never qualify as a
 * starter release candidate.
 */
function collectVersionValues(node: unknown, versions: string[]): string[] {
  if (!node || typeof node !== 'object') {
    return versions;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectVersionValues(entry, versions);
    }
    return versions;
  }
  const record = node as Record<string, unknown>;
  if (stringValue(record.groupId) === HAPI_GROUP_ID) {
    // A missing version is managed outside this pom; record it as
    // unparseable so the release stays ambiguous.
    versions.push(stringValue(record.version) ?? '');
  }
  for (const [key, value] of Object.entries(record)) {
    // Exclusions name coordinates without versions and carry no release
    // information.
    if (key === 'exclusions') {
      continue;
    }
    collectVersionValues(value, versions);
  }
  return versions;
}

function normalizeBaseVersion(raw: string): string | undefined {
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function supportedVersionsForBase(base: string): string[] {
  return SUPPORTED_HAPI_VERSIONS.filter((v) => v.split('-')[0] === base);
}

/** Maps a starter image version (the release tag without the "v") to its curated release. */
export const IMAGE_VERSION_TO_RELEASE: Record<string, string> = Object.fromEntries(
  Object.entries(HAPI_RELEASE_URLS).flatMap(([label, url]) => {
    const imageVersion = url.match(/image\/v([^/]+)\.zip$/)?.[1];
    return imageVersion ? [[imageVersion, label]] : [];
  }),
);

/**
 * Lists every supported starter release a pom.xml could correspond to.
 *
 * The starter pom names its image exactly: the hapi-fhir <parent> version is
 * the base and hapi.fhir.jpa.server.starter.revision is the image revision,
 * combining to the release tag (parent 8.4.0 + revision 2 = the v8.4.0-2
 * image). When both are present the result is that one release, or empty for
 * an unsupported image. A pom without the revision property falls back to
 * every supported release sharing the base version, which can be ambiguous.
 */
export function detectHapiReleaseCandidates(pom: string): string[] {
  if (!pom) {
    return [];
  }

  const identity = detectPomImageIdentity(pom);

  if (identity?.revision) {
    const release =
      IMAGE_VERSION_TO_RELEASE[`${identity.base}-${identity.revision}`];
    return release ? [release] : [];
  }

  // An unreadable revision names an unknown image; falling back to the base
  // alone could offer a release the pom does not describe.
  if (identity?.revisionUnknown) {
    return [];
  }

  // With a parent identity the base version is authoritative; scanning the
  // rest of the pom would let an unrelated dependency version masquerade as
  // the starter release. The full scan only runs when the pom names no
  // parent at all.
  const versions: string[] = [];
  const project = parsePomProject(pom);
  if (identity) {
    versions.push(identity.base);
  } else {
    collectVersionValues(project, versions);
  }

  // The result must not depend on XML ordering: distinct HAPI bases in one
  // pom leave the release ambiguous, so nothing is offered and the release
  // stays unrecorded until the user names it. Every base counts toward
  // ambiguity, including untested ones; an untested 7.6.0 next to a tested
  // 8.8.0 must not turn into a definitive 8.8.0 match. A version that still
  // cannot be parsed after property resolution could hide such a
  // disagreement, so it also leaves the release ambiguous.
  const properties = (project?.properties ?? {}) as Record<string, unknown>;
  const bases = new Set<string>();
  for (const version of versions) {
    const propertyReference = version.match(/^\$\{([^}]+)\}$/);
    const resolved = propertyReference
      ? stringValue(properties[propertyReference[1]]) ?? version
      : version;
    const base = normalizeBaseVersion(resolved);
    if (!base) {
      return [];
    }
    bases.add(base);
  }
  if (bases.size !== 1) {
    return [];
  }
  return supportedVersionsForBase([...bases][0]);
}

/**
 * Reads hapi.fhir.fhir_version from an application.yaml and validates it against the
 * supported FhirVersion enum. Handles both nested keys and a flat dotted key.
 */
export function detectFhirVersionFromYaml(yaml: string): FhirVersion | undefined {
  if (!yaml) {
    return undefined;
  }

  try {
    const doc = parseDocument(yaml);
    const nested = doc.getIn(['hapi', 'fhir', 'fhir_version']);
    const flat = doc.getIn(['hapi.fhir.fhir_version']);
    const raw = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined;
    if (!raw) {
      return undefined;
    }
    const candidate = raw.toUpperCase();
    if ((Object.values(FhirVersion) as string[]).includes(candidate)) {
      return candidate as FhirVersion;
    }
  } catch {
    // Unparseable config -> leave undefined for the caller to prompt.
  }

  return undefined;
}

function collectJavaPackages(tree: Tree, javaRoot: string): string[] {
  const packages = new Set<string>();

  const walk = (current: string) => {
    let containsJava = false;
    for (const child of tree.children(current)) {
      const childPath = joinPathFragments(current, child);
      if (tree.isFile(childPath)) {
        if (child.endsWith('.java')) {
          containsJava = true;
        }
      } else {
        walk(childPath);
      }
    }
    if (containsJava) {
      const relative = current.slice(javaRoot.length).replace(/^\/+/, '');
      if (relative) {
        packages.add(relative.replace(/\//g, '.'));
      }
    }
  };

  walk(javaRoot);
  return [...packages];
}

function longestCommonPackage(packages: string[]): string | undefined {
  if (packages.length === 0) {
    return undefined;
  }
  if (packages.length === 1) {
    return packages[0];
  }
  const segmented = packages.map((p) => p.split('.'));
  const [first, ...rest] = segmented;
  const prefix: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (rest.every((segments) => segments[i] === first[i])) {
      prefix.push(first[i]);
    } else {
      break;
    }
  }
  // A shared prefix of less than two segments (a bare "com" or "org") does
  // not identify the project's package; the caller falls back to asking.
  return prefix.length >= 2 ? prefix.join('.') : undefined;
}

/**
 * Best-effort detection of the custom Java package base: the common package prefix of all
 * source directories under src/main/java that are not part of the HAPI starter itself.
 */
export function detectPackageBase(tree: Tree, dir: string): string | undefined {
  const root = dir && dir.trim() !== '' ? dir : '.';
  const javaRoot = underRoot(root, JAVA_SOURCE_ROOT);
  if (!tree.exists(javaRoot)) {
    return undefined;
  }

  const customPackages = collectJavaPackages(tree, javaRoot).filter(
    (pkg) => !pkg.startsWith(HAPI_STARTER_PACKAGE_PREFIX),
  );

  return longestCommonPackage(customPackages);
}
