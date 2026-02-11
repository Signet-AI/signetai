# Contributing to Signet

Thanks for your interest in contributing to Signet!

## Development Setup

```bash
# Clone the repo
git clone https://github.com/Signet-AI/signetai.git
cd signetai

# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun test
```

## Project Structure

```
signetai/
├── packages/
│   ├── cli/       # Command-line interface
│   ├── core/      # Core library & database
│   ├── sdk/       # Integration SDK for apps
│   └── daemon/    # Background sync service
└── ...
```

## Making Changes

1. Fork the repository
2. Create a branch: `git checkout -b my-feature`
3. Make your changes
4. Run tests: `bun test`
5. Commit: `git commit -m "feat: add feature"`
6. Push: `git push origin my-feature`
7. Open a Pull Request

## Commit Messages

We use conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Tests
- `chore:` Maintenance

## Code Style

We use Biome for formatting and linting:

```bash
bun run format
bun run lint
```

## Questions?

Open an issue or join our Discord.
