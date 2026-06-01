import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';

export interface PresetGeneratorSchema extends ServerGeneratorSchema {
  name: string;
  /**
   * Whether to generate a default FHIR server project.
   * When omitted, an existing server is auto-detected and imported; if none is found the user is prompted.
   */
  server?: boolean;

  serverDirectory?: string;
  packageBase?: string;
  release?: string;
  fhirVersion?: FhirVersion;
}
