import { FhirVersion } from '../../shared/models';

export interface ImportServerGeneratorSchema {
  /** Directory containing the existing HAPI server (defaults to the workspace root). */
  directory?: string;
  /** Nx project name to register (defaults to the directory name). */
  name?: string;
  /** Java package path for custom code. Auto-detected when omitted. */
  packageBase?: string;
  /** FHIR version of the server. Auto-detected from application.yaml when omitted. */
  fhirVersion?: FhirVersion;
  /** HAPI FHIR JPA Starter release this server corresponds to. Auto-correlated when omitted. */
  release?: string;
}
