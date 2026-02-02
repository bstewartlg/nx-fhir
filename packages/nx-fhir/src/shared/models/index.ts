import { ProjectConfiguration } from '@nx/devkit';
import { CapabilityStatement, ImplementationGuide, OperationDefinition, OperationDefinitionParameter } from 'fhir/r5';

export enum FhirVersion {
  R5 = 'R5',
  R4B = 'R4B',
  R4 = 'R4',
  STU3 = 'STU3'
}

export interface PackageInfo {
  name: string;
  version: string;
  fhirVersions: string[];
}

export interface PackageResources {
  capabilityStatements: CapabilityStatement[];
  operationDefinitions: OperationDefinition[];
  implementationGuide?: ImplementationGuide;
  packageInfo?: PackageInfo;
}


export interface ServerOperationParameter extends OperationDefinitionParameter {
  dataType: string;
  methodParameterName?: string;
}

export interface ServerOperation {
  // properties from OperationDefinition FHIR type
  id: string;
  url: string;
  name: string;
  code: string;
  resource: string[];
  system: boolean;
  type: boolean;
  instance: boolean;
  
  // custom properties
  resourceDataTypes?: string[];
  inputParameters: ServerOperationParameter[];
  outputType: ServerOperationParameter;
  className: string;
  methodName: string;

  targetPackage: string;
  modelPackageVersion?: string;
}


export interface ImplementationGuidesHapiConfig {
  implementationGuides: { [key: string]: ImplementationGuideHapiConfig };
}

export interface ImplementationGuideHapiConfig {
  name: string;
  packageUrl?: string;
  version: string;
  installMode?: 'STORE_ONLY' | 'STORE_AND_INSTALL';
  fetchDependencies?: boolean;
  reloadExisting?: boolean;
}

export interface ImplementationGuidePackage {
  implementationGuide: ImplementationGuide;
  capabilityStatements: CapabilityStatement[];
  operations: OperationDefinition[];
}

export interface ServerAssets {
  capabilityStatement?: CapabilityStatement;
}

export interface ServerProjectConfiguration extends ProjectConfiguration {
  packageBase: string;
  fhirVersion: FhirVersion;
  hapiReleaseVersion: string;
  pluginVersion: string;
}

export interface FrontendProjectConfiguration extends ProjectConfiguration {
  frontendVersion: string;
  pluginVersion: string;
}
