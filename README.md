# OctSSH

OctSSH is an MCP (Model Context Protocol) server that lets an agent control your SSH servers for deployment.

It reads your local OpenSSH `ssh_config` and exposes a small set of tools for:
- listing hosts
- running commands (sync + async)
- polling/tailing/grepping async logs

## Safety / Requirements

This project can connect to real servers and run commands. You should understand the implications.

Hard requirements (by design):
- Remote servers must have `screen` installed (for async jobs).
- `sudo-exec` / `exec-async-sudo` require passwordless sudo (`sudo -n`).

Not supported (by design):
- `ProxyCommand` (only `ProxyJump` is supported).
- interactive sudo password prompts.

## Installation

This repository is currently intended for local development.

```bash
npm install
npm test
npm run build
```

To simulate a global install:

```bash
npm pack
npm install -g ./octssh-*.tgz
```

## Initialization

Run interactive init:

```bash
octssh init
```

It will:
1) show a safety notice
2) read your `ssh_config` and list all concrete host aliases
3) optionally do "Extended init" by connecting to each host and collecting OS/CPU/mem/disk info

Local state is stored under `~/.octssh` (override via `OCTSSH_HOME`).

## MCP Server (stdio)

Run the MCP server over stdio:

```bash
octssh
```

## Available Tools

All tools are stateless: every call includes `machine` (host alias) or `session_id`.

- `list(target?)`
  - Returns host aliases from local ssh_config
  - If `target` is provided and you have an extended inventory, returns requested cached fields

- `info(machine, refresh?)`
  - Default: returns cached extended info (requires you to have run `octssh init` Extended)
  - `refresh=true`: connects and refreshes cached info

- `exec(machine, command)`
  - Runs `sh -lc <command>` on the remote machine

- `sudo-exec(machine, command)`
  - Runs `sudo -n -- sh -lc <command>` (passwordless sudo only)

- `exec-async(machine, command)`
- `exec-async-sudo(machine, command)`
  - Starts a remote `screen` session per command
  - Returns `session_id`

- `get-result(session_id, lines?)`
  - Returns status from remote `meta.json`
  - If `lines` provided, tails the last N lines of stdout/stderr

- `grep-result(session_id, pattern, maxMatches?, contextLines?)`
  - Greps remote stdout/stderr logs with caps

- `cancel(session_id, signal?)`
  - Best-effort terminate: kill cmd pid (if known) and quit screen session

- `sleep(time)`
  - Sleeps for `time` milliseconds (useful for agent workflows)

### File Transfer Tools

Uploads are **safe by default** via a virtual confirmation step when they would overwrite remote files.

- `upload(machine, localPath, remotePath, confirm_code?)`
  - Uploads a single file or a directory.
  - If the upload would overwrite existing remote files:
    - the tool REFUSES to run
    - returns `confirm_code` and a conflict list (first 10 + total)
    - re-run the SAME `upload(...)` call with `confirm_code` to allow overwrite

- `upload-async(machine, localPath, remotePath, confirm_code?)`
  - Same behavior as `upload`, but runs in background.
  - Only creates a session once the upload actually starts.
  - Use `get-result(session_id, lines?)` to poll progress/logs.

Downloads are **never allowed** to overwrite local files.

- `download(machine, remotePath, localPath)`
  - Downloads a single file or a directory.
  - If any local file would be overwritten, the tool refuses and tells you to choose a new localPath.

- `download-async(machine, remotePath, localPath)`
  - Same as download, but runs in background with a session id.

## Configuration

Environment variables:
- `OCTSSH_HOME`: override local state dir (default `~/.octssh`)
- `OCTSSH_SSH_CONFIG`: override ssh_config path (default `~/.ssh/config`)

Config file: `~/.octssh/config.json`
- `retentionDays` (default 7)
- `maxConcurrentInit` (default 5)
- `promptThresholdHosts` (default 20)
- `idleTtlSeconds` (default 300)
- `maxConnections` (default 10)
- `allowSshG` (default false)

### Security Policy

`exec` and `exec-async` have safety controls:
- `exec` refuses any command that contains `sudo` (use `sudo-exec` instead).
- Some high-risk firewall/lockout commands are blocked outright.
- Destructive removes like `rm -r` / `rm -rf` default to VIRTUAL MODE:
  - the tool returns a preview of affected paths + `confirm_code`
  - to proceed, re-run the SAME command with `confirm_code`

You can add your own deny rules via config:

```json
{
  "security": {
    "denyExecutables": ["some-tool"],
    "denyRegex": ["\\\bvery\\\s+bad\\\b"],
    "requireConfirmRegex": ["\\\brm\\\b\\\s+-\\\S*[rR]\\\S*"]
  }
}
```

`allowSshG=true` enables optional `ssh -G` based resolution. Note that OpenSSH may execute dynamic ssh_config directives (e.g. `Match exec`).

## ssh_config Support (subset)

OctSSH implements a conservative subset for static resolution:
- `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ServerAliveInterval`, `ServerAliveCountMax`
- `Include` is followed for host discovery and resolution

`ProxyCommand` is detected and warned about, but not executed.
