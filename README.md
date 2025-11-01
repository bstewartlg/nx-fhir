# nx-fhir

## Development Setup

**NOTE**: These instructions assume the use of [bun](https://bun.sh/) as the package manager and runtime. However, everything should still work with `npm`.

Install dependencies and build the project:

```sh
bun install
bun run build
```

### Publishing Local NPM Package

Start up Verdaccio to host a local npm repository:

```sh
bun nx run @nx-fhir/source:local-registry
```

In another terminal window:

```sh
bun nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873
```

This should publish all packages to the local registry and allow you to run the `create-nx-fhir` package from the local registry:

```sh
bunx create-nx-fhir
```

To continuously build and locally republish all packages as changes are made (note: --initialRun combined with --all currently does not behave as expected: <https://github.com/nrwl/nx/issues/32281>):

```sh
bun nx watch --initialRun --all -- npx nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873
```

### Development

Make `nx-fhir` generators available on local system:

```sh
bun run build
cd dist/packages/nx-fhir
bun link
bun install --production
```

In root of some other Nx workspace, link the `nx-fhir` package:

```sh
bun link nx-fhir
```

Run a generator in that workspace:

```sh
bun nx g nx-fhir:server # or nx-fhir:operation if server was already created
```

## Testing

Run end-to-end server test:

```sh
bun run e2e
```

To run the e2e tests with a specific package manager for all of the build/install/generate tasks (bun or npm):

```sh
PACKAGE_MANAGER=npm npm run e2e
```

Test does the following:
- builds the `nx-fhir` package
- packs the `nx-fhir` package into a tarball
- creates a new empty Nx workspace with the Nx `apps` preset
- adds `nx-fhir` as a dev devependency using the path to the local tarball
- generates a FHIR server
- ensures that the server can be started
- queries the `/fhir/metadata` endpoint for a valid `CapabilityStatement` response
