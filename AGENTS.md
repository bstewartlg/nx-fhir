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

# Run a single test file (args after -- pass through to Vitest)
bun nx test nx-fhir -- src/generators/server/server.spec.ts

# Coverage report with threshold enforcement (the CI test step runs this)
bun run test -- --coverage
```

### Test Coverage Policy

Coverage counts every source file via `coverage.include` in each package's
`vite.config.mts`; generated template code under `src/**/files/**` is
excluded. Thresholds in those configs fail the run when coverage backslides:
`packages/nx-fhir` requires 90% of statements, branches, functions, and lines,
and `packages/create-nx-fhir` requires 95% of statements, functions, and lines
with 90% of branches. The download and extraction path in
`generators/server/server.ts` is unit-tested against the committed starter
archive `src/generators/server/__fixtures__/starter-image.zip`, with only the
network boundary stubbed; unzipper, the filesystem and the Tree run for real.
The e2e suite covers the same path against real published artifacts.

### Local Development

```sh
# Start local npm registry (Verdaccio)
bun nx run @nx-fhir/source:local-registry

# Build, then publish to local registry (in another terminal). Publish sends dist as it is.
bun nx run-many -t build && bun nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873

# Watch, rebuild, and republish on changes
bun nx watch --initialRun --all -- "bun nx run-many -t build && bun nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873"

# Alternative: Link for development
bun run build && cd dist/packages/nx-fhir && bun link && bun install --production
# Then in the consuming Nx workspace:
bun link nx-fhir
```

### E2E Testing with Specific Package Manager

```sh
PACKAGE_MANAGER=npm bun run e2e    # Generated test workspaces use npm instead of bun
```

## Architecture

### Packages

- **`packages/nx-fhir`**: Main Nx plugin with generators, executors, and migrations
- **`packages/create-nx-fhir`**: CLI tool (`bunx create-nx-fhir`) to scaffold new workspaces

### Generators (`packages/nx-fhir/src/generators/`)

| Generator              | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `server`               | Creates HAPI FHIR JPA server from hapi-fhir-jpaserver-starter       |
| `import-server`        | Imports a pre-existing HAPI FHIR server as an Nx project, non-destructively |
| `frontend`             | Scaffolds TanStack Router/Query frontend with Vite (`browser` or `clinical` template) |
| `operation`            | Generates custom FHIR operation stubs from OperationDefinition JSON |
| `implementation-guide` | Adds FHIR IG artifacts to server (alias: `ig`)                      |
| `feature`              | Adds a packaged feature to an existing server (picker over the feature registry) |
| `feature-bulk-publish` | Adds spec-conformant $bulk-publish bulk data publication to a server            |
| `feature-otel` | Adds OpenTelemetry route tagging and a baseline Grafana dashboard to a server |
| `feature-frontend-proxy` | Adds a same-origin `/proxy` endpoint that the integrated frontend uses for requests to other FHIR servers |
| `update-server`        | Updates existing server to newer HAPI version via three-way merge    |
| `update-frontend`      | Updates frontend project to newer template version via three-way merge |
| `update`               | Checks for plugin, server, and frontend updates (runs during `nx migrate`) |
| `preset`               | Used by create-nx-fhir for workspace initialization                 |

The frontend template's settings dialog keeps custom request headers per server in browser storage, and `fhirFetch` attaches them to every request for the active server.

The feature framework lives in `generators/feature/` (picker `feature.ts`, runner `run-feature.ts`, `FeatureDefinition` contract `types.ts`, registry `registry.ts`). Each feature is a self-contained `generators/feature-<name>/` directory registered by one import line in `registry.ts`. The runner records installs in a `features` manifest in the server's project.json and rejects reinstalls. Option defaults must stay aligned between a thin generator's `schema.json` (CLI path) and `collectOptions` (picker and programmatic path); thin generators drop undefined values before calling `runFeature`. Every `FeatureDefinition` declares the inclusive HAPI range its generated Java is verified against (`minHapiVersion`, optional `maxHapiVersion`); the runner enforces it before prompting or writing, reading the hapi-fhir parent version from the server's `pom.xml`, and a pom with no readable HAPI parent warns and installs.

The `bulk-publish` feature writes Maven unit tests plus `BulkPublishIT`, which runs under `mvn verify` (failsafe), not `mvn test`, and builds its `TestRestTemplate` on `SimpleClientHttpRequestFactory` so it does not depend on the starter's httpclient5 version. A `resource-types` entry may carry a match-URL filter (`Patient?active=true`). An empty list publishes every type the server supports per the `DaoRegistry`, including heavy types such as Binary and Bundle unless `hapi.fhir.supported_resource_types` narrows them, and the generator writes an empty list only with explicit `allTypes` consent. A type that fails to export does not stop the tick: the failure lands as an error `OperationOutcome` in the snapshot's digest-gated `OperationOutcome.ndjson`, referenced by the manifest `outcome` property, so `OperationOutcome` is rejected as a configured entry. Tuning properties the generator leaves out of `application.yaml`: `publish.retention`, `publish.grace-period-ms` (retained directory count is bounded by grace period and publish interval, not `retention` alone), `publish.export-page-size`, and `publish.public-base-url` for servers behind a proxy or servlet context path. `minHapiVersion` is 7.4.0, verified by compile, unit tests, and the IT on rendered starters from 7.4.0 through 8.8.0 under JDK 17, and by compile and unit tests on 8.12.0-2.

The `otel` feature core writes `FhirRouteInterceptor`, `TelemetryProperties`, `TelemetryConfig`, the `opentelemetry-instrumentation-api` and `opentelemetry-api` pom dependencies, `telemetry.capture-query-strings` and `telemetry.resource-types` in `application.yaml`, and `OTEL.md`. The interceptor records the `fhir.server.requests` counter with bounded `fhir.interaction`, `fhir.resource_type`, and `fhir.operation` attributes and, for a response status of 400 or more, the `fhir.server.errors` counter with `fhir.interaction` and `fhir.outcome` (`client_error` or `server_error`). `TelemetryConfig` registers the `fhir.server.start_time` gauge, the JVM start in epoch seconds, one series per JVM. `http.route` names the request shape, such as `/fhir/{type}/{id}`, and never a resource type or an operation name the server did not register. `telemetry.resource-types` in `application.yaml` limits which resource types get their own `fhir.resource_type` value. Its `dashboard`, `compose`, and `serve` options are independent toggles that default to true. `dashboard` writes a Grafana v2 dashboard and its provisioning file under `otel/grafana/`, with a Summary row of four stats (interactions and operation invocations in range, last start, starts in range), a Traffic row on the counters, and a Runtime row on the `jvm_*` gauges that the agent's `runtime-telemetry` instrumentation exports (about 50 fixed series per JVM). `compose` writes `docker-compose.otel.yml` with the server and `grafana/otel-lgtm`, plus `otel/otelcol-filter.yaml`, a collector overlay that drops the agent's HTTP duration histogram when the commented `OTELCOL_EXTRA_ARGS` and volume lines in the compose file are enabled. `serve` enables `nx serve <project> --otel`, which fetches the OpenTelemetry Java agent with `mvn dependency:copy` at `OTEL_JAVAAGENT_VERSION` from `shared/constants/versions.ts` and attaches it with `spring-boot.run.agents`. The serve executor refuses `--otel` unless the server's `features` manifest records `otel` with `serve: true`. `minHapiVersion` is 8.0.0 because the HAPI parent manages the OpenTelemetry instrumentation versions from that release. The generated Java compiles and its unit tests pass on 8.10.0-3 and 8.12.0-2. The feature edits `pom.xml` by text insertion through `shared/utils/pom-edit.ts`.

The `frontend-proxy` feature writes the `/proxy?url=<destination>` endpoint (`FrontendProxyController`, `ProxyHttpClients`, `ProxyDestinations`, `PublicAddresses`), four unit tests, `FrontendProxyControllerIT` (failsafe), the `httpclient5` pom dependency, `app.proxy.enabled` and `app.proxy.passthrough` in `application.yaml`, and `FRONTEND-PROXY.md`. The proxy forwards a destination under a listed server of `app.fhir.servers`. `app.fhir.servers` is a YAML list of `name` and `url` entries or one string that holds a JSON array of them. The proxy skips a root-relative entry of `app.fhir.servers` when it builds its listed servers. With `app.proxy.passthrough: true`, the proxy forwards any other destination through a second client whose `DnsResolver` refuses a host with an address that is not public. With passthrough off, the proxy answers 403 to any other destination. The controller builds its HTTP clients from `RestClient.builder()` and the `ProxyHttpClients` factories, with retries, redirects, cookies, and content decompression off. The proxy relays the upstream `Content-Length` header only for a `HEAD` request. The proxy answers 400 to a request whose declared body was already read before the controller runs. Spring reads a form-encoded `PUT`, `PATCH`, or `DELETE` body and a multipart body before the controller runs. `FhirServers`, an integration file of the frontend generator, reads both forms of `app.fhir.servers`. `FhirServers` stops startup when an entry has no `name` or its `url` is neither an absolute `http` or `https` URL with a host and no user information, query, or fragment nor a path that starts with one `/` and has no query, fragment, or backslash. `ConfigController` puts only the `name` and `url` of each entry in `fhirServers` of `/config.js`. `ConfigController` adds `proxy: { passthrough }` to `/config.js` when `app.proxy.enabled` is true. The install refuses when no frontend's `copy-to-server` target points to the server. The install refuses when an integrated frontend's `src/lib/fhir-config.ts` does not export `toRequestUrl`. The install refuses when the server's `ConfigController.java` does not read `app.proxy`. The install refuses when the server's `FhirServers.java` is absent. The install refuses when the server's `GlobalCorsConfiguration.java` is present and has no `/proxy` mapping ahead of `/**`. The feature adds `DEV_SERVER_URL=http://localhost:8080` to the `.env.development` of each integrated frontend. The `vite.config.ts` templates forward `/proxy`, `/config.js`, and `/fhir` to `DEV_SERVER_URL` when it is set. The `frontend` generator's `proxy` option has no schema default. The generator prompts for it only when a server is integrated and the run is interactive. When the integrated server already has the `frontend-proxy` feature, the generator asks no question and adds the `DEV_SERVER_URL` line to the generated frontend for any value of the option. The generator turns a refusal of the runner into a warning. `minHapiVersion` is 8.8.0, verified by the unit tests and the IT under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

### Executors (`packages/nx-fhir/src/executors/`)

- `serve`: Runs Maven spring-boot:run for servers, Vite dev for frontends
- `build`: Runs Maven package or Vite build
- `test`: Runs Maven test or Vitest

### Project Detection (`packages/nx-fhir/src/plugin.ts`)

The plugin auto-detects project types:

- **Server**: Has `pom.xml` + `fhirVersion` in project.json
- **Frontend**: Has `package.json` with `@types/fhir` or `nx-fhir-frontend` tag

The `import-server` generator and the `preset` flow reuse this fingerprint via `shared/utils/server-detection.ts` to import an already-present HAPI server, writing `project.json`, the plugin entry in `nx.json`, and for a root import the `.gitignore` entries and the `name` plus `nx.includedScripts` of the root `package.json`, never the server files. An existing `project.json` keeps its name and its recorded `packageBase` and `fhirVersion` unless detection or an explicit option names another value. `preset` runs the detection first, so an existing server is imported without prompting. The HAPI release is identified from `pom.xml`: the hapi-fhir parent version plus the `hapi.fhir.jpa.server.starter.revision` property. Curated releases cover 8.0.0 through 8.12.0-2. 7.x and older are verified against published GitHub releases (`shared/utils/hapi-release-discovery.ts`), and `update-server` bridges them to the nearest curated release (`buildBridgeMigration` in `hapi-migration-resolver.ts`). Non-interactive runs record the release only when the pom names exactly one candidate. An ambiguous pom leaves `hapiReleaseVersion` unset until the user provides `--release`.

### Migrations (`packages/nx-fhir/src/migrations/`)

Two migration systems with three-way merge support:

**HAPI server migrations**: `HAPI_MIGRATIONS` in `shared/migration/hapi-migration-resolver.ts` is a registry of `{ from, to }` pairs, one per consecutive curated release, covering 8.0.0 through 8.12.0-2 in 15 steps. There are no per-version migration directories: every step runs the generic three-way merge through `runHapiMigration`. A step that ever needs custom logic sets the optional `implementation` field to a module path, and `runMigrationStep` in the `update-server` generator loads and runs that module instead.

HAPI migration resolver uses BFS graph traversal to find migration paths between versions.

**Frontend template migrations** (`check-updates/`):
- Triggered during `nx migrate` via the `update` generator
- Downloads old template from the previously installed npm version and new template from the target version
- Performs three-way merge preserving user customizations while applying template updates
- Managed by `frontend-migration.ts` and `frontend-migration-resolver.ts` in shared code
- Also merges the server-integration files the generator wrote outside the frontend root: the docker files in the frontend project's parent directory, and the SPA/CORS Java classes in the server source tree. Integration is detected from the frontend project's `copy-to-server` target (`shared/utils/frontend-integration.ts`).
- Dependency sync classifies each template range against the project: in-range changes apply, a project ahead keeps its version, and a change outside the range or across a `DEPENDENCY_ADVISORIES` boundary is risky and gets the entry's fix command, the project's `build`, `check`, and `test` before and after, and one keep-or-undo question, where undo takes the run's changes back out of the tree so Nx writes nothing and `nx migrate` continues, an unattended run with risky changes skips the update, and `--acceptBreaking` keeps without asking. A new template test file is not added when the file it tests differs from the old template.

**Docker file ownership**: For a server at the workspace root with the frontend directly beneath it, the frontend generator inserts the frontend build stage, one `COPY --from=build-frontend` line, and the frontend ignore lines into the starter's own `Dockerfile` and `.dockerignore` (`shared/utils/docker-splice.ts`). The server migration merges those files with the HAPI releases, and the frontend template migration updates only the inserted lines. Every other layout gets the combined frontend + server Dockerfile in the frontend project's parent directory, and the generator keeps each file it replaces as `<name>.orig`. A combined Dockerfile at the workspace root with a frontend directly beneath it is a legacy file: `runHapiMigration` strips it from both release sides, and the `update` generator reports it once per run with the steps to switch.

`create-nx-fhir .` converts a workspace that runs Nx through the Nx wrapper into a `package.json` install and carries the plugins from the `installation` block. The update generator leaves an `installation` block unchanged and points to that conversion.

### Shared Code (`packages/nx-fhir/src/shared/`)

- `models/`: TypeScript interfaces for FHIR resources and project config
- `utils/`: Helpers for package manager detection, server YAML updates, Git operations, three-way merge, existing-server detection (`server-detection.ts`)
- `migration/`: Migration resolvers and logic for both HAPI server and frontend template updates
  - `hapi-migration-resolver.ts`: BFS graph traversal for HAPI version upgrade paths
  - `hapi-migration.ts`: Base HAPI migration logic
  - `frontend-migration-resolver.ts`: Resolves frontend template version upgrade paths
  - `frontend-migration.ts`: Three-way merge logic for frontend template updates
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

### Generated Java Beans

Generated Spring beans take their dependencies through a single constructor, with no `@Autowired` fields. `BaseProvider` and `BaseInterceptor` take the `RestfulServer` in a protected constructor, and the `operation`, `bulk-publish`, and `ig` generators emit the subclass constructor only when `baseClassTakesServer` in `shared/utils/server-wiring.ts` finds that constructor in the server's base class.

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

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
