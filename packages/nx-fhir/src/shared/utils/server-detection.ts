import { joinPathFragments, Tree } from '@nx/devkit';
import { parseDocument } from 'yaml';
import { FhirVersion } from '../models';
import { SUPPORTED_HAPI_VERSIONS } from '../constants/versions';

export interface DetectedServer {
  /** The directory the server lives in, relative to the workspace root ('.' for the root). */
  root: string;
  /** FHIR version read from application.yaml, if determinable. */
  fhirVersion?: FhirVersion;
  /** Supported HAPI release correlated from pom.xml, if determinable. */
  hapiReleaseVersion?: string;
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

  return {
    root,
    fhirVersion: detectFhirVersionFromYaml(yaml),
    hapiReleaseVersion: detectHapiVersionFromPom(pom),
    packageBase: detectPackageBase(tree, root),
  };
}

function normalizeBaseVersion(raw: string): string | undefined {
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function correlateToSupportedVersion(raw: string): string | undefined {
  const base = normalizeBaseVersion(raw);
  if (!base) {
    return undefined;
  }
  const matches = SUPPORTED_HAPI_VERSIONS.filter((v) => v.split('-')[0] === base);
  if (matches.length === 0) {
    return undefined;
  }
  // Prefer an exact base match (e.g. "8.4.0"), otherwise the highest suffixed variant.
  return matches.find((v) => v === base) ?? matches[matches.length - 1];
}

/**
 * Best-effort extraction of the HAPI release from a pom.xml, correlated to a supported
 * starter release. Prefers the <parent> version (the hapi-fhir line), then falls back to
 * scanning all <version> tags. Returns undefined when nothing correlates.
 */
export function detectHapiVersionFromPom(pom: string): string | undefined {
  if (!pom) {
    return undefined;
  }

  const candidates: string[] = [];

  const parentBlock = pom.match(/<parent>([\s\S]*?)<\/parent>/i);
  if (parentBlock) {
    const parentVersion = parentBlock[1].match(/<version>\s*([^<\s]+)\s*<\/version>/i);
    if (parentVersion) {
      candidates.push(parentVersion[1]);
    }
  }

  for (const match of pom.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/gi)) {
    candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    const correlated = correlateToSupportedVersion(candidate);
    if (correlated) {
      return correlated;
    }
  }

  return undefined;
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
  return prefix.length > 0 ? prefix.join('.') : packages[0];
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
