# nx-fhir

An Nx plugin for building FHIR servers and frontends.

## Features

- Generate complete FHIR server projects based on [HAPI FHIR JPA Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- Import a pre-existing HAPI FHIR server as an Nx project without modifying its source
- Scaffold TanStack Router-based React frontend SPAs with browser or clinical templates
- Generate custom FHIR operations from OperationDefinition resources
- Add FHIR Implementation Guides to your server
- Add packaged server features such as scheduled `$bulk-publish` bulk data publication, OpenTelemetry instrumentation, a same-origin proxy for frontend requests to other FHIR servers, and a bearer token check on the FHIR endpoint
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

A directory that runs Nx through the Nx wrapper is converted. `create-nx-fhir .` moves the plugins from the `installation` block of `nx.json` into a `package.json`, installs them, and removes the wrapper files `.nx/nxw.js`, `nx`, and `nx.bat`.

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
- `--proxy`: Install the `frontend-proxy` feature on the integrated server. When the integrated server already has the `frontend-proxy` feature, the generator asks no question and adds the `DEV_SERVER_URL` line to the generated frontend, for any value of the option. Otherwise, without the option, the generator asks when it integrates a server in an interactive run, and in all other runs it does not install the proxy. If the feature cannot install, the generator prints a warning and continues without the proxy.

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

### Feature

Add a packaged feature to an existing server project:

```sh
nx g nx-fhir:feature
```

This prompts for the server project and the feature to install, then collects the feature's own options. Each feature can also be installed directly through its own generator (for example `nx g nx-fhir:feature-bulk-publish`).

Installed features are recorded in the server's `project.json`, and installing the same feature twice is rejected. Every feature declares the range of HAPI FHIR releases its generated code is verified against, and the generator refuses to install into a server outside that range. Run `update-server` first to bring the server into range.

The generated code becomes part of your server source. Treat it as a starting point: authentication, authorization, and other deployment concerns remain the responsibility of your server implementation.

#### Bulk Publish

Adds spec-conformant `$bulk-publish` bulk data publication to a server:

```sh
nx g nx-fhir:feature-bulk-publish
```

A scheduled publisher exports the configured resource types to gzipped ndjson snapshot files and serves them behind a `$bulk-publish` manifest endpoint. Unchanged data keeps identical file URLs between publish runs, and a dataset with no changes publishes nothing new. A resource type that fails to export is reported through an `OperationOutcome` ndjson file referenced by the manifest instead of stopping the publish run.

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--resourceTypes`: Comma-separated resource types to publish; an entry may carry a search filter, e.g. `Organization,Patient?active=true`; required unless `--allTypes` is set
- `--allTypes`: Publish every resource type the server supports; required when `--resourceTypes` is omitted
- `--intervalMs`: Publish interval in milliseconds (default: `60000`)
- `--transactionLagMs`: How far behind the export start each snapshot claims its `transactionTime`, in milliseconds (default: `60000`)
- `--storagePath`: Snapshot storage path relative to the server working directory (default: `./publish-data`)
- `--resetOnStartup`: Delete published snapshots on server startup (default: `false`)
- `--publicBaseUrl`: Public base URL used in manifest file links when the server sits behind a proxy

**Example:**
```sh
nx g nx-fhir:feature-bulk-publish --project=my-fhir-server --resourceTypes=InsurancePlan,MedicationKnowledge --intervalMs=300000
```

The manifest and snapshot files are served without authentication (`requiresAccessToken: false`), so the configured resource type list defines what your server makes public. Only list resource types your deployment intends to expose. With `--allTypes`, every type the server supports is published, narrowed by `hapi.fhir.supported_resource_types` when set; the server logs the resolved list on its first publish run.

The generated configuration lives under `publish:` in `application.yaml`. Additional tuning keys the generator does not write can be added there: `publish.retention`, `publish.grace-period-ms`, and `publish.export-page-size`.

Requires HAPI FHIR 7.4.0 or later. The generated `BulkPublishIT` integration test runs under `mvn verify`.

#### OpenTelemetry (otel)

Adds OpenTelemetry route tagging and a baseline Grafana dashboard to a server:

```sh
nx g nx-fhir:feature-otel
```

The OpenTelemetry Java agent records the server's HTTP spans, metrics, and logs. The generated interceptor sets a bounded `http.route` on each request, such as `/fhir/{type}/{id}`, so the signals group by FHIR interaction and the route count does not grow with the resource types clients request. Search query strings stay out of spans and the request log unless `telemetry.capture-query-strings` is `true` in `application.yaml`. The generator also writes `OTEL.md` to the server root, which lists the generated files, the agent settings, and the run commands.

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--serviceName`: The `service.name` resource attribute and the Grafana dashboard uid; up to 40 letters, digits, `_` or `-` (default: the project name)
- `--dashboard`: Write a baseline Grafana dashboard and its provisioning file under `otel/grafana/`; the dashboard shows request and operation totals, the last server start, and starts in the selected range, resource types, interactions, and operations from a bounded request counter, and the CPU and memory use of the JVM (default: `true`)
- `--compose`: Write `docker-compose.otel.yml`, which runs the server next to a local `grafana/otel-lgtm` stack (default: `true`)
- `--serve`: Enable `nx serve <project-name> --otel`, which runs the server with the OpenTelemetry Java agent attached (default: `true`)

**Example:**
```sh
nx g nx-fhir:feature-otel --project=my-fhir-server --compose=false
```

`nx serve <project-name> --otel` downloads the agent with `mvn dependency:copy` and attaches it to the server. The agent sends OTLP over HTTP to `http://localhost:4318`, so run a collector there or set `OTEL_EXPORTER_OTLP_ENDPOINT`. The serve executor accepts `--otel` only on a server that has this feature installed with the `serve` option.

Requires HAPI FHIR 8.0.0 or later.

#### Frontend Proxy (frontend-proxy)

Adds a same-origin proxy that the integrated frontend uses for requests to other FHIR servers:

```sh
nx g nx-fhir:feature-frontend-proxy
```

The server gets the endpoint `/proxy`. The frontend sends a request for the bundled server to `/fhir` and a request for any other server to `/proxy?url=<destination>`, so the browser needs no CORS permission from the other servers. The proxy forwards each destination under a listed server of `app.fhir.servers`, internal hosts included. With passthrough on, it also forwards any other destination through a guard that permits public addresses only. It refuses all other destinations with status 403. The install needs a frontend that is integrated with the server. Run `update-frontend` first if the frontend or the server integration files have no proxy support. The generator also writes `FRONTEND-PROXY.md` to the server root, which gives the configuration and the classification rules.

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--passthrough`: Permit requests to any public server that the user enters (default: `false`)

**Example:**
```yaml
app:
  fhir:
    servers:
      - name: Payer sandbox
        url: https://payer.example.org/fhir
      - name: EHR
        url: http://ehr:8080/fhir
  proxy:
    enabled: true
    passthrough: false
    connect-timeout: 5s
    read-timeout: 60s
```

WARNING: With `app.proxy.passthrough: true`, anyone who can reach the application can send requests through it to any public host. Use this only for a test deployment.

Each entry in `app.fhir.servers` needs a `name` and a `url`. The `url` is an absolute `http` or `https` URL with a host and no user information, query, or fragment, or a root-relative path such as `/fhir`. A value that is not valid stops the server at startup. This check is in the integration files of the frontend generator, so it also applies to a server with no proxy feature after `update-frontend`. Set `app.fhir.servers` in one form only, either a YAML list as above or one string that holds a JSON array of `name` and `url` entries.

A root-relative entry is the server itself. The frontend requests it directly on the origin of the page. The proxy does not use it as a listed server. In proxy mode the frontend does not list an entry that equals "This server" a second time.

The proxy cannot forward a form-encoded `PUT`, `PATCH`, or `DELETE` body or a multipart body. Spring reads these bodies before the proxy runs, and the proxy answers 400. A form-encoded `POST` passes.

If the `vite.config.ts` of a project already has a `server` block, `update-frontend` can leave two `server` keys in the file. Merge the `proxy` entry into the existing block by hand.

Requires HAPI FHIR 8.8.0 or later.

#### Auth Resource (auth-resource)

Adds a bearer token check to the FHIR endpoint of a server:

```sh
nx g nx-fhir:feature-auth-resource
```

The check applies to each request under `/fhir`. A request needs the header `Authorization: Bearer <token>` with a JSON Web Token (JWT) from an issuer of `app.auth.issuers`. When an issuer entry has no `jwks-uri`, the server reads `{issuer}/.well-known/openid-configuration` at the first token from that issuer. After a valid token, `RequestDetails.getUserData()` holds the verified claims under the key `BearerTokenInterceptor.CLAIMS_KEY`. The generator also writes `AUTH-RESOURCE.md` to the server root, which gives the configuration and the request rule.

`GET` and `HEAD` requests to `/fhir/metadata` pass with no token. Each request under `/fhir/.well-known/` passes with no token. A paging request (`_getpages`) that HAPI FHIR gives to its paging handler passes with no token. An entry of `app.auth.public-endpoints` names a resource type (`Practitioner`), a server-level operation (`$bulk-publish`), or an operation on a type (`Patient/$match`). A request that fits an entry passes with no token, for each request method. When `app.auth.enabled` is `true`, an entry in a different form stops the server at startup.

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--issuer`: Token issuer URL, an absolute `http` or `https` URL. The `iss` claim of a token must be equal to it. The generator writes `enabled: true` when this option is given.
- `--audience`: Value that the `aud` claim of a token must contain. Needs `--issuer`.

**Example:**
```yaml
app:
  auth:
    enabled: true
    issuers:
      - issuer: https://issuer.example.org
        audience: https://fhir.example.org/fhir
        jwks-uri: https://issuer.example.org/keys
    public-endpoints:
      - $bulk-publish
      - Practitioner
      - Patient/$match
    # bypass-header: X-Bypass-Auth
```

WARNING: With `app.auth.bypass-header` set, each caller that sends this header skips the token check. Remove the property for a deployment that has data that is not public.

A request that has the header that `app.auth.bypass-header` names passes with no token. The generated `application.yaml` has the comment line `# bypass-header: X-Bypass-Auth`, so the bypass is off after the install. To turn on the bypass, remove `# ` from that line.

With `app.auth.enabled: false`, the server has no check. With `app.auth.enabled: true`, `app.auth.issuers` needs at least one entry, and the server stops at startup with none. An issuer entry with no `issuer` stops the server at startup. The install writes `app.auth.enabled: false` to `src/test/resources/config/application.yaml` and to `src/test/resources/application-test.yaml`. A test that does not set `app.auth.enabled` to `true` runs with no check.

Requires HAPI FHIR 8.8.0 or later.

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

Convert a workspace that runs Nx through the Nx wrapper with `create-nx-fhir .` before you run `nx migrate`, because the Nx 22 wrapper fails with `Cannot find module './installation/node_modules/nx/bin/nx'` once a migration moves the workspace to Nx 23.

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
