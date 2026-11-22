# nx-fhir

An Nx plugin for building FHIR servers and frontends.

## Features

- Generate complete FHIR server projects based on [HAPI FHIR JPA Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- Import a pre-existing HAPI FHIR server as an Nx project without modifying its source
- Scaffold TanStack Router-based React frontend SPAs with browser or clinical templates
- Generate custom FHIR operations from OperationDefinition resources
- Add FHIR Implementation Guides to your server
- Add packaged server features such as scheduled `$bulk-publish` bulk data publication, OpenTelemetry instrumentation, a same-origin proxy for frontend requests to other FHIR servers, a bearer token check on the FHIR endpoint, signed UDAP metadata for an external authorization server, the SMART configuration of that server, a token scope check on the FHIR endpoint, and sign-in from the integrated frontend at the authorization server of a FHIR server
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

A feature can need a different feature, for example `auth-scopes` needs `auth-resource`. When the server does not have a required feature, the generator offers to install it first. An interactive run asks one question for each required feature that the server does not have, and yes is the default. With yes, the required feature installs first and asks its own questions. With no, the generator stops and writes nothing. A run that is not interactive installs the required feature with its defaults and asks no question. For a different issuer, run `feature-auth-resource` with `--issuer` before the feature that needs it.

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

The OpenTelemetry Java agent records the server's HTTP spans, metrics, and logs. The generated interceptor sets a bounded `http.route` on each FHIR request, such as `/fhir/{type}/{id}`, so the signals group by FHIR interaction and the route count does not grow with the resource types clients request. Search query strings of FHIR requests stay out of spans and the request log unless `telemetry.capture-query-strings` is `true`, in `application.yaml` or through the environment variable `TELEMETRY_CAPTURE_QUERY_STRINGS`. The generator also writes `OTEL.md` to the server root. That file names the generated classes and tests and gives the route templates, the metrics, and the agent settings, and for the options that are on, the dashboard panels and the run commands ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-otel/files/docs/OTEL.md.template)).

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--serviceName`: The `service.name` resource attribute and the Grafana dashboard uid; up to 40 letters, digits, `_` or `-` (default: the project name)
- `--dashboard`: Write a baseline Grafana dashboard and its provisioning file under `otel/grafana/` (default: `true`)
- `--compose`: Write `docker-compose.otel.yml`, which runs the server next to a local `grafana/otel-lgtm` stack (default: `true`)
- `--serve`: Enable `nx serve <project-name> --otel`, which runs the server with the OpenTelemetry Java agent attached (default: `true`)

**Example:**
```sh
nx g nx-fhir:feature-otel --project=my-fhir-server --compose=false
```

With `nx serve <project-name> --otel`, the agent sends OTLP over HTTP to `http://localhost:4318`, so run a collector there or set `OTEL_EXPORTER_OTLP_ENDPOINT`. The serve executor accepts `--otel` only on a server that has this feature installed with the `serve` option.

Requires HAPI FHIR 8.0.0 or later.

#### Frontend Proxy (frontend-proxy)

Adds a same-origin proxy that the integrated frontend uses for requests to other FHIR servers:

```sh
nx g nx-fhir:feature-frontend-proxy
```

The server gets the endpoint `/proxy`. The frontend sends a request for the bundled server to `/fhir` and a request for any other server to `/proxy?url=<destination>`, so the browser needs no CORS permission from the other servers. The proxy forwards each destination under a listed server of `app.fhir.servers`, internal hosts included. With passthrough on, it also forwards any other destination through a guard that permits public addresses only. The install needs a frontend that is integrated with the server. Run `update-frontend` first if the frontend or the server integration files have no proxy support. The generator also writes `FRONTEND-PROXY.md` to the server root. That file lists the generated files and gives the configuration keys, the forms and rules of `app.fhir.servers`, the classification of a destination, and the development mode ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-frontend-proxy/files/docs/FRONTEND-PROXY.md.template)).

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

