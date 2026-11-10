import { FeatureDefinition } from './types';
import { bulkPublishFeature } from '../feature-bulk-publish/bulk-publish';
import { otelFeature } from '../feature-otel/otel';
import { frontendProxyFeature } from '../feature-frontend-proxy/frontend-proxy';

export const FEATURES: FeatureDefinition[] = [
  bulkPublishFeature,
  otelFeature,
  frontendProxyFeature,
];
