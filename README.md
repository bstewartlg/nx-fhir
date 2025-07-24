# nx-fhir

## Development Setup

Install dependencies and build the project:

```bash
npm ci
npm run build
```

Make `nx-fhir` generators available on local system:

```bash
npm link dist/packages/nx-fhir
```

In root of some other Nx workspace, link the `nx-fhir` package:

```bash
npm link nx-fhir
```

Generate a server in that workspace:

```bash
nx g @nx-fhir/server:server
```

## Testing

Run end-to-end server test:

```bash
nx run nx-fhir:test:e2e
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
