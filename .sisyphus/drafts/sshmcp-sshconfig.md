# Draft: SSHMcp 读取本地 ssh_config 的配置设计

## Requirements (confirmed)
- 目标：为 SSHMcp 服务提供“配置方便 + 跨平台”能力，优先直接读取本地 OpenSSH 的 `ssh_config`（通常是 `~/.ssh/config`）。

## Requirements (from user answers)
- 解析方式倾向：优先使用 `ssh -G <host>` 获取 OpenSSH 计算后的最终配置（而不是自己完整复刻解析语义）。
- 安全边界问题：用户希望先了解 `ProxyCommand`/`LocalCommand` 等字段是什么，以及它们带来的风险与处理建议。

## Environment / Constraints (from user answers)
- 运行场景：本机单用户（同一登录用户使用）。
- 连接方式：SSHMcp 内置 SSH 客户端（不是简单 shell-out 到系统 `ssh`）。

## Technical Decisions
- 暂无（待确认：解析范围、安全边界、覆盖策略、是否支持 Include/Match/ProxyJump 等）。

## Research Findings
- 暂无（如需，我可以补充：各语言 ssh_config 解析库/行为差异、OpenSSH 语义坑点）。

## Open Questions
- 你的 SSHMcp 主要要解决什么能力：仅“连接参数解析”还是还要“端口转发/代理链/跳板”等？
- 你希望的覆盖优先级：CLI 参数/环境变量/SSHMcp 自己的配置 vs ssh_config？
- 安全边界：是否允许读取并执行 `ProxyCommand`/`LocalCommand` 一类可能触发命令执行的字段？
- SSHMcp 最终是“自己实现 SSH 客户端”还是“调用系统 ssh 客户端（子进程）”？（这直接决定 ProxyCommand/Jump/转发的可实现性和风险面）

## Scope Boundaries
- INCLUDE: 读取并解析本地 ssh_config（跨平台路径），映射为 SSH 连接配置
- EXCLUDE: 暂未定义
