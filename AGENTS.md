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
| `feature-auth-resource` | Adds a bearer token check to the FHIR endpoint of a server |
| `feature-auth-udap` | Adds signed UDAP metadata at `/fhir/.well-known/udap` to a server on top of `feature-auth-resource` |
| `feature-auth-smart` | Adds the SMART configuration at `/fhir/.well-known/smart-configuration` to a server on top of `feature-auth-resource` and `feature-auth-scopes` |
| `feature-auth-scopes` | Adds a token scope check to the FHIR endpoint of a server on top of `feature-auth-resource` |
| `feature-auth-login` | Adds sign-in at the authorization server of a FHIR server to the integrated frontend of a server on top of `feature-frontend-proxy` |
| `update-server`        | Updates existing server to newer HAPI version via three-way merge    |
| `update-frontend`      | Updates frontend project to newer template version via three-way merge |
| `update`               | Checks for plugin, server, and frontend updates (runs during `nx migrate`) |
| `preset`               | Used by create-nx-fhir for workspace initialization                 |

The frontend template's settings dialog keeps custom request headers per server in browser storage, and `fhirFetch` attaches them to every request for the active server. `fhirFetch` sends `X-App-Request: 1` with each request to the origin of the page. The `clinical` template sends `Patient?_summary=count` for the selected server at load, and `SignInGate` (`src/components/sign-in-gate.tsx`) shows a sign-in page in place of the route content while that request answers 401.

The feature framework lives in `generators/feature/` (picker `feature.ts`, runner `run-feature.ts`, `FeatureDefinition` contract `types.ts`, registry `registry.ts`). Each feature is a self-contained `generators/feature-<name>/` directory registered by one import line in `registry.ts`. The document template `files/docs/*.md.template` of a feature gives the run-time behavior of the server with that feature, and `bulk-publish` has no document template. The runner records installs in a `features` manifest in the server's project.json and rejects reinstalls. The manifest leaves out each option whose value is an empty string, `null`, or `undefined`. The runner installs each absent feature that `requires` of a `FeatureDefinition` names before that feature. Before such an install, an interactive run asks one question with yes as the default, a run that is not interactive asks no question, and a no stops the install with no write. A default in a thin generator's `schema.json` (CLI path) must equal the `collectOptions` default (picker and programmatic path). Thin generators drop undefined values before calling `runFeature`. Every `FeatureDefinition` declares the inclusive HAPI range its generated Java is verified against (`minHapiVersion`, optional `maxHapiVersion`); the runner enforces it before prompting or writing, reading the hapi-fhir parent version from the server's `pom.xml`, and a pom with no readable HAPI parent warns and installs.

The `bulk-publish` feature writes Maven unit tests plus `BulkPublishIT`, which runs under `mvn verify` (failsafe), not `mvn test`, and builds its `TestRestTemplate` on `SimpleClientHttpRequestFactory` so it does not depend on the starter's httpclient5 version. `BulkPublishIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. A `resource-types` entry may carry a match-URL filter (`Patient?active=true`). An empty list publishes every type the server supports per the `DaoRegistry`, including heavy types such as Binary and Bundle unless `hapi.fhir.supported_resource_types` narrows them, and the generator writes an empty list only with explicit `allTypes` consent. A type that fails to export does not stop the tick: the failure lands as an error `OperationOutcome` in the snapshot's digest-gated `OperationOutcome.ndjson`, referenced by the manifest `outcome` property, so `OperationOutcome` is rejected as a configured entry. Tuning properties the generator leaves out of `application.yaml`: `publish.retention`, `publish.grace-period-ms` (retained directory count is bounded by grace period and publish interval, not `retention` alone), `publish.export-page-size`, and `publish.public-base-url` for servers behind a proxy or servlet context path. `minHapiVersion` is 7.4.0, verified by compile, unit tests, and the IT on rendered starters from 7.4.0 through 8.8.0 under JDK 17, and by compile and unit tests on 8.12.0-2.

The `otel` feature core writes `FhirRouteInterceptor`, `TelemetryProperties`, `TelemetryConfig`, the `opentelemetry-instrumentation-api` and `opentelemetry-api` pom dependencies, `telemetry.capture-query-strings` and `telemetry.resource-types` in `application.yaml`, and `OTEL.md`. Its `dashboard`, `compose`, and `serve` options are independent toggles that default to true. `dashboard` writes a Grafana v2 dashboard and its provisioning file under `otel/grafana/`. `compose` writes `docker-compose.otel.yml` and the collector overlay `otel/otelcol-filter.yaml`. `serve` enables `nx serve <project> --otel`, which fetches the OpenTelemetry Java agent at `OTEL_JAVAAGENT_VERSION` from `shared/constants/versions.ts` and attaches it with `spring-boot.run.agents`. The serve executor refuses `--otel` unless the server's `features` manifest records `otel` with `serve: true`. `minHapiVersion` is 8.0.0 because the HAPI parent manages the OpenTelemetry instrumentation versions from that release. The generated Java compiles and its unit tests pass on 8.10.0-3 and 8.12.0-2. The feature edits `pom.xml` by text insertion through `shared/utils/pom-edit.ts`.

