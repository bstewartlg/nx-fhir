import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';

export interface PresetGeneratorSchema extends ServerGeneratorSchema {
  name: string;
  /** Whether to also generate a default FHIR server project. */
  server: boolean;

  directory?: string;
  packageBase?: string;
  release?: string;
  fhirVersion?: FhirVersion;
}
