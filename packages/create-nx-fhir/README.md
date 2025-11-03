# create-nx-fhir

This CLI tool scaffolds an Nx monorepo pre-configured with the [nx-fhir](https://github.com/bstewartlg/nx-fhir/) plugin, ready for building FHIR servers and frontends.

## Quick Start

Create a new workspace with a single command:

```sh
npx create-nx-fhir@latest my-fhir-app
```

This will:
- Create a new Nx workspace
- Install the nx-fhir plugin
- Optionally generate a HAPI FHIR server (you'll be prompted)

## Usage

### Basic Usage

```sh
npx create-nx-fhir@latest
```

You'll be prompted for:
1. **Workspace directory** - Name of your new workspace
2. **Generate FHIR server** - Whether to create a server immediately

### With Options

Specify options directly to skip prompts:

```sh
npx create-nx-fhir@latest my-fhir-app --server --packageManager=npm
```

## Options

### `[name]`
The workspace directory name (positional argument).

```sh
npx create-nx-fhir@latest my-healthcare-app
```

### `--directory <name>`
Alternative way to specify the workspace directory.

```sh
npx create-nx-fhir@latest --directory=my-healthcare-app
```

### `--server`
Whether to generate a FHIR server automatically.

- `--server` or `--server=true` - Generate a server
- `--server=false` - Skip server generation
- Omit option - You'll be prompted

```sh
npx create-nx-fhir@latest my-app --server
```

### `--packageManager <pm>`
Package manager to use. Options: `bun`, `npm`.

Default: `bun` (falls back to `npm` if bun is unavailable)

```sh
npx create-nx-fhir@latest my-app --packageManager=npm
```

### FHIR Server Options

If you're generating a server, you can customize it with these options:

#### `--serverDirectory <path>`
Directory for the server source code.

Default: `server`

```sh
npx create-nx-fhir@latest my-app --server --serverDirectory=backend
```

#### `--packageBase <package>`
Java package path for custom server code.

Default: `org.custom.server`

```sh
npx create-nx-fhir@latest my-app --server --packageBase=com.myorg.fhir
```

#### `--fhirVersion <version>`
FHIR version for the server. Options: `STU3`, `R4`, `R4B`, `R5`.

Default: `R4`

```sh
npx create-nx-fhir@latest my-app --server --fhirVersion=R4
```

#### `--release <version>`
Specific HAPI FHIR JPA Starter release version.

```sh
npx create-nx-fhir@latest my-app --server --release=v7.4.6
```

### `--verbose`
Enable verbose logging for debugging.

```sh
npx create-nx-fhir@latest my-app --verbose
```

### `--help`, `-h`
Display help information.

```sh
npx create-nx-fhir@latest --help
```

## Examples

### Minimal Setup
Create a workspace without a server:

```sh
npx create-nx-fhir@latest my-app --server=false
```

Then generate projects later:
```sh
cd my-app
nx g nx-fhir:server
nx g nx-fhir:frontend
```

## Requirements

- **Node.js**: Version 20 or higher
  - (Optional) [bun](https://bun.sh/) is the preferred default runtime and package manager
- **Package Manager**: npm (always available) or bun (optional)
- **Java**: JDK 17 or higher (required if generating FHIR server)
- **Maven**: For building Java server projects (required if generating FHIR server)

## Documentation

This plugin makes use of several external projects. For more information, please refer to their documentation:

- [Nx Documentation](https://nx.dev)
- [HAPI FHIR JPA Server Starter](https://github.com/hapifhir/hapi-fhir-jpaserver-starter)
- [Next.js Documentation](https://nextjs.org/docs)

