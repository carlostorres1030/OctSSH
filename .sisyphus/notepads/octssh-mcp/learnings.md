## 2026-01-27T02:18:35Z Init
- Notepad created for OctSSH execution.

## 2026-01-27T02:35:00Z Task 0 Scaffold
- Minimal TS scaffold: `typescript` + `tsc`, Node >= 18.
- Use Node built-in test runner but do NOT rely on directory args (`node --test test` fails on Node 24); use a single entry `test/index.test.js` to load all tests.
- Add `scripts/clean-dist.cjs` and run it before build to avoid stale `dist/test` artifacts confusing the test runner.

## 2026-01-27T02:43:30Z Task 1 MCP Bootstrap
- `tsc` build was OOM-killed after adding MCP SDK deps; switched build to `tsup` (esbuild) to keep memory low.
- MCP TypeScript SDK supports CommonJS (`exports.require`), so we can keep CJS output and still import `@modelcontextprotocol/sdk/server/*`.
- Implemented server bootstrap via `StdioServerTransport` + `McpServer` and registered placeholder tools (all return "not implemented" except `sleep`).

## 2026-01-27T02:48:30Z Task 2 Local State
- Implemented file-based state modules under `src/state/*`:
  - `config.json` load/save with zod schema + defaults.
  - sessions persisted as `sessions/<session_id>.json` with atomic writes.
  - `OCTSSH_HOME` env var overrides base directory (important for tests).
- `tsup` CLI flag `--no-bundle` was not accepted; moved build options into `tsup.config.ts` with `bundle:false`.

## 2026-01-27T02:56:00Z Task 3+4 ssh_config
- Host discovery: `discoverHostAliases()` reads `~/.ssh/config` (or `OCTSSH_SSH_CONFIG`) and expands `Include` globs via `fast-glob`.
- Resolution: `resolveHostConfig()` implements a conservative OpenSSH-like rule (top-to-bottom; for most fields, first value wins). Supports Host patterns with `*`, `?`, and negation `!`.
- ProxyCommand/LocalCommand are not executed; they generate warnings.
- Optional `ssh -G` resolution is behind `allowSshG` and warns about dynamic config execution risk.

## 2026-01-27T03:01:00Z Task 5 Connection Pool
- Implemented a generic `ConnectionPool<K,T>` with:
  - 1-per-key reuse
  - global cap eviction (LRU among idle only)
  - idle TTL sweep via `sweep(now)`

## 2026-01-27T03:07:00Z Task 6 ProxyJump
- Implemented ProxyJump mechanics:
  - `forwardOut` promisification + error hints for forwarding disabled
  - `connectWithProxyJump()` uses ssh2: connect jump -> forwardOut -> connect target over `sock`

## 2026-01-27T03:18:00Z Task 7 Exec
- Implemented direct execution tools in MCP server:
  - `exec`: runs `sh -lc '<cmd>'` and captures bounded stdout/stderr.
  - `sudo-exec`: runs `sudo -n -- sh -lc '<cmd>'` and detects password-required errors.
- Connection creation uses ssh_config resolution + optional ProxyJump + a connection pool.

## 2026-01-27T03:33:00Z Task 8+9 Async + Logs
- Async execution uses remote `screen` sessions; each session writes:
  - `~/.octssh/runs/<session_id>/stdout.log`
  - `~/.octssh/runs/<session_id>/stderr.log`
  - `~/.octssh/runs/<session_id>/meta.json`
  - `~/.octssh/runs/<session_id>/cmd.pid` (best-effort)
- Implemented `get-result(session_id, lines?)` to return status + optional tail.
- Implemented `grep-result(session_id, pattern, ...)` to search stdout/stderr remotely with caps.

## 2026-01-27T03:58:00Z Packaging
- Global npm install on Linux uses a symlink to the `bin` target; `dist/index.js` must include a Node shebang (`#!/usr/bin/env node`). Without it, the OS falls back to `/bin/sh` and fails with `use strict: not found`.
