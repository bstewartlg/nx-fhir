export interface FeatureBulkPublishGeneratorSchema {
  project?: string;
  resourceTypes?: string;
  intervalMs?: number;
  transactionLagMs?: number;
  storagePath?: string;
  resetOnStartup?: boolean;
  publicBaseUrl?: string;
}
