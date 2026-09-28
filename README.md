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