The install also writes `server.forward-headers-strategy: native`. Behind a reverse proxy that ends TLS, the server then sees the `https` origin of the page. The key applies to each request of the server, and Tomcat takes the forwarded headers only from a trusted proxy address.

The server checks `app.fhir.servers` at startup, and a value that is not valid stops the server. This check is in the integration files of the frontend generator, so it also applies to a server with no proxy feature after `update-frontend`.

The proxy cannot forward a form-encoded `PUT`, `PATCH`, or `DELETE` body or a multipart body. Spring reads these bodies before the proxy runs, and the proxy answers 400. A form-encoded `POST` passes.

If the `vite.config.ts` of a project already has a `server` block, `update-frontend` can leave two `server` keys in the file. Merge the `proxy` entry into the existing block by hand.

Requires HAPI FHIR 8.8.0 or later.

#### Auth Resource (auth-resource)

Adds a bearer token check to the FHIR endpoint of a server:

```sh
nx g nx-fhir:feature-auth-resource
```

When `app.auth.enabled` is `true`, each request under `/fhir` needs the header `Authorization: Bearer <token>` with a JSON Web Token (JWT) from the issuer of `app.auth.issuer`, other than the requests below that pass with no token. With `app.auth.enabled: false`, the server has no check. The generator also writes `AUTH-RESOURCE.md` to the server root. That file lists the generated files and gives the configuration that the install writes, each `app.auth` property, the request rule, the responses, and the use of the verified claims in a custom interceptor ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-auth-resource/files/docs/AUTH-RESOURCE.md.template)).

`GET` and `HEAD` requests to `/fhir/metadata` pass with no token. Each request under `/fhir/.well-known/` passes with no token. A request that fits an entry of `app.auth.public-endpoints` passes with no token, for each request method. A public resource type also makes its operations public, for example `Patient/$everything`. A request for a later page of a search or of the result of an operation (`_getpages`) passes with no token, so a page link works for each caller who has it.

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--issuer`: Token issuer URL, an absolute `http` or `https` URL (default: `https://udap-security.fast.hl7.org`). The `iss` claim of a token must be equal to it. With no `--issuer`, an interactive run shows a list of three choices: `https://udap-security.fast.hl7.org` (public FAST security server, selected), `https://localhost:5001` (local FAST security server), and Other, which asks for the URL.
- `--audience`: Value that the `aud` claim of a token must contain.

**Example:**
```sh
nx g nx-fhir:feature-auth-resource --project=my-fhir-server
```

WARNING: With `app.auth.bypass-header` set, each caller that sends this header skips the token check. Remove the property for a deployment that has data that is not public.

The install writes the comment line `# bypass-header: X-Bypass-Auth`, and the bypass is off. The install writes `ssl-verify: false` when the issuer is an `https` URL with the host `localhost`, and `ssl-verify: true` for each other issuer.

WARNING: With `app.auth.ssl-verify: false`, the server accepts any certificate from the hosts it calls. Use it only with a local development certificate.

Requires HAPI FHIR 8.8.0 or later.

#### Auth UDAP (auth-udap)

Adds signed UDAP metadata at `/fhir/.well-known/udap` to a server:

```sh
nx g nx-fhir:feature-auth-udap
```

The feature needs the `auth-resource` feature.

When `app.auth.enabled` and `app.auth.udap.enabled` are both `true`, the server answers `GET {baseURL}/.well-known/udap` with the UDAP metadata of the HL7 FAST security IG (STU2 2.0.0). The metadata gives a client the endpoints of the authorization server of `app.auth.issuer`. The request needs no token. The generator also writes `AUTH-UDAP.md` to the server root. That file lists the generated files and gives the configuration that the install writes, the certificate routes, the source of each metadata value, the IG rules for the lists, and the cases that stop startup ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-auth-udap/files/docs/AUTH-UDAP.md.template)).

