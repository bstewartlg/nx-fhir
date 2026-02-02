# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

nx-fhir is an Nx plugin for building FHIR healthcare interoperability projects. It provides generators and executors for creating HAPI FHIR servers (Java/Spring Boot) and TanStack SPA frontends within an Nx monorepo.

## Commands

### Build & Test
```sh
bun install                    # Install dependencies
bun run build                  # Build all packages (nx run-many -t build)
bun run test                   # Run all tests (nx run-many -t test)
bun run e2e                    # Run e2e tests (creates temp workspace, generates server, queries /fhir/metadata)
```

### Single Package Operations
```sh
nx build nx-fhir               # Build the main plugin
nx test nx-fhir                # Run unit tests for nx-fhir
nx lint nx-fhir                # Lint the plugin
```

### Local Development
```sh
# Start local npm registry (Verdaccio)
bun nx run @nx-fhir/source:local-registry

# Publish to local registry (in another terminal)
bun nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873

# Watch and republish on changes
bun nx watch --initialRun --all -- npx nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873

# Alternative: Link for development
bun run build && cd dist/packages/nx-fhir && bun link && bun install --production
```

### E2E Testing with Specific Package Manager
```sh
PACKAGE_MANAGER=npm npm run e2e    # Use npm instead of bun for e2e
```

## Architecture

### Packages
- **`packages/nx-fhir`**: Main Nx plugin with generators, executors, and migrations
- **`packages/create-nx-fhir`**: CLI tool (`npx create-nx-fhir`) to scaffold new workspaces

### Generators (`packages/nx-fhir/src/generators/`)
| Generator | Purpose |
|-----------|---------|
| `server` | Creates HAPI FHIR JPA server from hapi-fhir-jpaserver-starter |
| `frontend` | Scaffolds TanStack Router/Query frontend with Vite |
| `operation` | Generates custom FHIR operation stubs from OperationDefinition JSON |
| `implementation-guide` | Adds FHIR IG artifacts to server (alias: `ig`) |
| `update-server` | Updates existing server to newer HAPI version |
| `preset` | Used by create-nx-fhir for workspace initialization |

### Executors (`packages/nx-fhir/src/executors/`)
- `serve`: Runs Maven spring-boot:run for servers, Vite dev for frontends
- `build`: Runs Maven package or Vite build
- `test`: Runs Maven test or Vitest

### Project Detection (`packages/nx-fhir/src/plugin.ts`)
The plugin auto-detects project types:
- **Server**: Has `pom.xml` + `fhirVersion` in project.json
- **Frontend**: Has `package.json` with `@types/fhir` or `nx-fhir-frontend` tag

### Migrations (`packages/nx-fhir/src/migrations/`)
HAPI server version migrations with three-way merge support:
- `8.2.0-to-8.4.0`
- `8.4.0-to-8.4.0-3`
- `8.4.0-3-to-8.6.0-1`

Migration resolver uses BFS graph traversal to find migration paths between versions.

### Shared Code (`packages/nx-fhir/src/shared/`)
- `models/`: TypeScript interfaces for FHIR resources and project config
- `utils/`: Helpers for package manager detection, server YAML updates, Git operations, three-way merge
- `migration/`: HAPI migration resolver and base migration logic
- `constants/`: Version constants

## Key Patterns

### Generator Structure
Each generator follows the pattern:
```
generators/{name}/
  ├── {name}.ts          # Main generator function
  ├── {name}.spec.ts     # Unit tests
  ├── schema.json        # Nx schema definition
  ├── schema.d.ts        # TypeScript types for options
  └── files/             # EJS template files (.template extension)
```

### Three-Way Merge for Migrations
Server migrations use `migrateWithThreeWayMerge()` from `shared/utils/merge.ts`:
1. Downloads old HAPI starter release (base)
2. Downloads new HAPI starter release (target)
3. Performs diff3 merge: preserves user changes, applies upstream updates, marks conflicts

### FHIR Version Support
Supports FHIR versions: `STU3`, `R4`, `R4B`, `R5` (see `FhirVersion` enum in `shared/models/index.ts`)

### Server Configuration
Server projects store config in `src/main/resources/application.yaml`. Use `updateServerYaml()` utility to modify.

### Package Manager Support
Only `bun` and `npm` are supported. Use utilities in `shared/utils/package-manager.ts` for package manager abstraction.

## Requirements
- Node.js 20+
- Java JDK 17+ (for server projects)
- Maven (for building server projects)
- bun (preferred) or npm



<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- You have access to the Nx MCP server and its tools, use them to help the user
- When answering questions about the repository, use the `nx_workspace` tool first to gain an understanding of the workspace architecture where applicable.
- When working in individual projects, use the `nx_project_details` mcp tool to analyze and understand the specific project structure and dependencies
- For questions around nx configuration, best practices or if you're unsure, use the `nx_docs` tool to get relevant, up-to-date docs. Always use this instead of assuming things about nx configuration
- If the user needs help with an Nx configuration or project graph error, use the `nx_workspace` tool to get any errors

<!-- nx configuration end-->
