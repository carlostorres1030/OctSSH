# OctSSH

English / 英文文档: [README.en.md](README.en.md)

让LLM安全的控制你的服务器进行部署操作打通LLM自动化流程最後一步。

OctSSH 是一个基于 MCP（Model Context Protocol） 的 SSH 工具服务：让 LLM/Agent 可以**以更安全、可控、可追踪**的方式操控你的 SSH 服务器完成部署、排障、文件分发等操作。

- npm 包名：`@aliyahzombie/octssh`
  - 注意：npm 包名不能包含大写字母，因此 npm 上使用全小写；仓库名可以是 `aliyahzombie/OctSSH`
- 仓库：`https://github.com/aliyahzombie/OctSSH`

## 核心能力

- 读取本机 OpenSSH `ssh_config`，列出可连接的主机别名
- 执行命令（同步/异步），并可轮询查看结果、tail 最后 N 行、grep 日志
- 上传/下载文件或目录（默认安全模式：避免覆盖/需要确认）
- 内置安全策略：阻止常见高危指令、对破坏性操作启用 Virtual Mode（confirm_code 二次确认）

## 安全 / 前置条件

OctSSH 会连接真实服务器并执行命令，你需要清楚这意味着什么。

硬性要求（设计约束）：
- 远端服务器必须安装 `screen`（用于异步任务）
- `sudo-exec` / `exec-async-sudo` 仅支持免密 sudo（`sudo -n`）

不支持（设计约束）：
- `ProxyCommand`（只支持 `ProxyJump`）
- 交互式 sudo 输入密码

## 安装

### 从 npm 安装

```bash
npm install -g @aliyahzombie/octssh
```

### 本地开发 / 源码安装

```bash
npm install
npm test
npm run build
```

模拟全局安装：

```bash
npm pack
npm install -g ./octssh-*.tgz
```

## 初始化

运行交互式初始化：

```bash
octssh init
```

它会：
1) 展示安全提醒
2) 读取你的 `ssh_config`，列出所有“具体主机别名”（不会把 `Host *` 这种通配块当成主机）
3) 可选 Extended init：逐台连接并采集 OS/CPU/内存/磁盘等信息

本地状态目录默认在 `~/.octssh`（可用 `OCTSSH_HOME` 覆盖）。

## MCP Server（stdio）

以 stdio 方式启动 MCP server：

```bash
octssh
```

## 可用工具（Tools）

所有工具都是无状态的：每次调用都需要传 `machine` 或 `session_id`。

核心工具：
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

文件传输工具：
- `upload(machine, localPath, remotePath, confirm_code?)`
- `upload-async(machine, localPath, remotePath, confirm_code?)`
- `download(machine, remotePath, localPath)`
- `download-async(machine, remotePath, localPath)`

## Virtual Mode（confirm_code）

一些操作默认不会直接执行，会先返回需要二次确认的 `confirm_code`。

上传覆盖保护：
- 如果 `upload` 会覆盖远端已有文件，会拒绝执行并返回 `confirm_code` + 冲突列表
- 只有你再次调用同一个 `upload(...)` 并传入 `confirm_code` 才会真正覆盖上传

破坏性命令保护：
- `rm -r` / `rm -rf` 这类递归删除默认进入 Virtual Mode
- 工具会返回“将被影响的路径预览” + `confirm_code`
- 只有你再次调用同一条命令并传入 `confirm_code` 才会真正执行

## 配置

环境变量：
- `OCTSSH_HOME`：覆盖本地状态目录（默认 `~/.octssh`）
- `OCTSSH_SSH_CONFIG`：覆盖 ssh_config 路径（默认 `~/.ssh/config`）

配置文件：`~/.octssh/config.json`
- `retentionDays`（默认 7）
- `maxConcurrentInit`（默认 5）
- `promptThresholdHosts`（默认 20）
- `idleTtlSeconds`（默认 300）
- `maxConnections`（默认 10）
- `allowSshG`（默认 false）

### 安全策略（Security Policy）

`exec` / `exec-async` 的默认安全规则：
- `exec` 禁止执行包含 `sudo` 的命令（请使用 `sudo-exec`）
- 一些高危防火墙/断连指令会被直接阻止
- `rm -r` / `rm -rf` 默认进入 Virtual Mode

你可以在配置里追加自定义拦截规则：

```json
{
  "security": {
    "denyExecutables": ["some-tool"],
    "denyRegex": ["\\bvery\\s+bad\\b"],
    "requireConfirmRegex": ["\\brm\\b\\s+-\\S*[rR]\\S*"]
  }
}
```

`allowSshG=true` 会启用可选的 `ssh -G` 解析模式。注意 OpenSSH 在解析时可能会执行动态规则（例如 `Match exec`）。

## ssh_config 支持范围（子集）

OctSSH 静态解析支持的子集：
- `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ServerAliveInterval`, `ServerAliveCountMax`
- 支持 `Include`（用于 host 发现与解析）

`ProxyCommand` 只会提示 warning，不会执行。

## 发布到 npm

```bash
npm login
npm whoami
npm test
npm publish --access public
```