**Options:**
- `--project`: Name of the Nx server project to add the feature to
- `--certFile`: Path of a PKCS#12 certificate file. With no value, an interactive run asks for the path, and an empty path turns on the fetch of a test certificate from the issuer.

**Example:**
```sh
nx g nx-fhir:feature-auth-udap --project=my-fhir-server
```

With no certificate file path, the install writes `fetch-cert: true`. At startup, the server then loads `generated-cert.pfx` from its working directory. When that file is absent, the server sends `POST {issuer}/api/cert/generate` with its base URL and a password and writes the response of a successful try to `generated-cert.pfx`. The file `generated-cert.pfx` holds a private key. The generator adds this file name to the `.gitignore` of the server project.

WARNING: A fetched certificate comes from a test authority, and its private key is made by a different server. Use the fetch only for development.

To use a certificate file of your own, give its path with `--certFile`:

```sh
nx g nx-fhir:feature-auth-udap --project=my-fhir-server --certFile=certs/udap.p12
```

The generator does not write `cert-password`. Before you start the server, set `cert-password` in `application.yaml` or with the environment variable `APP_AUTH_UDAP_CERTPASSWORD`.

`app.auth.ssl-verify` of the `auth-resource` feature also applies to the certificate fetch and to the read of the UDAP metadata of the issuer.

WARNING: With `app.auth.ssl-verify: false`, the server accepts any certificate from the hosts it calls. Use it only with a local development certificate.

Requires HAPI FHIR 8.8.0 or later.

#### Auth SMART (auth-smart)

Adds the SMART configuration at `/fhir/.well-known/smart-configuration` to a server:

```sh
nx g nx-fhir:feature-auth-smart
```

The feature needs the `auth-resource` and `auth-scopes` features.

When `app.auth.enabled` and `app.auth.smart.enabled` are both `true`, the server answers `GET {baseURL}/.well-known/smart-configuration` with the SMART configuration document that SMART App Launch 2.2.0 defines. A SMART client reads the document to find the endpoints of the authorization server of `app.auth.issuer`. The server builds the document from the list `app.auth.smart.capabilities` and from the OpenID discovery document of the issuer at `{issuer}/.well-known/openid-configuration`. The request needs no token. The generator also writes `AUTH-SMART.md` to the server root. That file names the generated classes and tests and gives the configuration that the install writes, the source of each member, and the cases of status 503 ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-auth-smart/files/docs/AUTH-SMART.md.template)).

**Options:**
- `--project`: Name of the Nx server project to add the feature to

**Example:**
```sh
nx g nx-fhir:feature-auth-smart --project=my-fhir-server
```

The generated `capabilities` list holds eight starter capabilities. The capabilities `permission-patient`, `permission-user`, `permission-v1`, and `permission-v2` are true only while `app.auth.scopes.enabled` is `true`. Write only the capabilities that your authorization server and this server both support.

Requires HAPI FHIR 8.8.0 or later.

#### Auth scopes (auth-scopes)

Adds a token scope check to the FHIR endpoint of a server:

```sh
nx g nx-fhir:feature-auth-scopes
```

The feature needs the `auth-resource` feature.

The server reads the `scope` claim of the verified token of a FHIR request, and a request gets status 403 when no scope of the token covers its resource type and its action. A resource scope has the SMART App Launch 2.2.0 form `(patient|user|system)/(Type|*).(permissions)`, and a scope in a different form, for example with a `?` suffix, grants nothing. `user/` and `system/` scopes cover each resource of their type, and a `patient/` scope covers the resources of its type in the Patient compartment of the patient that the `patient` claim of the token names. With a `patient/` scope, the server adds the patient of the claim to a type search, so the search matches only resources in the Patient compartment of that patient. A type that a `user/` or `system/` scope of the token with `s` covers gets no narrowing, and neither do the entries of a transaction or a batch.

