import { Tree } from '@nx/devkit';
import { ServerProjectConfiguration } from '../../shared/models';

export interface FeatureDefinition {
  /** Kebab-case identifier, unique in the registry. */
  name: string;
  /** One line shown in the feature picker. */
  description: string;
  /** Recorded in the project manifest at install time. */
  featureVersion: number;
  /**
   * Inclusive floor: the lowest hapi-fhir library version the feature's
   * generated Java is verified to compile against.
   */
  minHapiVersion: string;
  /**
   * Inclusive ceiling: set when a later HAPI release breaks the feature.
   */
  maxHapiVersion?: string;
  /**
   * Resolve the full option set. A value the caller does not provide is
   * prompted for in interactive runs and falls back to the feature's default
   * otherwise. Throws when a provided value is invalid.
   */
  collectOptions(
    tree: Tree,
    project: ServerProjectConfiguration,
    provided: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  /** Write files and configuration. Must not call formatFiles. */
  apply(
    tree: Tree,
    project: ServerProjectConfiguration,
    options: Record<string, unknown>
  ): Promise<void>;
}
