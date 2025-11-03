# nx-fhir

An Nx plugin for building FHIR servers and frontends.

## Features

- 🚀 **Quick Start**: Generate complete FHIR server projects based on [HAPI FHIR JPA Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- 🎨 **Frontend**: Scaffold Next.js frontend that integrates with the FHIR server
- ⚡ **Custom Operations**: Generate custom FHIR operations from OperationDefinition resources
- 📚 **Implementation Guides**: Add FHIR Implementation Guides to your server
- 🔄 **Updates**: Keep your HAPI FHIR server up to date with the newer releases

## Installation

### Create a New Workspace

The fastest way to get started is with the preset:

```sh
npx create-nx-fhir@latest
```

This will create a new Nx workspace with nx-fhir installed and also optionally generate a FHIR server.

### Add to Existing Nx Workspace

If you already have an Nx workspace, install the plugin:

```sh
npm install --save-dev nx-fhir
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

### Frontend

Generate a basic Next.js frontend application that can be packaged with the FHIR server:

```sh
nx g nx-fhir:frontend
```

**Options:**
- `--name`: Directory name for the frontend (default: `frontend`)
- `--server`: Name of the FHIR server project to integrate with

**Example:**
```sh
nx g nx-fhir:frontend --name=patient-portal --server=my-fhir-server
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

Update an existing HAPI FHIR server to a newer version:

```sh
nx g nx-fhir:update-server
```

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

4. **Generate a frontend**:
   ```sh
   nx g nx-fhir:frontend --name=webapp --server=server
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

## Requirements

- **Node.js**: Version 20 or higher
  - (Optional) [bun](https://bun.sh/) is the preferred default runtime and package manager
- **Java**: JDK 17 or higher (for HAPI FHIR server projects)
- **Maven**: For building Java server projects

## Documentation

This plugin makes use of several external projects. For more information, please refer to their documentation:

- [Nx Documentation](https://nx.dev)
- [HAPI FHIR JPA Server Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- [Next.js Documentation](https://nextjs.org/docs)


