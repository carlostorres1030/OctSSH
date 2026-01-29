# OctSSH

Chinese / 中文: [README.md](README.md)

Make LLMs safely control your servers for deployment — the last mile of LLM automation.

- npm package: `@aliyahzombie/octssh`
- repo: `https://github.com/aliyahzombie/OctSSH`

## What is this?

OctSSH is an MCP (Model Context Protocol) server that lets an agent control your SSH servers for deployment.

It reads your local OpenSSH `ssh_config` and exposes tools for:
- listing hosts
- running commands (sync + async)
- polling/tailing/grepping async logs
- uploading/downloading files and directories (with safe defaults)

## Safety / Requirements

This project can connect to real servers and run commands. You should understand the implications.

Hard requirements (by design):
- Remote servers must have `screen` installed (for async jobs).
- `sudo-exec` / `exec-async-sudo` require passwordless sudo (`sudo -n`).

Not supported (by design):
- `ProxyCommand` (only `ProxyJump` is supported).
- interactive sudo password prompts.

## Installation

### Install from npm

```bash
npm install -g @aliyahzombie/octssh
```

### Development / from source

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

Core tools:
- `list(target?)`
- `info(machine, refresh?)`
- `exec(machine, command, confirm_code?)`
- `sudo-exec(machine, command, confirm_code?)`
- `exec-async(machine, command, confirm_code?)`
- `exec-async-sudo(machine, command, confirm_code?)`
- `get-result(session_id, lines?)`
- `grep-result(session_id, pattern, maxMatches?, contextLines?)`
- `cancel(session_id, signal?)`
- `sleep(time)`

File transfer tools:
- `upload(machine, localPath, remotePath, confirm_code?)`
- `upload-async(machine, localPath, remotePath, confirm_code?)`
- `download(machine, remotePath, localPath)`
- `download-async(machine, remotePath, localPath)`

## Virtual Mode (confirm_code)

Some operations require explicit confirmation.

Upload overwrite protection:
- If `upload` would overwrite remote files, it refuses and returns `confirm_code` + conflict list.
- Re-run the SAME `upload(...)` call with `confirm_code` to proceed.

Destructive command protection:
- Recursive deletes like `rm -r` / `rm -rf` default to VIRTUAL MODE.
- The tool returns a preview of affected paths + `confirm_code`.
- Re-run the SAME command with `confirm_code` to proceed.

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
- Destructive removes like `rm -r` / `rm -rf` default to VIRTUAL MODE.

You can add your own deny rules via config:

```json
{
  "security": {
    "denyExecutables": ["some-tool"],
    "denyRegex": ["\\bvery\\s+bad\\b"],
    "requireConfirmRegex": ["\\brm\\b\\s+-\\S*[rR]\\S*"]
  }
}
```

`allowSshG=true` enables optional `ssh -G` based resolution. Note that OpenSSH may execute dynamic ssh_config directives (e.g. `Match exec`).

## ssh_config Support (subset)

OctSSH implements a conservative subset for static resolution:
- `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ServerAliveInterval`, `ServerAliveCountMax`
- `Include` is followed for host discovery and resolution

`ProxyCommand` is detected and warned about, but not executed.

## Publishing to npm

```bash
npm login
npm whoami
npm test
npm publish --access public
```
