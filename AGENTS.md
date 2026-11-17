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
| `feature-auth-smart` | Adds the SMART configuration at `/fhir/.well-known/smart-configuration` to a server on top of `feature-auth-resource` |
| `update-server`        | Updates existing server to newer HAPI version via three-way merge    |
| `update-frontend`      | Updates frontend project to newer template version via three-way merge |
| `update`               | Checks for plugin, server, and frontend updates (runs during `nx migrate`) |
| `preset`               | Used by create-nx-fhir for workspace initialization                 |

The frontend template's settings dialog keeps custom request headers per server in browser storage, and `fhirFetch` attaches them to every request for the active server.

The feature framework lives in `generators/feature/` (picker `feature.ts`, runner `run-feature.ts`, `FeatureDefinition` contract `types.ts`, registry `registry.ts`). Each feature is a self-contained `generators/feature-<name>/` directory registered by one import line in `registry.ts`. The runner records installs in a `features` manifest in the server's project.json and rejects reinstalls. The manifest leaves out each option whose value is an empty string, `null`, or `undefined`. The runner installs each absent feature that `requires` of a `FeatureDefinition` names before that feature. Before such an install, an interactive run asks one question with yes as the default, a run that is not interactive asks no question, and a no stops the install with no write. A default in a thin generator's `schema.json` (CLI path) must equal the `collectOptions` default (picker and programmatic path). Thin generators drop undefined values before calling `runFeature`. Every `FeatureDefinition` declares the inclusive HAPI range its generated Java is verified against (`minHapiVersion`, optional `maxHapiVersion`); the runner enforces it before prompting or writing, reading the hapi-fhir parent version from the server's `pom.xml`, and a pom with no readable HAPI parent warns and installs.

The `bulk-publish` feature writes Maven unit tests plus `BulkPublishIT`, which runs under `mvn verify` (failsafe), not `mvn test`, and builds its `TestRestTemplate` on `SimpleClientHttpRequestFactory` so it does not depend on the starter's httpclient5 version. `BulkPublishIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. A `resource-types` entry may carry a match-URL filter (`Patient?active=true`). An empty list publishes every type the server supports per the `DaoRegistry`, including heavy types such as Binary and Bundle unless `hapi.fhir.supported_resource_types` narrows them, and the generator writes an empty list only with explicit `allTypes` consent. A type that fails to export does not stop the tick: the failure lands as an error `OperationOutcome` in the snapshot's digest-gated `OperationOutcome.ndjson`, referenced by the manifest `outcome` property, so `OperationOutcome` is rejected as a configured entry. Tuning properties the generator leaves out of `application.yaml`: `publish.retention`, `publish.grace-period-ms` (retained directory count is bounded by grace period and publish interval, not `retention` alone), `publish.export-page-size`, and `publish.public-base-url` for servers behind a proxy or servlet context path. `minHapiVersion` is 7.4.0, verified by compile, unit tests, and the IT on rendered starters from 7.4.0 through 8.8.0 under JDK 17, and by compile and unit tests on 8.12.0-2.

