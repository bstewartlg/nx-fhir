import { getProjects, logger, Tree } from "@nx/devkit";
import { prompt } from 'enquirer';
import * as path from 'path';
import { parseDocument } from "yaml";

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

  const response = await prompt<{ serverProject: string }>({
    type: 'select',
    name: 'serverProject',
    message: 'Select a server project to add the operation to:',
    choices: serverProjects,
  });
  return response.serverProject;
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