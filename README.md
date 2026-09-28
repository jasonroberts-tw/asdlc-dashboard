# ASDLC Dashboard

A desktop work board for a [beads](https://github.com/steveyegge/beads) issue database. Open a
folder that contains a `.beads` directory and its issues appear in five columns:

| Column      | Holds                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| On hold     | Deferred and pinned issues                                             |
| Blocked     | Open issues with an open blocker, and the `blocked` status             |
| Ready       | Open issues with nothing blocking them                                 |
| In progress | `in_progress`, `hooked` and any custom status in the `wip` category    |
| Done        | Closed issues, limited to a recent window by default                   |

Click a card for its description, notes, links and comments. Filter by text, type, priority,
assignee or epic. The board reloads by itself a few seconds after anything writes to the database.

The board is read-only. It reads through `bd --readonly ... --json`, so it never changes the
database. That also means it won't migrate an old database: if `bd` reports a schema mismatch, run
any `bd` write command in that repository first.

## Requirements

- `bd` 1.x. The app looks for it on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, `~/go/bin` and `~/bin`, because an app started from Finder gets a minimal `PATH`.
- Node with pnpm, and a Rust toolchain, to build.

## Development

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm test           # frontend unit tests (vitest)
pnpm build          # type-check and build the frontend

cd src-tauri
cargo test                 # backend unit tests
cargo test -- --ignored    # also runs a test against a real bd workspace
```

Keyboard: `/` focuses the filter, `Esc` closes the details panel, `⌘R` reloads, `⌘O` opens a folder.

## Releasing

The Release workflow (`.github/workflows/release.yml`) builds installers for macOS (a universal
`.dmg`), Linux (`.deb`, `.rpm`, `.AppImage`) and Windows (`.msi`, setup `.exe`) and publishes them
as a GitHub release.

1. Set the new version in `src-tauri/tauri.conf.json`, which is where the installers take it from,
   and commit. Use a plain `X.Y.Z`: the `.msi` build rejects labels such as `-beta`.
2. Push a matching tag, `git tag v0.2.0 && git push origin v0.2.0`, or run the Release workflow
   from the Actions tab, which tags the commit it builds.

The release stays a draft until all three builds succeed; re-running the workflow reuses the draft.

The installers are not signed with a developer certificate. The macOS app is ad-hoc signed and not
notarized, so macOS blocks the first launch: allow it under System Settings → Privacy & Security →
Open Anyway. On Windows, SmartScreen warns once: choose More info → Run anyway.