The `otel` feature core writes `FhirRouteInterceptor`, `TelemetryProperties`, `TelemetryConfig`, the `opentelemetry-instrumentation-api` and `opentelemetry-api` pom dependencies, `telemetry.capture-query-strings` and `telemetry.resource-types` in `application.yaml`, and `OTEL.md`. The interceptor records the `fhir.server.requests` counter with bounded `fhir.interaction`, `fhir.resource_type`, and `fhir.operation` attributes and, for a response status of 400 or more, the `fhir.server.errors` counter with `fhir.interaction` and `fhir.outcome` (`client_error` or `server_error`). `TelemetryConfig` registers the `fhir.server.start_time` gauge, the JVM start in epoch seconds, one series per JVM. `http.route` names the request shape, such as `/fhir/{type}/{id}`, and never a resource type or an operation name the server did not register. `telemetry.resource-types` in `application.yaml` limits which resource types get their own `fhir.resource_type` value. Its `dashboard`, `compose`, and `serve` options are independent toggles that default to true. `dashboard` writes a Grafana v2 dashboard and its provisioning file under `otel/grafana/`, with a Summary row of four stats (interactions and operation invocations in range, last start, starts in range), a Traffic row on the counters, and a Runtime row on the `jvm_*` gauges that the agent's `runtime-telemetry` instrumentation exports (about 50 fixed series per JVM). `compose` writes `docker-compose.otel.yml` with the server and `grafana/otel-lgtm`, plus `otel/otelcol-filter.yaml`, a collector overlay that drops the agent's HTTP duration histogram when the commented `OTELCOL_EXTRA_ARGS` and volume lines in the compose file are enabled. `serve` enables `nx serve <project> --otel`, which fetches the OpenTelemetry Java agent with `mvn dependency:copy` at `OTEL_JAVAAGENT_VERSION` from `shared/constants/versions.ts` and attaches it with `spring-boot.run.agents`. The serve executor refuses `--otel` unless the server's `features` manifest records `otel` with `serve: true`. `minHapiVersion` is 8.0.0 because the HAPI parent manages the OpenTelemetry instrumentation versions from that release. The generated Java compiles and its unit tests pass on 8.10.0-3 and 8.12.0-2. The feature edits `pom.xml` by text insertion through `shared/utils/pom-edit.ts`.

