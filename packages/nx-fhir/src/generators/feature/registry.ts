import { FeatureDefinition } from './types';
import { bulkPublishFeature } from '../feature-bulk-publish/bulk-publish';

export const FEATURES: FeatureDefinition[] = [bulkPublishFeature];
