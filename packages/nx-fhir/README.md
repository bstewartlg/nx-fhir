# nx-fhir

An Nx plugin for building FHIR servers and frontends.

## Features

- Generate complete FHIR server projects based on [HAPI FHIR JPA Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- Import a pre-existing HAPI FHIR server as an Nx project without modifying its source
- Scaffold TanStack Router-based React frontend SPAs with browser or clinical templates
- Generate custom FHIR operations from OperationDefinition resources
- Add FHIR Implementation Guides to your server
- Keep your HAPI FHIR server and frontend up to date with newer releases via `nx migrate`

## Installation

### Create a New Workspace

Create a new Nx workspace with nx-fhir installed:

```sh
npx create-nx-fhir@latest
```

This will create a new Nx workspace with nx-fhir installed and also optionally generate a FHIR server.

### Add to an Existing Directory

To add nx-fhir to an existing project directory:

```sh
cd my-existing-project
bunx create-nx-fhir@latest .
```

See the [create-nx-fhir README](https://www.npmjs.com/package/create-nx-fhir) for details.

### Add to Existing Nx Workspace

If you already have an Nx workspace, install the plugin:

```sh
bun add --dev nx-fhir
```

## Generators

### Server

Generate a new HAPI FHIR JPA server project:

```sh
nx g nx-fhir:server
```

**Options:**
- `--directory`: Directory for the server source code (default: `server`)
- `--packageBase`: Java package path for custom code (default: `org.custom.server`)
- `--fhirVersion`: FHIR version to use (options: `STU3`, `R4`, `R4B`, `R5`, default: `R4`)
- `--release`: Specific HAPI FHIR JPA Starter release version

**Example:**
```sh
nx g nx-fhir:server --directory=my-fhir-server --packageBase=com.myorg.fhir --fhirVersion=R4
```

### Import Server

Register an existing HAPI FHIR JPA Starter server as an Nx project without scaffolding or modifying any server source:

```sh
nx g nx-fhir:import-server
```

**Options:**
- `--directory`: Directory containing the existing server (default: workspace root)
- `--name`: Nx project name to register (default: directory name)
- `--packageBase`: Java package path for custom code (auto-detected from `src/main/java` when omitted)
- `--release`: HAPI FHIR JPA Starter release the server corresponds to. When omitted, it is detected from `pom.xml` (parent version plus the starter revision property identify the exact image). A release outside the tested set is verified against the published GitHub releases and recorded when it identifies exactly one image. If no single release can be identified, an interactive run prompts and a non-interactive run leaves it unset (required later by `update-server`)
- `--fhirVersion`: FHIR version of the server (auto-detected from `application.yaml` when omitted)

Only a `project.json` is written; existing server files are left untouched. The `create-nx-fhir` preset runs this detection automatically, so initializing a workspace in a directory that already contains a HAPI server imports it instead of generating a new one.

Servers on releases outside the tested set (for example 7.6.0 or 7.4.0, below the curated 8.x range) are supported on a best-effort basis: the importer verifies the release against the published GitHub releases of the HAPI FHIR JPA Starter and records it when the pom identifies exactly one image. `update-server` then starts with a bridge step that merges the server directly to the nearest tested release before following the tested migration chain. Expect more merge conflicts from a bridge step than from a tested one.

### Frontend

Generate a TanStack Router-based React SPA that can be packaged with the FHIR server:

```sh
nx g nx-fhir:frontend
```

**Options:**
- `--name`: Directory name for the frontend (default: `frontend`)
- `--server`: Name of the FHIR server project to integrate with
- `--template`: Frontend template to use (options: `browser`, `clinical`, default: `browser`)
  - `browser` -- Developer/test resource explorer
  - `clinical` -- Patient-centric clinical workflow skeleton
- `--navigationLayout`: Navigation layout for the clinical template (options: `sidebar`, `topnav`)
  - `sidebar` -- Collapsible left navigation for apps with many pages
  - `topnav` -- Horizontal nav bar for apps with few entry pages

**Example:**
```sh
nx g nx-fhir:frontend --name=patient-portal --server=my-fhir-server --template=clinical --navigationLayout=sidebar
```

When `--server` is provided, the frontend also gets a `copy-to-server` target that builds the frontend and copies the production bundle into the server's static resources so the server can host it:

```sh
nx copy-to-server patient-portal
```

### Server Operation

Generate a stub for a custom FHIR operation based on an `OperationDefinition`:

```sh
nx g nx-fhir:operation
```

**Options:**
- `--project`: Name of the Nx server project to add the operation to
- `--defLocation`: Path or URL to the OperationDefinition JSON file
- `--defContent`: Direct JSON content of the OperationDefinition
- `--name`: Name of the operation (default: `my-operation`)
- `--directory`: Target directory for the generated source file

**Example:**
```sh
nx g nx-fhir:operation --project=my-fhir-server --defLocation=./operations/OperationDefinition-myop.json
```

### Implementation Guide

Initialize a server with artifacts from a FHIR Implementation Guide:

```sh
nx g nx-fhir:implementation-guide
# or use the alias
nx g nx-fhir:ig
```

This will also prompt to generate any custom operations defined in the IG and use any `CapabilityStatement` present in the IG.

### Update Server

Update an existing HAPI FHIR server to a newer version. Uses a three-way merge against the upstream HAPI FHIR JPA Starter releases to preserve your customizations:

```sh
nx g nx-fhir:update-server
```

**Options:**
- `--project`: Name of the server project to update
- `--targetVersion`: The HAPI FHIR version to update the server to
- `--force`: Force update and override safety checks (not recommended)

A server on a release outside the tested migration set starts with a bridge step: a best-effort three-way merge from its own published image to the nearest tested release, after which the tested chain continues as usual.

### Update Frontend

Update an existing frontend project to a newer template version. Uses a three-way merge to preserve your customizations while applying template updates:

```sh
nx g nx-fhir:update-frontend
```

**Options:**
- `--project`: Name of the frontend project to update
- `--targetVersion`: The frontend template version to update to
- `--force`: Force update and override safety checks (not recommended)

### Update

Check for available updates to the nx-fhir plugin and any managed server or frontend projects:

```sh
nx g nx-fhir:update
```

This generator is also run automatically as part of `nx migrate` when updating to a new version of nx-fhir.

## Keeping Up to Date

nx-fhir integrates with Nx's migration system. When you update to a new version of nx-fhir, the migration will automatically check for available HAPI server and frontend template updates:

```sh
nx migrate nx-fhir@latest
nx migrate --run-migrations
```

During migration, you'll be prompted to select target versions for any server or frontend projects that have updates available. The server migration uses a three-way merge to preserve your customizations while applying upstream changes.

## Nx Executors

### Serve

Start the FHIR server and/or frontend in development mode:

```sh
nx serve <project-name>
```

### Build

Build the FHIR server and/or frontend for production:

```sh
nx build <project-name>
```

### Test

Run tests for your FHIR server and/or frontend:

```sh
nx test <project-name>
```

## Typical Workflow

1. **Create a new workspace** with the preset:
   ```sh
   npx create-nx-fhir@latest my-fhir-app
   cd my-fhir-app
   ```

2. **Generate a FHIR server**:
   ```sh
   nx g nx-fhir:server --packageBase=com.myorg.fhir
   ```

3. **Add a custom operation**:
   ```sh
   nx g nx-fhir:operation --project=server --defLocation=./my-operation.json
   ```

4. **Generate a frontend** (choose a template):
   ```sh
   nx g nx-fhir:frontend --name=webapp --server=server --template=clinical
   ```

5. **Serve everything**:

   In the root of your workspace, run:
   ```sh
   npm run serve
   ```

   This is the equivalent of:
   ```sh
   nx run-many --target=serve
   ```

   Or the individual commands:
   ```sh
   nx serve server
   nx serve webapp
   ```

6. **Build for production**:
   ```sh
   nx build server
   nx build webapp
   ```

7. **Update to the latest version**:
   ```sh
   nx migrate nx-fhir@latest
   nx migrate --run-migrations
   ```

## Requirements

- **Node.js**: Version 20 or higher
  - (Optional) [bun](https://bun.sh/) is the preferred default runtime and package manager
- **Java**: JDK 17 or higher (for HAPI FHIR server projects)
- **Maven**: For building Java server projects

## Documentation

This plugin makes use of several external projects. For more information, please refer to their documentation:

- [Nx Documentation](https://nx.dev)
- [HAPI FHIR JPA Server Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- [TanStack Documentation](https://tanstack.com)
