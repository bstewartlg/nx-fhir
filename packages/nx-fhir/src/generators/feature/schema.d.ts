export interface FeatureGeneratorSchema {
  project?: string;
  feature?: string;
  /** Options of the selected feature, forwarded to it unchanged. */
  [option: string]: unknown;
}
