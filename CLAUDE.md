# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Desktop app built on **Tauri 2** with a **vanilla TypeScript + Vite** frontend (no UI framework). It is a read-only kanban work board for a [beads](https://github.com/steveyegge/beads) (`bd`) issue database: the user opens a folder containing `.beads`, and issues are shown in columns by status, with filters and a details panel.

## Commands

Package manager is **pnpm** (`tauri.conf.json` invokes `pnpm dev` / `pnpm build`).

```sh
pnpm install
pnpm tauri dev      # run the desktop app (starts Vite on :1420, then compiles and launches the Rust shell)
pnpm tauri build    # production bundle for the current platform
pnpm build          # frontend only: tsc type-check + vite build to dist/
pnpm test           # frontend unit tests (vitest, src/*.test.ts)
pnpm dev            # frontend only; a plain browser gets a notice, since only the Tauri window has the backend

# Rust side, run from src-tauri/
cargo check
cargo clippy --all-targets
cargo test                 # unit tests
cargo test -- --ignored    # also the live test, which needs bd on PATH and creates a throwaway workspace
cargo test <name>          # run a single Rust test
```

No linter is configured. `tsconfig.json` has `strict`, `noUnusedLocals` and `noUnusedParameters`, and `tsc` also checks the test files, so unused code fails `pnpm build`.

Keep the npm `@tauri-apps/plugin-*` packages on the same minor version as their Rust crates (`Cargo.lock`); the Tauri CLI warns on a mismatch. That is why `@tauri-apps/plugin-dialog` uses a `~` range.

Releases: `.github/workflows/release.yml` runs on a pushed `v*` tag (or manually), checks the tag against `version` in `src-tauri/tauri.conf.json`, builds on macOS (universal, ad-hoc signed), Ubuntu 22.04 and Windows with `tauri-apps/tauri-action`, uploads to a draft release, and publishes it once all three succeed. pnpm is pinned there (`version: 12`), since `package.json` has no `packageManager` field.

## Architecture

Two processes communicating over Tauri IPC:

- **Backend** (`src-tauri/`): the Rust crate. `src/beads.rs` runs the `bd` CLI; `src/lib.rs` wraps it in Tauri commands and holds `run()`. `src/main.rs` only calls `asdlc_dashboard_lib::run()`, so the same `run()` can serve as the mobile entry point; renaming the crate means updating `main.rs` as well.
- **Frontend** (`index.html` → `src/main.ts`): plain DOM code built with the `el()` helper in `src/dom.ts`, never HTML strings, except markdown, which `src/markdown.ts` sanitizes with DOMPurify.

### Reading beads

Beads 1.x stores issues in Dolt (`.beads/embeddeddolt` or a `bd`-managed `dolt sql-server`), so the app reads nothing directly: every read runs `bd --readonly --quiet --json <command>` in the chosen folder, on a blocking thread. `--readonly` matters: without it, even `bd list` can migrate an old database's schema or start a Dolt server. With it, bd refuses and the error reaches the user.

| Tauri command    | bd invocation                                                      | Used for                                           |
| ---------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `open_workspace` | `where`, `statuses`                                                | `.beads` path, ID prefix, status → category map    |
| `load_board`     | `list --all --limit 0`, `blocked`                                  | every issue, and which open issues are blocked     |
| `load_issue`     | `show --id=<id> --include-comments --include-dependents --brief-deps` | details panel: comments and incoming links      |
| `change_marker`  | none: mtime of `.beads/last-touched` / `issues.jsonl`              | cheap change detection, polled every 2 s           |

`new_window` is the one command that doesn't touch bd: it opens another window from the `tauri.conf.json` window config, labeled `board-N` (the first window is `main`). Only `main` reopens the last folder at startup.

Dolt's own files change on every read, so their mtimes are useless for change detection; `last-touched` changes only on writes. The frontend also reloads every 60 s and on window focus, for changes that leave no marker.

The GUI app does not inherit the shell's `PATH` when launched from Finder, so `beads.rs` searches `PATH` plus Homebrew and per-user bin directories, and passes that combined `PATH` to `bd` so it can find `git` and `dolt`.

### Frontend modules

- `beads.ts`: TypeScript shapes of bd's JSON and the `invoke` wrappers.
- `board.ts`: pure logic (column assignment, filters, sorting, epic progress); tested in `board.test.ts`. Columns come from the status **category** (`active`, `wip`, `done`, `frozen`), so custom statuses land correctly; `blocked` status and open issues listed by `bd blocked` go to Blocked. Columns with no cards are hidden (`visibleColumns`), unless every column is empty.
- `render.ts` (columns and cards), `detail.ts` (details panel), `markdown.ts` (sanitized markdown, issue IDs turned into links), `format.ts` (times, initials).
- `features.ts`: build-time toggles for hidden features, all off by default. `leases` gates the "stale" card badge and the "Lease expires" detail row.
- `main.ts`: state, events, keyboard shortcuts, refresh loop. Recent folders, the "done" window and the zoom level are kept in `localStorage`, which all windows share; a `storage` listener picks up another window's changes. A `generation` counter drops answers that arrive after the user switched workspace.

Link clicks are intercepted: `[data-issue]` elements open that issue, and `http(s)`/`mailto` links open in the system browser through the opener plugin. Nothing navigates the webview.

### Adding a backend command

1. Define a `#[tauri::command]` fn in `src-tauri/src/lib.rs` (logic in `beads.rs` if it runs bd).
2. Register it in `tauri::generate_handler![...]` in `run()`.
3. Call it from TS with `invoke`. JS argument keys are camelCase and map to snake_case Rust parameter names. Return types must implement `serde::Serialize`.

Tauri plugins need both a Rust `.plugin(...)` registration in `run()` and a permission entry in `src-tauri/capabilities/default.json`. That file grants permissions to the windows labeled `main` and `board-*`; a plugin call with no granted permission is rejected at runtime, not at compile time. Beyond `core:default`, the app uses `core:window:allow-set-title` (window title = folder name), `core:webview:allow-set-webview-zoom` (⌘+/⌘−), `opener:default` and `dialog:allow-open`.

Dev-server wiring: Vite must run on port **1420** with `strictPort` because `tauri.conf.json` `devUrl` points there (HMR uses 1421 when `TAURI_DEV_HOST` is set, e.g. for mobile). Vite ignores `src-tauri/` so Rust rebuilds don't trigger frontend reloads. `pnpm tauri build` bundles `dist/` as the frontend.

CSP is disabled (`app.security.csp: null`).
