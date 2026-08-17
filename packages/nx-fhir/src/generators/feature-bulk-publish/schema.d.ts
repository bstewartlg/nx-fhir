export interface FeatureBulkPublishGeneratorSchema {
  project?: string;
  resourceTypes?: string;
  allTypes?: boolean;
  intervalMs?: number;
  transactionLagMs?: number;
  storagePath?: string;
  resetOnStartup?: boolean;
  publicBaseUrl?: string;
}
