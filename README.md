# nx-fhir

## Development Setup

Install dependencies and build the project:

```bash
npm ci
npm run build
```

### Publishing Local NPM Package

Start up Verdaccio to host a local npm repository:

```bash
npx nx run @nx-fhir/source:local-registry
```

In another terminal window:

```bash
npx nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873
```

Nx commands should now be available such as:

```bash
npx create-nx-fhir
```

To continuously build and locally republish all packages as changes are made (note: --initialRun combined with --all currently does not behave as expected: <https://github.com/nrwl/nx/issues/32281>):

```bash
npx nx watch --initialRun --all -- npx nx run-many --nx-bail=false -t unpublish,nx-release-publish -- --registry http://localhost:4873
```


### Continuous Development

Make `nx-fhir` generators available on local system:

```bash
npm link dist/packages/nx-fhir
```

In root of some other Nx workspace, link the `nx-fhir` package:

```bash
npm link nx-fhir
```

Run a generator in that workspace:

```bash
npx nx g nx-fhir:server # or nx-fhir:operation if server was already created
```

## Testing

Run end-to-end server test:

```bash
npx nx run nx-fhir:e2e
```

Test does the following:
- builds the `nx-fhir` package
- stands up a local npm repository
- publishes `nx-fhir` to local npm repository
- creates a new Nx workspace
- adds `nx-fhir` as a dev devependency
- generates a FHIR server
- ensures that the server can be started
- queries the `/fhir/metadata` endpoint for a valid `CapabilityStatement`
