# nx-fhir E2E Tests

This directory contains end-to-end tests for the nx-fhir plugin and the create-nx-fhir CLI.

## Running Tests

To run all e2e tests:

```bash
bun run e2e
```

To run with npm for the install/build/generate tasks inside the generated test workspaces (the plugin itself is always built and packed with bun):

```bash
PACKAGE_MANAGER=npm bun run e2e
```

## Test Suites

- `tests/server.e2e.spec.ts`: server generation, custom operation, implementation guide, serve and metadata query, frontend templates (build, test, copy-to-server)
- `tests/create-nx-fhir.e2e.spec.ts`: full end-user flow against an ephemeral local Verdaccio registry, including workspace creation, in-place init, and existing-server import
- `tests/migration.e2e.spec.ts`: server and frontend migrations via three-way merge

The suites run sequentially (`fileParallelism: false`) because they build and serve real servers and share the packed plugin output.
