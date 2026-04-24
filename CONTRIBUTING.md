# Contributing

Fiber Snatcher is a personal toolkit, but PRs and issues are welcome.

## Setup

```sh
git clone https://github.com/alcatraz627/invasion-of-the-fiber-snatchers
cd invasion-of-the-fiber-snatchers
~/.bun/bin/bun install
bash scripts/install.sh
```

## Development loop

```sh
# Run a subcommand during development without re-install
~/.bun/bin/bun run bin/fiber-snatcher.ts <cmd> [args]

# Or via the package.json alias
bun run fs <cmd> [args]

# Typecheck
bun tsc --noEmit
```

## Commit format

Conventional commits. One of:

- `feat:` new capability
- `fix:` bug fix
- `docs:` documentation only
- `refactor:` structural change, no behavior change
- `chore:` tooling / deps / cleanup
- `test:` adding or correcting tests

Scope in parens when useful: `feat(cli): add shoot --wait-for`.

## Pull requests

- Keep PRs small and focused — one feature or one fix per PR.
- `bun tsc --noEmit` must pass.
- `fiber-snatcher doctor` should succeed on a throwaway Next.js project.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under "Unreleased" for anything user-visible.
- Update [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) if you change internals.

## Adding a new subcommand

1. Add the name to the `COMMANDS` tuple in `bin/fiber-snatcher.ts`.
2. Document it in the help string.
3. Create `src/cli/<name>.ts` exporting `export async function run(args: string[]): Promise<Result>`.
4. Return `ok(data, { next_steps })` or `err(code, message, { next_steps })` — follow the conventions in `src/core/result.ts`.
5. Add a row to the command table in [`README.md`](./README.md) and operating rules in [`CLAUDE.md`](./CLAUDE.md).
6. Update [`CHANGELOG.md`](./CHANGELOG.md).

## Adding a store adapter

Adapters implement `{ getState(): unknown; dispatch(action: unknown): unknown }` and register via `window.__snatcher__.register(name, adapter)` inside the target project's dev runtime file. V1.1 will ship first-class adapters for TanStack Query and Jotai — see those as reference implementations when they land.

## Reporting bugs

Use the [bug report template](./.github/ISSUE_TEMPLATE/bug_report.md). Include `fiber-snatcher doctor --json` output and the contents of `.fiber-snatcher/last-run.json`.