The `frontend-proxy` feature writes the `/proxy?url=<destination>` endpoint (`FrontendProxyController`, `ProxyHttpClients`, `ProxyDestinations`, `PublicAddresses`), four unit tests, `FrontendProxyControllerIT` (failsafe), the `httpclient5` pom dependency, `app.proxy.enabled` and `app.proxy.passthrough` in `application.yaml`, and `FRONTEND-PROXY.md`. `FrontendProxyControllerIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. The proxy forwards a destination under a listed server of `app.fhir.servers`. `app.fhir.servers` is a YAML list of `name` and `url` entries or one string that holds a JSON array of them. The proxy skips a root-relative entry of `app.fhir.servers` when it builds its listed servers. With `app.proxy.passthrough: true`, the proxy forwards any other destination through a second client whose `DnsResolver` refuses a host with an address that is not public. With passthrough off, the proxy answers 403 to any other destination. The controller builds its HTTP clients from `RestClient.builder()` and the `ProxyHttpClients` factories, with retries, redirects, cookies, and content decompression off. The proxy relays the upstream `Content-Length` header only for a `HEAD` request. The proxy answers 400 to a request whose declared body was already read before the controller runs. Spring reads a form-encoded `PUT`, `PATCH`, or `DELETE` body and a multipart body before the controller runs. `FhirServers`, an integration file of the frontend generator, reads both forms of `app.fhir.servers`. `FhirServers` stops startup when an entry has no `name` or its `url` is neither an absolute `http` or `https` URL with a host and no user information, query, or fragment nor a path that starts with one `/` and has no query, fragment, or backslash. `ConfigController` puts only the `name` and `url` of each entry in `fhirServers` of `/config.js`. `ConfigController` adds `proxy: { passthrough }` to `/config.js` when `app.proxy.enabled` is true. The install refuses when no frontend's `copy-to-server` target points to the server. The install refuses when an integrated frontend's `src/lib/fhir-config.ts` does not export `toRequestUrl`. The install refuses when the server's `ConfigController.java` does not read `app.proxy`. The install refuses when the server's `FhirServers.java` is absent. The install refuses when the server's `GlobalCorsConfiguration.java` is present and has no `/proxy` mapping ahead of `/**`. The feature adds `DEV_SERVER_URL=http://localhost:8080` to the `.env.development` of each integrated frontend. The `vite.config.ts` templates forward `/proxy`, `/config.js`, and `/fhir` to `DEV_SERVER_URL` when it is set. The `frontend` generator's `proxy` option has no schema default. The generator prompts for it only when a server is integrated and the run is interactive. When the integrated server already has the `frontend-proxy` feature, the generator asks no question and adds the `DEV_SERVER_URL` line to the generated frontend for any value of the option. The generator turns a refusal of the runner into a warning. `minHapiVersion` is 8.8.0, verified by the unit tests and the IT under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

The `auth-resource` feature writes `BearerTokenInterceptor`, `AuthResourceProperties`, `AuthResourceConfig`, `IssuerMetadata`, `FhirBaseUrl`, `TrustAllSslContext`, `WellKnownInterceptor`, the unit tests `BearerTokenInterceptorTest` and `FhirBaseUrlTest` with the helper `TestCertificates`, `AuthResourceIT` (failsafe), `app.auth` in `application.yaml`, and `AUTH-RESOURCE.md`. `BearerTokenInterceptor` validates a bearer JWT with the Nimbus JOSE+JWT library of the starter at the pointcut `SERVER_INCOMING_REQUEST_PRE_HANDLER_SELECTED`. `AuthResourceConfig` registers `BearerTokenInterceptor` on the `RestfulServer`. `AuthResourceProperties` holds `app.auth.enabled`, `app.auth.issuer`, `app.auth.audience`, `app.auth.jwks-uri`, `app.auth.public-endpoints`, `app.auth.bypass-header`, and `app.auth.ssl-verify` (default true). `app.auth.audience` and `app.auth.jwks-uri` are optional. With no `jwks-uri`, the interceptor gets `jwks_uri` from `{issuer}/.well-known/openid-configuration` at the first token. When that read, the key set read, or the check of the discovery document or of `app.auth.jwks-uri` fails, or the key source refuses a key set read (two reads in 30 seconds), a request with a token gets status 503 with a fixed text and no `WWW-Authenticate` header, and the reason goes to one WARN line. `IssuerMetadata` reads `{issuer}/.well-known/{name}` and keeps the result after a success. The reads of `IssuerMetadata` have a connect timeout of 5 seconds and a read timeout of 10 seconds. `WellKnownInterceptor` answers a `GET` of its one `.well-known` path at the pointcut `SERVER_INCOMING_REQUEST_PRE_PROCESSED` with status 200 and its document as `application/json`. When the supplier of its document throws, `WellKnownInterceptor` answers with status 503 and writes one ERROR line. With `app.auth.ssl-verify` false, the discovery read and the key set read accept any certificate and any host name through `TrustAllSslContext`. With `app.auth.enabled` true and `app.auth.ssl-verify` false, `AuthResourceConfig` writes one WARN line at startup. An entry of `app.auth.public-endpoints` has the form `Type`, `$operation`, or `Type/$operation` and applies to each request method. When `app.auth.enabled` is true, an entry of `app.auth.public-endpoints` in a different form stops startup. `GET` and `HEAD` requests to `/fhir/metadata` pass with no entry. Each request under `/fhir/.well-known/` passes with no entry. A `_getpages` request that HAPI gives to its paging handler passes with no token. A request that has the header that `app.auth.bypass-header` names passes. The install writes `bypass-header` as the comment line `# bypass-header: X-Bypass-Auth`, and the bypass is off. `auth-udap` and `auth-smart` write their map under `app.auth` through `setAuthMap` of `auth-resource.ts`, which moves the `bypass-header` comment line to the line before the map of the first of the two installs, and a later install leaves the line there. With `app.auth.enabled` false or absent, `AuthResourceConfig` registers no interceptor. With `app.auth.enabled` true and no `app.auth.issuer`, startup stops. The install replaces `app.auth` with `enabled: true`, `issuer`, `audience` when given, `public-endpoints: []`, and `ssl-verify`. The install writes `ssl-verify: false` only for an `https` issuer with the host `localhost`. The install writes `app.auth.enabled: false` to `src/test/resources/config/application.yaml` and to `src/test/resources/application-test.yaml`. A test that does not set `app.auth.enabled` to true runs with the check off. `AuthResourceIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. After a valid token, `RequestDetails.getUserData()` holds the verified claims under `BearerTokenInterceptor.CLAIMS_KEY` (`auth.claims`) as an unmodifiable `Map<String, Object>`. The check covers requests under `/fhir` only. The feature leaves `pom.xml` unchanged. The `issuer` option has no schema default. `collectOptions` gives the `issuer` option the default `https://udap-security.fast.hl7.org`. With no `issuer` option, an interactive run shows a `select` of that default, `https://localhost:5001`, and Other, which opens a text input. The `audience` option has no default. The generator refuses an `issuer` that is not an absolute `http` or `https` URL. `minHapiVersion` is 8.8.0, verified by the unit tests and the integration test under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

The `auth-udap` feature writes `UdapProperties`, `UdapCertificate`, `UdapCertificateFetcher`, `UdapMetadata`, `UdapConfig`, the unit tests `UdapMetadataTest`, `UdapConfigTest`, and `UdapCertificateFetcherTest`, `AuthUdapIT` (failsafe), `app.auth.udap` in `application.yaml`, and `AUTH-UDAP.md`. `auth-udap` declares `requires: ['auth-resource']`. `UdapConfig` registers a `WellKnownInterceptor` for `/.well-known/udap` on the `RestfulServer`. That interceptor answers `GET {baseURL}/.well-known/udap` with the metadata and its RS256 `signed_metadata`. Each `community` value gets the same metadata. Only `GET` gets the metadata, and a request with a different method goes on to HAPI. `FhirBaseUrl` gives the base URL, `hapi.fhir.server_address` with one trailing `/` removed or, when that property is empty, `http://localhost:{server.port}{servlet context path}/fhir`, with `server.port` 8080 when absent and one trailing `/` removed from the servlet context path. With `app.auth.enabled` or `app.auth.udap.enabled` false or absent, `UdapConfig` registers no interceptor. With `cert-file` set, `UdapConfig` loads that PKCS#12 file with `cert-password`. With no `cert-file` and with `fetch-cert` true, `UdapConfig` loads `generated-cert.pfx` from the working directory. When that file is absent, `UdapCertificateFetcher` sends `POST {issuer}/api/cert/generate` with the base URL and the password. After a try succeeds, `UdapCertificateFetcher` writes the response to `generated-cert.pfx` one time, and an error of that write stops startup with no new try. The fetch runs at startup only. The fetch makes up to `fetch-cert-retry-attempts` tries (default 10), `fetch-cert-retry-delay` milliseconds apart (default 5000). Each try has a connect timeout of 5 seconds and a limit of 30 seconds for the complete response. With no `cert-password`, the fetch sends the password `udap-test`. A set `authorization-endpoint`, `token-endpoint`, or `registration-endpoint`, or a `scopes-supported` with an entry, replaces the value that `UdapMetadata` reads from `{issuer}/.well-known/udap` through `IssuerMetadata`. A UDAP list under `app.auth.udap`, also an empty one, replaces the list that `UdapMetadata` reads from that document, and that document gives a list only when it has `udap_versions_supported`. `IssuerMetadata` reads that document at the first metadata request that needs it. The metadata request gets status 503 when a value that the metadata must have has no source. The metadata request gets status 503 when the read of `{issuer}/.well-known/udap` fails, and the next request reads the document again. With `app.auth.enabled` and `app.auth.udap.enabled` true, startup stops when `cert-file` is absent and `fetch-cert` is false or absent. A `cert-file` with no `cert-password` stops startup. A certificate file that does not load, has no RSA key, or has an RSA key shorter than 2048 bits stops startup. When the leaf certificate is not valid or has no URI alternative name equal to the base URL, `UdapConfig` writes one WARN line and startup continues. A fetch that fails after the last try stops startup. When the server makes a fetch, an `app.auth.issuer` that is not an absolute `http` or `https` URL stops startup. `UdapProperties` holds these keys under `app.auth.udap`: `enabled`, `authorization-endpoint`, `token-endpoint`, `registration-endpoint`, `scopes-supported`, `profiles-supported`, `grant-types-supported`, `authorization-extensions-supported`, `authorization-extensions-required`, `certifications-supported`, `certifications-required`, `token-endpoint-auth-signing-alg-values-supported`, `registration-endpoint-jwt-signing-alg-values-supported`, `cert-file`, `cert-password`, `fetch-cert`, `fetch-cert-retry-attempts`, and `fetch-cert-retry-delay`. `cert-password` has no generator option, and the environment variable `APP_AUTH_UDAP_CERTPASSWORD` sets it. The only generator option is `certFile`, with no default. The generator writes `cert-file` when it gets a `certFile` and `fetch-cert: true` when it gets none. The install adds the line `generated-cert.pfx` to the `.gitignore` of the server project. The install writes `app.auth.udap.enabled: false` to `src/test/resources/config/application.yaml` and to `src/test/resources/application-test.yaml`. `AuthUdapIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. The feature leaves `pom.xml` unchanged. The `udap` classes use `AuthResourceProperties`, `IssuerMetadata`, `FhirBaseUrl`, `TrustAllSslContext`, and `WellKnownInterceptor` of the `auth` package. The `udap` tests use `TestCertificates` of the `auth` package. `UdapConfig` reads `app.auth.issuer` and `app.auth.ssl-verify` from `AuthResourceProperties`. With `app.auth.ssl-verify` false, the certificate fetch and the read of `{issuer}/.well-known/udap` accept any certificate and any host name through `TrustAllSslContext`. The metadata follows the HL7 FAST security IG, STU2 2.0.0. `minHapiVersion` is 8.8.0, verified by the unit tests and the integration test under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

The `auth-smart` feature writes `SmartProperties`, `SmartConfiguration`, `SmartConfig`, the unit test `SmartConfigurationTest`, `AuthSmartIT` (failsafe), `app.auth.smart` in `application.yaml`, and `AUTH-SMART.md`. `auth-smart` declares `requires: ['auth-resource']`. `SmartConfig` registers a `WellKnownInterceptor` for `/.well-known/smart-configuration` on the `RestfulServer` when `app.auth.enabled` and `app.auth.smart.enabled` are true. `SmartConfiguration` builds the document from `app.auth.smart.capabilities` and from `{issuer}/.well-known/openid-configuration`, which `IssuerMetadata` reads at the first request that needs it. The document always has `capabilities`, `token_endpoint`, `grant_types_supported`, and `code_challenge_methods_supported`. The document copies `jwks_uri`, `authorization_endpoint`, `token_endpoint_auth_signing_alg_values_supported`, `registration_endpoint`, `scopes_supported`, `response_types_supported`, `introspection_endpoint`, and `revocation_endpoint` when the issuer document has them. The document has `issuer` only when `capabilities` has `sso-openid-connect`. `grant_types_supported` keeps `authorization_code` of the issuer list, and keeps `client_credentials` only when the issuer lists `private_key_jwt` in `token_endpoint_auth_methods_supported`. With no `grant_types_supported` in the issuer document, `grant_types_supported` is `["authorization_code"]`. `token_endpoint_auth_methods_supported` keeps `client_secret_post`, `client_secret_basic`, and `private_key_jwt` of the issuer list, and is absent when none is left. `code_challenge_methods_supported` is the issuer list with `plain` removed. A member of the issuer document with a wrong JSON type counts as absent. The request gets status 503 when the read of the issuer document fails. The request gets status 503 when the issuer document has no `token_endpoint` or no `S256` in `code_challenge_methods_supported`. The request gets status 503 when `capabilities` has `launch-ehr` or `launch-standalone` and the issuer document has no `authorization_endpoint`. The request gets status 503 when `capabilities` has `sso-openid-connect` and the issuer document has no `issuer` or no `jwks_uri`. The response is `application/json` for each `Accept` header. The install writes `app.auth.smart` with `enabled: true` and the `capabilities` of `SMART_CAPABILITIES` in `auth-smart.ts`. `SMART_CAPABILITIES` holds the capabilities that the discovery document of the default issuer supports on paper. That list satisfies the capability set "Clinician Access for Standalone". It does not satisfy "Patient Access for Standalone", because the default issuer lists no `launch/patient` scope. No SMART client has run against the default issuer. The generator has no option other than `project` and asks no question. The install writes `app.auth.smart.enabled: false` to `src/test/resources/config/application.yaml` and to `src/test/resources/application-test.yaml`. `AuthSmartIT` uses `@ActiveProfiles("test")` and sets `hapi.fhir.fhir_version` to the FHIR version of the server project. The feature leaves `pom.xml` unchanged. `minHapiVersion` is 8.8.0, verified by the unit tests and the integration test under `mvn verify` on generated servers at 8.8.0-1, 8.10.0-3, and 8.12.0-2 under JDK 17.

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
