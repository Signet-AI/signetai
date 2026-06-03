# Signet

This npm package is a thin wrapper for the same compiled Signet binary used by
the curl installer and Bun global installs.

```bash
npm install -g signetai
bun add -g signetai
```

The package installs a platform native package tarball from the same GitHub
release. `postinstall` only links or copies that binary into the package
directory; if install scripts are disabled, the `signet` command resolves and
executes the native package directly.

The package does not install Bun, does not build Signet from source, and does
not install runtime dependencies such as `better-sqlite3`.

Direct curl installs use the same compiled Signet binary:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

## Requirements

- Node.js for the npm wrapper, or Bun for the Bun wrapper
- Published native binary platform: Linux x64, Linux arm64, macOS x64,
  macOS arm64, or Windows x64

Windows direct installs should use the npm wrapper. The old PowerShell
`install.ps1` path has been removed until a native Windows direct installer
ships.

## Documentation

Full docs: [signetai.sh/docs](https://signetai.sh/docs)

## License

Apache-2.0
