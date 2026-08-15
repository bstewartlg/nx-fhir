import { getProjects, joinPathFragments, logger, readJson, readNxJson, Tree, updateNxJson } from "@nx/devkit";
import { select } from '@inquirer/prompts';
import * as path from 'path';
import { parseDocument } from "yaml";


/**
 * Registers the nx-fhir plugin in the workspace's nx.json file if not already registered.
 * Also adds common scripts to the root package.json if they are not already present.
 */
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

  
  // Add scripts to root package.json if not present;
  // readJson throws on a missing file, and installation-based Nx workspaces
  // have no root package.json.
  const packageJson = tree.exists('package.json')
    ? readJson(tree, 'package.json')
    : null;

  if (!packageJson) {
    logger.info('No package.json found at the workspace root. Skipping script additions.');
    return;
  }

  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  if (!packageJson.scripts['build']) {
    packageJson.scripts['build'] = 'nx run-many -t build';
  }

  if (!packageJson.scripts['serve']) {
    packageJson.scripts['serve'] = 'nx run-many -t serve';
  }

  if (!packageJson.scripts['test']) {
    packageJson.scripts['test'] = 'nx run-many -t test';
  }

  tree.write('package.json', JSON.stringify(packageJson, null, 2));

}

export async function getServerProjects(tree: Tree): Promise<string[]> {
  const projects = getProjects(tree);
  const serverProjects: string[] = [];

  // The plugin fingerprint for a server is fhirVersion in the project
  // configuration plus the starter pom.xml; requiring the pom keeps generated
  // frontends and plain Maven applications out of server prompts. A project
  // configuration may carry the nx-fhir-server tag without a fhirVersion key,
  // so the tag also qualifies alongside the pom.
  for (const [projectName, projectConfig] of projects) {
    const isServer =
      ('fhirVersion' in projectConfig ||
        (projectConfig.tags ?? []).includes('nx-fhir-server')) &&
      tree.exists(joinPathFragments(projectConfig.root, 'pom.xml'));
    if (projectConfig.projectType === 'application' && isServer) {
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


/**
 * Returns the HAPI application.yaml content with the `hapi.fhir.tester`
 * section spliced out. Every other line keeps its exact bytes, including the
 * comments above the section and the blank line that separates the section
 * from the next one.
 *
 * A YAML document round trip would reformat comment indentation across the
 * whole file and drop the comments attached to the deleted node. Those
 * rewrites collide with upstream edits in the same region when a later
 * three-way merge runs, so the section is removed by line instead.
 *
 * Content without a tester section is returned unchanged.
 */
export function removeTesterSection(content: string): string {

  const lines = content.split('\n');
  const start = lines.findIndex((line) => /^ {4}tester:\s*$/.test(line));

  if (start === -1) {
    return content;
  }

  const isSectionBody = (line: string) => /^\s{6}/.test(line) || line.trim() === '';

  let end = start + 1;
  while (end < lines.length && isSectionBody(lines[end])) {
    end++;
  }

  // Trailing blank lines belong to the separation before the next section.
  while (end > start + 1 && lines[end - 1].trim() === '') {
    end--;
  }

  lines.splice(start, end - start);
  return lines.join('\n');

}
