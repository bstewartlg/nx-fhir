/**
 * Nx FHIR Plugin
 * 
 * This plugin provides generators for creating and managing HAPI FHIR server projects.
 */

// Export plugin for project graph integration
export { createNodes } from './plugin';

// Export all generators
export { serverGenerator } from './generators/server/server';
export { operationGenerator } from './generators/operation/operation';
export { implementationGuideGenerator } from './generators/implementation-guide/implementation-guide';
export { presetGenerator } from './generators/preset/generator';
export { frontendGenerator } from './generators/frontend/frontend';

// Export schemas
export type { ServerGeneratorSchema } from './generators/server/schema';
export type { OperationGeneratorSchema } from './generators/operation/schema';
export type { ImplementationGuideGeneratorSchema } from './generators/implementation-guide/schema';
export type { PresetGeneratorSchema } from './generators/preset/schema';
export type { FrontendGeneratorSchema } from './generators/frontend/schema';

// Export shared models and utilities
export * from './shared/models';
export * from './shared/utils';
