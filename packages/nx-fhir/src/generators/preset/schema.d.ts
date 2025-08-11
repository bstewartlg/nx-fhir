export interface PresetGeneratorSchema {
  name: string;
  /** Whether to also generate a default FHIR server project. */
  server?: boolean;
}