The `frontend-proxy` feature writes the `/proxy?url=<destination>` endpoint (`FrontendProxyController`, `ProxyHttpClients`, `ProxyDestinations`, `PublicAddresses`), four unit tests, `FrontendProxyControllerIT` (failsafe), the `httpclient5` pom dependency, `app.proxy.enabled`, `app.proxy.passthrough`, and `server.forward-headers-strategy: native` in `application.yaml`, and `FRONTEND-PROXY.md`. `FrontendProxyControllerIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. `FhirServers`, an integration file of the frontend generator, reads both forms of `app.fhir.servers`, the YAML list and the JSON string. `ConfigController` adds `proxy: { passthrough }` to `/config.js` when `app.proxy.enabled` is true. The install refuses when no frontend's `copy-to-server` target points to the server. The install refuses when an integrated frontend's `src/lib/fhir-config.ts` does not export `toRequestUrl`. The install refuses when the server's `ConfigController.java` does not read `app.proxy`. The install refuses when the server's `FhirServers.java` is absent. The install refuses when the server's `GlobalCorsConfiguration.java` is present and has no `/proxy` mapping ahead of `/**`. The feature adds `DEV_SERVER_URL=http://localhost:8080` to the `.env.development` of each integrated frontend. The `vite.config.ts` templates forward `/proxy`, `/config.js`, `/fhir`, and `/auth` to `DEV_SERVER_URL` when it is set. The `frontend` generator's `proxy` option has no schema default. The generator prompts for it only when a server is integrated and the run is interactive. When the integrated server already has the `frontend-proxy` feature, the generator asks no question and adds the `DEV_SERVER_URL` line to the generated frontend for any value of the option. The generator turns a refusal of the runner into a warning. `minHapiVersion` is 8.8.0, verified by the unit tests and the IT under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

The four auth features of the resource server are `auth-resource`, `auth-udap`, `auth-smart`, and `auth-scopes`. `auth-udap` and `auth-scopes` declare `requires: ['auth-resource']`, and `auth-smart` declares `requires: ['auth-resource', 'auth-scopes']`. Each install writes its `enabled` key as `false` to `src/test/resources/config/application.yaml` and to `src/test/resources/application-test.yaml`. The key is `app.auth.enabled` for `auth-resource` and `app.auth.udap.enabled`, `app.auth.smart.enabled`, or `app.auth.scopes.enabled` for the others. The integration test of each feature uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. Each feature leaves `pom.xml` unchanged. Each feature has `minHapiVersion` 8.8.0, verified by the unit tests and the integration test under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

The `auth-resource` feature writes `BearerTokenInterceptor`, `AuthResourceProperties`, `AuthResourceConfig`, `IssuerMetadata`, `FhirBaseUrl`, `TrustAllSslContext`, `WellKnownInterceptor`, the unit tests `BearerTokenInterceptorTest` and `FhirBaseUrlTest` with the helper `TestCertificates`, `AuthResourceIT` (failsafe), `TestIssuer` (the issuer of the integration tests of `auth-resource`, `auth-udap`, `auth-smart`, and `auth-scopes`), `app.auth` in `application.yaml`, and `AUTH-RESOURCE.md`. After a valid token, `RequestDetails.getUserData()` holds the verified claims under `BearerTokenInterceptor.CLAIMS_KEY` (`auth.claims`) as an unmodifiable `Map<String, Object>`. The install replaces `app.auth` with `enabled: true`, `issuer`, `audience` when given, `public-endpoints: []`, and `ssl-verify`. The install writes `ssl-verify: false` only for an `https` issuer with the host `localhost`. The install writes `bypass-header` as the comment line `# bypass-header: X-Bypass-Auth`, and the bypass is off. `auth-udap`, `auth-smart`, and `auth-scopes` write their map under `app.auth` through `setAuthMap` of `auth-resource.ts`, which moves the `bypass-header` comment line to the line before the map of the first of those installs, and a later install leaves the line there. A test that does not set `app.auth.enabled` to true runs with the check off. The `issuer` option has no schema default. `collectOptions` gives the `issuer` option the default `https://udap-security.fast.hl7.org`. With no `issuer` option, an interactive run shows a `select` of that default, `https://localhost:5001`, and Other, which opens a text input. The `audience` option has no default. The generator refuses an `issuer` that is not an absolute `http` or `https` URL.

The `auth-udap` feature writes `UdapProperties`, `UdapCertificate`, `UdapCertificateFetcher`, `UdapMetadata`, `UdapConfig`, the unit tests `UdapMetadataTest`, `UdapConfigTest`, and `UdapCertificateFetcherTest`, `AuthUdapIT` (failsafe), `app.auth.udap` in `application.yaml`, and `AUTH-UDAP.md`. `UdapConfig` registers a `WellKnownInterceptor` for `/.well-known/udap` on the `RestfulServer` when `app.auth.enabled` and `app.auth.udap.enabled` are true. `UdapConfig` publishes the bean `udapCertificate` of type `KeyStore.PrivateKeyEntry` when `app.auth.enabled` and `app.auth.udap.enabled` are true. `cert-password` has no generator option, and the environment variable `APP_AUTH_UDAP_CERTPASSWORD` sets it. The only generator option is `certFile`, with no default. The generator writes `cert-file` when it gets a `certFile` and `fetch-cert: true` when it gets none. The install adds the line `generated-cert.pfx` to the `.gitignore` of the server project. The `udap` classes use `AuthResourceProperties`, `IssuerMetadata`, `FhirBaseUrl`, `TrustAllSslContext`, and `WellKnownInterceptor` of the `auth` package. The `udap` tests use `TestCertificates` and `TestIssuer` of the `auth` package. `UdapConfig` reads `app.auth.issuer` and `app.auth.ssl-verify` from `AuthResourceProperties`.

The `auth-smart` feature writes `SmartProperties`, `SmartConfiguration`, `SmartConfig`, the unit test `SmartConfigurationTest`, `AuthSmartIT` (failsafe), `app.auth.smart` in `application.yaml`, and `AUTH-SMART.md`. `SmartConfig` registers a `WellKnownInterceptor` for `/.well-known/smart-configuration` on the `RestfulServer` when `app.auth.enabled` and `app.auth.smart.enabled` are true. `SmartConfiguration` reads `{issuer}/.well-known/openid-configuration` through `IssuerMetadata`. The install writes `app.auth.smart` with `enabled: true` and the `capabilities` of `SMART_CAPABILITIES` in `auth-smart.ts`. The list has the capability names of the set "Clinician Access for Standalone". `permission-patient` gives access only when the token has a `patient` claim. `permission-patient`, `permission-user`, `permission-v1`, and `permission-v2` hold only while `app.auth.scopes.enabled` is true. The list has no `context-standalone-patient`, which the set "Patient Access for Standalone" needs. No SMART client has run against a generated server. The generator has no option other than `project`, and its `collectOptions` asks no question.

The `auth-scopes` feature writes `ScopeProperties`, `SmartScope`, `ScopeAuthorizationInterceptor`, `PatientSearchNarrowingInterceptor`, `ScopeConfig`, the unit test `SmartScopeTest`, `AuthScopesIT` (failsafe), `app.auth.scopes` in `application.yaml`, and `AUTH-SCOPES.md`. `ScopeAuthorizationInterceptor` and `PatientSearchNarrowingInterceptor` read the claims under `BearerTokenInterceptor.CLAIMS_KEY`. The generator has no option other than `project`, and its `collectOptions` asks no question.

The `auth-login` feature declares `requires: ['frontend-proxy']`. It writes `LoginClients`, `LoginSession`, `LoginFilter`, `IdTokenCheck`, `LoginController`, the unit tests `LoginClientsTest`, `LoginFilterTest`, and `LoginControllerTest`, `AuthLoginIT` (failsafe), and `AUTH-LOGIN.md`. It also writes `UdapClient`, the unit test `UdapClientTest`, and the test helper `LoginTestKeys`. The install adds the `com.nimbusds:oauth2-oidc-sdk` 11.26 pom dependency and writes `app.login.enabled: true`, `app.login.ssl-verify: true`, `server.servlet.session.cookie.same-site: lax`, and `server.servlet.session.tracking-modes: cookie` to `application.yaml`. The install writes `app.login.udap.client-name` (the name of the server project), `app.login.udap.contact: mailto:admin@localhost`, `app.login.udap.logo-uri: https://build.fhir.org/icon-fhir-16.png`, and after `logo-uri` the comment line `# scope: openid fhirUser launch/patient patient/*.rs user/*.rs`. The `login` package reads the `udapCertificate` bean through an `ObjectProvider` and imports nothing of the `auth` and `udap` packages. `ConfigController` adds `login: {}` to `/config.js` when `app.login.enabled` is true. The install refuses when no frontend's `copy-to-server` target points to the server. The install refuses when an integrated frontend's `src/lib/fhir-config.ts` does not export `APP_REQUEST_HEADER` or its `src/components/sign-in-section.tsx` is absent. The install refuses when the server's `ConfigController.java` is absent or does not read `app.login`. `isUnder` and `urlValue` of `ProxyDestinations` and `base()` of `ProxyHttpClients` are public. The generator has no option other than `project`, and its `collectOptions` runs the install check and asks no question. `minHapiVersion` is 8.8.0, verified by the unit tests and the integration test under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

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
