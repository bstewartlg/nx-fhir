import { FeatureDefinition } from './types';
import { bulkPublishFeature } from '../feature-bulk-publish/bulk-publish';
import { otelFeature } from '../feature-otel/otel';

export const FEATURES: FeatureDefinition[] = [bulkPublishFeature, otelFeature];
