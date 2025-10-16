import { FhirVersion } from "../../shared/models";

export interface ServerGeneratorSchema {
  directory: string;
  packageBase: string;
  release?: string;
  fhirVersion: FhirVersion;
}
