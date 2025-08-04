export interface ImplementationGuideGeneratorSchema {
  project: string;
  id: string;
  igVersion: string;
  package?: string;
  install?: boolean;
  skipOps?: boolean;
  opDirectory?: string;
}
