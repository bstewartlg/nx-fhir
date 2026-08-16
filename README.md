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

To continuously build and locally republish all packages as changes are made:

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

Run unit tests:

```sh
bun run test
```

Run the full end-to-end suite:

```sh
bun run e2e
```

To run the e2e tests with a specific package manager (bun or npm) for the install/build/generate tasks inside the generated test workspaces:

```sh
PACKAGE_MANAGER=npm bun run e2e
```

The e2e suite (`e2e/nx-fhir/tests/`) covers:

- **`server.e2e.spec.ts`**: builds and packs `nx-fhir` into a tarball, creates a fresh Nx workspace, installs the tarball, generates a FHIR server, adds a custom operation from an `OperationDefinition`, serves the server on a custom port and queries `/fhir/metadata` for a valid `CapabilityStatement`, adds an Implementation Guide, then generates both frontend templates (`browser` and `clinical`), builds and unit-tests them, and verifies `copy-to-server` places the bundle in the server's static resources
- **`create-nx-fhir.e2e.spec.ts`**: publishes both packages to an ephemeral local Verdaccio registry and runs the real end-user flow: `create-nx-fhir` into a new workspace with a server, `create-nx-fhir .` in an existing directory, and importing a pre-existing HAPI server via the preset's server detection
- **`migration.e2e.spec.ts`**: generates a server on an older HAPI release, customizes it, and runs `update-server` through the three-way merge to the latest supported release; also migrates a frontend generated from a previously published plugin version via `update-frontend`. Both assert zero merge conflicts, preserved customizations, and a successful build
