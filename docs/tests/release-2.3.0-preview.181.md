# agent-network 2.3.0-preview.181

从 `d9f22c592efb18b3cb0a4b057d0da9942523d62d` 起的 preview 版本，接在 `2.3.0-preview.180` 之后。

## 本版内容（相对 2.3.0-preview.180）

- **fix(#1344 / PR #2800)**：`notifyServerOffline` 的两处 `POST /mcp` 请求头改为
  `Accept: application/json, text/event-stream`。此前只声明 `application/json`，
  Hub 走 Streamable HTTP 时返回 **406**，导致停止节点后的离线上报被静默丢弃。
- **test(#1337)**：Windows 隔离 runner 上的真实 CLI 停止副作用负控（A/B/C 三场景）、
  无关节点 offline 拒绝自检、report_status 响应内层判定（`ok:true` + 精确
  `alias` / `resume_id`）。(#2797)
- 其余为测试与文档调整，无运行时行为变化。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.181
```

## Upgrade

```bash
anet upgrade --preview
# 或指定版本
npm install -g @sleep2agi/agent-network@2.3.0-preview.181
```

> 已使用 `latest` 通道（`2.3.0-preview.180`）的用户可先保持不动；本版仅修复离线上报的
> `Accept` 协商，不影响已有节点运行。

## 验证

```bash
anet --version   # anet v2.3.0-preview.181
```
