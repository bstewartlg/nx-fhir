export const PLUGIN_VERSION = require('../../../package.json').version;

export const SUPPORTED_PACKAGE_MANAGERS = ['bun', 'npm'] as const;

export const DEFAULT_HAPI_VERSION = '8.10.0-3';
export const SUPPORTED_HAPI_VERSIONS = ['8.0.0', '8.0.0-1', '8.0.0-2', '8.2.0-1', '8.2.0-2', '8.4.0-1', '8.4.0-2', '8.4.0-3', '8.6.0-1', '8.6.5-1', '8.8.0-1', '8.10.0-1', '8.10.0-2', '8.10.0-3'];

export const HAPI_RELEASE_URLS: Record<string, string> = Object.fromEntries(
  SUPPORTED_HAPI_VERSIONS.map((release) => [release, starterImageZipUrl(release)]),
);

export function isHapiVersionSupported(version: string): boolean {
  return SUPPORTED_HAPI_VERSIONS.includes(version);
}

/**
 * Builds the source zip URL for a starter image tag. Every image release is
 * tagged "image/v{version}" on GitHub, so the URL is derivable for releases
 * outside the curated table above.
 */
export function starterImageZipUrl(imageVersion: string): string {
  return `https://github.com/hapifhir/hapi-fhir-jpaserver-starter/archive/refs/tags/image/v${imageVersion}.zip`;
}

/** Every release, curated or not, downloads from its own image tag. */
export function getHapiReleaseUrl(release: string): string {
  return HAPI_RELEASE_URLS[release] ?? starterImageZipUrl(release);
}
