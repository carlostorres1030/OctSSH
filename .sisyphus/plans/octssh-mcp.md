# OctSSH (MCP) Work Plan

## Context

### Original Request
Build an MCP server (OctSSH) that lets an agent control SSH servers for deployment.

Key requirements from the session:
- Install via `npm install -g`.
- Read local OpenSSH `ssh_config` to discover hosts.
- Optional "Extended init" connects to hosts to collect OS/arch/CPU/mem/disk.

### Confirmed Decisions
- Proxy: ProxyJump only; v1 supports single-hop jump.
- Backend: embedded Node SSH library (keep connections).
- Pooling: 1 connection per machine, idle TTL=300s, global max connections=10.
- Async exec: each async command runs in a dedicated remote `screen` session.
- Remote logs: redirect stdout/stderr under `~/.octssh/runs`.
- Retention: TTL cleanup default 7 days; user configurable; not immediate cleanup.
- Sudo: passwordless only via `sudo -n`.
- Tools are stateless: every call passes `machine`.
- ssh_config resolution: default static subset; optional local `ssh -G` mode (default OFF).
- MCP transport: Stdio.
- Tests: include automated tests.
- Local storage: base dir `~/.octssh`; SQLite dropped (planner chooses efficient persistence).

## Work Objectives

### Core Objective
Deliver a production-usable MCP Stdio server + optional CLI init that can inventory SSH hosts and run sync/async commands safely.

### Deliverables
- Node.js/TypeScript package with global `bin` (e.g. `octssh`).
- MCP Stdio server implementing tools:
  - `list(target?)`
  - `info(machine, refresh?)`
  - `exec(machine, command)`
  - `sudo-exec(machine, command)`
  - `exec-async(machine, command)`
  - `exec-async-sudo(machine, command)`
  - `get-result(session_id, lines?)`
  - `grep-result(session_id, pattern, maxMatches?, contextLines?)`
  - `cancel(session_id, signal?)`
  - `sleep(time)`
- Local state under `~/.octssh`:
  - `config.json` (retention TTL, concurrency, allowSshG, etc.)
  - `inventory.json` (host list + extended metadata)
  - `sessions/` (persistent async session records, file-based)

## Guardrails (Must NOT Do)
- Do not support ProxyCommand / LocalCommand / executing local shell from ssh_config.
- Do not evaluate `Match exec` by default.
- Do not prompt for sudo password; never hang on sudo.
- Do not return unbounded stdout/stderr to the LLM.

## Verification Strategy

- Automated unit tests:
  - ssh_config host discovery (concrete aliases only)
  - config resolution (static subset + ProxyJump parsing)
  - session persistence across restarts
  - TTL cleanup logic
  - tool output size limits
- Optional integration tests gated by env vars (skip by default).
- Manual smoke:
  - `npm pack` then install globally and run MCP server over stdio.

## Implementation Outline (New Files)
- `src/index.ts` - CLI entry + MCP server boot
- `src/mcp/server.ts` - register tools (MCP TS SDK)
- `src/ssh/config/*` - read/parse/resolve ssh_config
- `src/ssh/connectionPool.ts` - pooling, TTL, cap
- `src/ssh/proxyJump.ts` - single-hop jump via ssh2 forwardOut + sock stream
- `src/ssh/exec.ts` - sync exec helpers
- `src/ssh/asyncScreen.ts` - async exec wrappers using screen + remote meta/log files
- `src/state/*` - file-based store + TTL cleanup
- `src/init/extended.ts` - extended init collector

## Implementation Notes (Recommended Defaults)

### Key Dependencies (suggested)
- MCP server: `@modelcontextprotocol/sdk` (TypeScript)
- Schemas: `zod`
- SSH client: `ssh2`
- Optional static ssh_config parsing helper: a lightweight ssh_config parser (or a minimal in-house parser for `Host` blocks)
- Concurrency: `p-limit` (or a tiny in-house semaphore)
- IDs: `nanoid` (or `crypto.randomUUID()`)

### Persistence (file-based, SQLite-free)
- Local base: `~/.octssh`
- Suggested layout:
  - `~/.octssh/config.json`
  - `~/.octssh/inventory.json`
  - `~/.octssh/sessions/<session_id>.json`
- Use atomic writes for JSON files (write temp + rename) to survive crashes.

### Output Limits (tool safety)
- `exec/sudo-exec`: enforce max bytes for stdout/stderr (e.g. 64 KiB each) and truncate with a clear marker.
- `grep-result`: cap matches (default 50), cap returned text size, and allow `contextLines`.

## TODOs

- [x] 0. Scaffold npm package + TypeScript + test runner
  - Acceptance: `npm test` and `npm run build` pass.

- [x] 1. MCP Stdio bootstrap + tool wiring skeleton
  - Acceptance: server starts; a trivial tool returns structured JSON.

- [x] 2. Local config + file-based persistence under `~/.octssh`
  - Default config: retentionDays=7, maxConcurrentInit=5, promptThresholdHosts=20, idleTtlSeconds=300, maxConnections=10, allowSshG=false.
  - Acceptance: create/update/load session record survives restart.

- [x] 3. ssh_config host discovery
  - Parse `Host` blocks; list concrete aliases only.
  - Acceptance: `list()` returns aliases; wildcard-only blocks not included.

- [x] 4. Config resolution (static subset) + optional `ssh -G` mode
  - Support: HostName, User, Port, IdentityFile, ProxyJump, keepalive settings.
  - Optional: allowSshG config gate.
  - Acceptance: default mode does not execute local commands.

- [x] 5. Connection pool (1 per machine) + idle TTL + global cap
  - Acceptance: reuse connections; never exceed cap.

- [x] 6. ProxyJump single-hop implementation
  - Pattern: connect to jump host -> forwardOut to target -> connect to target over `sock`.
  - Acceptance: works in integration test env; errors are actionable.

- [x] 7. exec + sudo-exec (sudo -n)
  - Acceptance: sudo-exec fails fast when not permitted.

- [x] 8. exec-async (+ sudo) via remote screen
  - Preflight screen exists.
  - Remote per-session dir: `~/.octssh/runs/<session_id>/` with stdout/stderr/meta.
  - Acceptance: start returns session_id; get-result shows running/done.

- [x] 9. get-result(lines) + grep-result output controls
  - Acceptance: logs are truncated/limited; no huge responses.

- [x] 10. cancel(session_id)
  - Acceptance: cancels running job; idempotent behavior.

- [x] 11. Extended init (CLI)
  - Show disclaimer; host count threshold prompt; concurrency=5.
  - Collect OS/arch/CPU/mem/disk with Linux-first commands and fallbacks.

- [x] 12. TTL cleanup job
  - Local + remote best-effort cleanup.

- [x] 13. Docs
  - Supported ssh_config subset, limitations, safety notes.

## Success Criteria
- `npm test` passes
- `npm run build` passes
- Global install works (`npm pack` then `npm install -g`)
- MCP server responds to `list/info/exec` over stdio
- Async flow supports start -> poll -> tail/grep -> cancel
