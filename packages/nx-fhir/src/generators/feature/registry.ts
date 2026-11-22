import { FeatureDefinition } from './types';
import { bulkPublishFeature } from '../feature-bulk-publish/bulk-publish';
import { otelFeature } from '../feature-otel/otel';
import { frontendProxyFeature } from '../feature-frontend-proxy/frontend-proxy';
import { authResourceFeature } from '../feature-auth-resource/auth-resource';
import { authUdapFeature } from '../feature-auth-udap/auth-udap';
import { authSmartFeature } from '../feature-auth-smart/auth-smart';
import { authScopesFeature } from '../feature-auth-scopes/auth-scopes';
import { authLoginFeature } from '../feature-auth-login/auth-login';

export const FEATURES: FeatureDefinition[] = [
  bulkPublishFeature,
  otelFeature,
  frontendProxyFeature,
  authResourceFeature,
  authUdapFeature,
  authSmartFeature,
  authScopesFeature,
  authLoginFeature,
];
