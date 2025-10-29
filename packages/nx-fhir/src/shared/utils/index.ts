import { getProjects, logger, readNxJson, Tree, updateNxJson } from "@nx/devkit";
import { select } from '@inquirer/prompts';
import * as path from 'path';
import { parseDocument } from "yaml";


export async function registerNxPlugin(tree: Tree) {
  const nxJson = readNxJson(tree);
  if (!nxJson) {
    throw new Error('nx.json not found');
  }

  if (!nxJson.plugins) {
    nxJson.plugins = [];
  }

  // Check if nx-fhir plugin is already registered
  const pluginName = 'nx-fhir';
  const isPluginRegistered = nxJson.plugins.some(plugin => 
    typeof plugin === 'string' ? plugin === pluginName : plugin.plugin === pluginName
  );

  // Add the plugin if it's not already registered
  if (!isPluginRegistered) {
    nxJson.plugins.push(pluginName);
    updateNxJson(tree, nxJson);
  }
}

export async function getServerProjects(tree: Tree): Promise<string[]> {
  const projects = getProjects(tree);
  const serverProjects: string[] = [];
  
  for (const [projectName, projectConfig] of projects) {
    if (projectConfig.projectType === 'application') {
      serverProjects.push(projectName);
    }
  }
  
  return serverProjects;
}

export async function promptForServerProject(tree: Tree): Promise<string> {
  const serverProjects = await getServerProjects(tree);
  if (serverProjects.length === 0) {
    throw new Error('No server projects found in the workspace. Please create a server project first using the server generator.');
  }
  
  if (serverProjects.length === 1) {
    logger.info(`Using the only available server project: ${serverProjects[0]}`);
    return serverProjects[0];
  }

  return (await select({
    message: 'Select a server project to add the operation to:',
    choices: serverProjects,
  }));
}



export function getJavaType(fhirType: string, isOutput = false): string {
  if (!fhirType) {
    return "void";
  }

  if (
    fhirType === "base64Binary" ||
    fhirType === "boolean" ||
    fhirType === "canonical" ||
    fhirType === "code" ||
    fhirType === "date" ||
    fhirType === "dateTime" ||
    fhirType === "decimal" ||
    fhirType === "id" ||
    fhirType === "instant" ||
    fhirType === "integer" ||
    fhirType === "inter64" ||
    fhirType === "markdown" ||
    fhirType === "oid" ||
    fhirType === "positiveInt" ||
    fhirType === "string" ||
    fhirType === "time" ||
    fhirType === "unsignedInt" ||
    fhirType === "uri" ||
    fhirType === "url" ||
    fhirType === "uuid"
  ) {
    if (isOutput) {
      return "void";
    }
    return fhirType.charAt(0).toUpperCase() + fhirType.slice(1) + "Type";
  }

  if (fhirType === 'Resource') {
    return 'IAnyResource'
  }
  return fhirType;
}



export function updateServerYaml(projectRoot: string, tree: Tree, property: string, value: unknown) {

  const configPath = path.join(projectRoot, 'src/main/resources/application.yaml');
  const configFile = tree.read(configPath, 'utf-8');

  if (!configFile) {
    throw new Error(`Configuration file not found at ${configPath}`);
  }

  const serverConfigDoc = parseDocument(configFile);
  serverConfigDoc.setIn(property.split('.'), value);
  tree.write(configPath, serverConfigDoc.toString());

}


export function removeServerYamlProperty(projectRoot: string, tree: Tree, property: string) {

  const configPath = path.join(projectRoot, 'src/main/resources/application.yaml');
  const configFile = tree.read(configPath, 'utf-8');
  
  if (!configFile) {
    throw new Error(`Configuration file not found at ${configPath}`);
  }

  const serverConfigDoc = parseDocument(configFile);
  serverConfigDoc.deleteIn(property.split('.'));
  tree.write(configPath, serverConfigDoc.toString());

}
