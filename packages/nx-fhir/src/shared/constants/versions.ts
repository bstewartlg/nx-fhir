export const PLUGIN_VERSION = require('../../../package.json').version;

export const DEFAULT_HAPI_VERSION = '8.4.0';
export const SUPPORTED_HAPI_VERSIONS = ['8.2.0', '8.4.0', '8.6.0', '9.0.0'];

export const HAPI_RELEASE_URLS: Record<string, string> = {
  '8.2.0':
    'https://github.com/hapifhir/hapi-fhir-jpaserver-starter/archive/refs/tags/image/v8.2.0-2.zip',
  '8.4.0':
    'https://github.com/hapifhir/hapi-fhir-jpaserver-starter/archive/refs/tags/image/v8.4.0-2.zip',
};

export function isHapiVersionSupported(version: string): boolean {
  return SUPPORTED_HAPI_VERSIONS.includes(version);
}
