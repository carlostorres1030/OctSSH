## 2026-01-27T02:18:35Z Baseline Decisions
- ProxyJump only; v1 single-hop.
- Embedded SSH library (`ssh2`), keep connections.
- Connection pool: 1 connection per machine; idle TTL=300s; global max connections=10.
- Async exec runs remotely using `screen`; remote must have `screen`.
- Async logs in `~/.octssh/runs`.
- Retention TTL default 7 days (configurable).
- Sudo: passwordless only (`sudo -n`).
- ssh_config: list only concrete aliases; default static subset resolution; optional local `ssh -G` mode (default OFF).
- MCP transport: stdio.