A request with no verified claims, for example `metadata` or a request with the bypass header, passes with no check. A request for an operation gets status 403 unless a scope of the token, with any letters, has the type `*` or the type of the operation. When GraphQL is on, a request for `$graphql` gets status 403 for each token. A `user/` or `system/` scope covers the operation at each level, and a `patient/` scope covers only an operation at instance level on the Patient of the `patient` claim. A direct request for an operation that the token can call gets no scope check, also for the reads and writes that the operation makes. A later page (`_getpages`) of a search or of the result of an operation gets no scope check, so a resource that `_include` or `_revinclude` puts on a later page needs no scope. A conditional create, update, patch, or delete, and a write with a reference in the form of a search, for example `Encounter?identifier=123`, also need a `user/` or `system/` scope with `s` on the type that the search reads. A token with only `patient/` scopes can make no such request.

The generator also writes `AUTH-SCOPES.md` to the server root. That file lists the generated files and gives the configuration that the install writes, the scope forms, the requests that each letter allows, the rules for transactions and batches, the search narrowing, the answers to a refused request, and the methods to change for different rules ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-auth-scopes/files/docs/AUTH-SCOPES.md.template)).

**Options:**
- `--project`: Name of the Nx server project to add the feature to

**Example:**
```sh
nx g nx-fhir:feature-auth-scopes --project=my-fhir-server
```

Requires HAPI FHIR 8.8.0 or later.

#### Auth login (auth-login)

Adds sign-in at the authorization server of a FHIR server to the integrated frontend:

```sh
nx g nx-fhir:feature-auth-login
```

The feature needs the `frontend-proxy` feature and a frontend that is integrated with the server. When a frontend or the server integration files need `update-frontend`, the install refuses and names the command.

A tester saves the client id, the client secret, and the scopes in the settings dialog of the frontend. This server keeps these client values in the session of the tester until the session ends or a save for the same FHIR server replaces them. The tester then signs in at the authorization server of the selected FHIR server from the dialog, or from the sign-in page that a `clinical` frontend shows when the FHIR server answers 401. The sign-in is a SMART standalone launch with PKCE. This server is the OAuth client and keeps the access token in the session of the tester. It adds the token to the requests of the frontend for the signed-in server. The generator also writes `AUTH-LOGIN.md` to the server root, with the configuration and the behavior of the feature ([template](https://github.com/bstewartlg/nx-fhir/blob/main/packages/nx-fhir/src/generators/feature-auth-login/files/docs/AUTH-LOGIN.md.template)).

Register the callback URL `{origin}/auth/callback` at the authorization server, where `{origin}` is the origin of the page. This server offers sign-in for itself only when it serves a document at `/fhir/.well-known/smart-configuration`, for example with the `auth-smart` feature. Sign-in at a server that the tester types as a custom URL needs `app.proxy.passthrough: true`.

**Options:**
- `--project`: Name of the Nx server project to add the feature to

The install writes these values to `application.yaml`:

```yaml
app:
  login:
    enabled: true
    ssl-verify: true
server:
  servlet:
    session:
      cookie:
        same-site: lax
      tracking-modes: cookie
```

The sign-in accepts plain `http` only for `localhost`, names that end in `.localhost`, and loopback addresses. On a different host, the address of the app, each listed or typed FHIR server, and each authorization server must use `https`.

WARNING: On plain `http`, the client secret, the authorization code, and the access token travel in clear text.

WARNING: With `app.login.ssl-verify: false`, the sign-in trusts each certificate and each host name of this server, the listed servers, and their authorization servers. The signature check of an ID token then proves nothing, because a different host can answer the request for the key set. Use this only for a test deployment.

WARNING: `X-App-Request` or `*` in `hapi.fhir.cors.allowed_headers`, or in the allowed headers of `GlobalCorsConfiguration`, lets a page of another origin send the header. The request proof then rests on `Sec-Fetch-Site` alone.

Behind a reverse proxy that ends TLS, the cookie has the `Secure` attribute, because the `frontend-proxy` install writes `server.forward-headers-strategy: native`.

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
