import { FeatureDefinition } from './types';
import { bulkPublishFeature } from '../feature-bulk-publish/bulk-publish';
import { otelFeature } from '../feature-otel/otel';
import { frontendProxyFeature } from '../feature-frontend-proxy/frontend-proxy';
import { authResourceFeature } from '../feature-auth-resource/auth-resource';
import { authUdapFeature } from '../feature-auth-udap/auth-udap';

export const FEATURES: FeatureDefinition[] = [
  bulkPublishFeature,
  otelFeature,
  frontendProxyFeature,
  authResourceFeature,
  authUdapFeature,
];
