# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Desktop app built on **Tauri 2** with a **vanilla TypeScript + Vite** frontend (no UI framework). It is still the unmodified `create-tauri-app` template: the only feature is the demo `greet` command, and `README.md`, `index.html` and the window title contain template boilerplate.

## Commands

Package manager is **pnpm** (`tauri.conf.json` invokes `pnpm dev` / `pnpm build`).

```sh
pnpm install
pnpm tauri dev      # run the desktop app (starts Vite on :1420, then compiles and launches the Rust shell)
pnpm tauri build    # production bundle for the current platform
pnpm build          # frontend only: tsc type-check + vite build to dist/
pnpm dev            # frontend only in a browser; invoke() calls fail outside the Tauri webview

# Rust side, run from src-tauri/
cargo check
cargo clippy
cargo test          # no tests exist yet
cargo test <name>   # run a single Rust test
```

No JS test runner or linter is configured. Type-checking happens via `tsc` inside `pnpm build`; `tsconfig.json` has `strict`, `noUnusedLocals` and `noUnusedParameters`, so unused code fails the build.

## Architecture

Two processes communicating over Tauri IPC:

- **Frontend** (`index.html` → `src/main.ts`, `src/styles.css`): plain DOM code. It calls the backend with `invoke("<command>", { ...args })` from `@tauri-apps/api/core`. `withGlobalTauri` is also enabled, so `window.__TAURI__` is available.
- **Backend** (`src-tauri/`): the Rust crate. All app logic lives in `src/lib.rs` (library crate `asdlc_dashboard_lib`). `src/main.rs` only calls `asdlc_dashboard_lib::run()`. The split exists so the same `run()` can serve as the mobile entry point; renaming the crate means updating `main.rs` as well.

To add a backend command:
1. Define a `#[tauri::command]` fn in `src-tauri/src/lib.rs`.
2. Register it in `tauri::generate_handler![...]` in `run()`.
3. Call it from TS with `invoke`. JS argument keys are camelCase and map to snake_case Rust parameter names. Return types must implement `serde::Serialize`.

Tauri plugins need both a Rust `.plugin(...)` registration in `run()` and a permission entry in `src-tauri/capabilities/default.json`. That file grants permissions to the window labeled `main`; a plugin call with no granted permission is rejected at runtime, not at compile time.

Dev-server wiring: Vite must run on port **1420** with `strictPort` because `tauri.conf.json` `devUrl` points there (HMR uses 1421 when `TAURI_DEV_HOST` is set, e.g. for mobile). Vite ignores `src-tauri/` so Rust rebuilds don't trigger frontend reloads. `pnpm tauri build` bundles `dist/` as the frontend.

CSP is disabled (`app.security.csp: null`).
