# dsh-wait-subagent

<p align="center">
  <a href="./README.md"><strong>English</strong></a> ·
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
</p>

一个 DeepSeek Harness（cordis）插件，注册四个模型可调用的工具：

- `wait_subagent` — **主动阻塞等待指定的后台 continuable 子代理收尾（settle），并在同一次调用里拿到它的停止原因与收尾消息**；超时返回附带活动诊断（最后活动时间/轮次/最近输出），可区分「仍在工作」与「疑似停滞」。
- `get_subagent_status` — **非阻塞探活**：报告子代理是否仍在运行、距最后一次活动多久、最近输出摘要，用于中途判断「进行中 vs 静默停滞」。
- `wait_some_subagent` — **等待多个后台子代理中首个收尾者**，返回其 id/停止原因/收尾消息，用于并行 fan-out 的逐个收割。
- `wait_every_subagent` — **屏障：等待列出的所有后台子代理全部收尾**，按入参顺序返回每个子代理的结果外加 `failed` 失败清单，用于下一步需要全部 fan-out 结果的汇合点。

三个等待类工具的**收尾语义均包含异常结束**：`error`、`aborted`、`max-tokens`、`refusal` 都算收尾（与正常结束触发同一个生命周期事件）；靠 `stop_reason` 区分成败，失败的子代理不会挂住等待。

它补齐了子代理工作流的真实缺口：`run_in_background` 立即返回 `subagentId`，但想知道结果只能被动等异步 settlement 通知（可能迟到甚至缺失），且没有任何工具能主动等待或中途探活。

## 真实输出

以后台方式启动子代理，然后等待它：

```
wait_subagent({ subagent_id: "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3" })
```

子代理运行期间该调用阻塞。子代理收尾后工具返回：

```json
{
  "status": "settled",
  "subagent_id": "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3",
  "stop_reason": "completed",
  "closing_message": "Spec written to docs/plan.md; 3 files changed, ready for review."
}
```

模型看到的文本：

```
Subagent session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3 settled: completed
Spec written to docs/plan.md; 3 files changed, ready for review.
```

其他结果：

| 情形 | 返回 |
|---|---|
| 调用前子代理已收尾 | `{ "status": "settled", "subagent_id": "…", "stop_reason": "unknown" }` —— *"had already settled before this call; its closing message was delivered separately as a settlement notice."* |
| `timeout_ms` 超时 | `{ "status": "timeout", "subagent_id": "…", "diagnostics": { "observed": true, "lastActivityAgoMs": 412000, "turnCount": 7, "recentOutputs": ["…"] } }` —— *"Timed out waiting for subagent …"* + 活动诊断（未观测到活动时 `observed: false`，如实报告） |
| 调用方的 `AbortSignal` 触发 | `{ "status": "cancelled", "subagent_id": "…" }` |
| 未知 / 不属于自己的子代理 id | 直接报错：*"… is not one of your subagents — pass the id a background dispatch returned (see list_agents)"* |

## v1.2 的工具

### get_subagent_status — 中途探活

```
get_subagent_status({ subagent_id: "…" })
→ { "status": "running" | "settled", "observed": true,
    "lastActivityAgoMs": 12345, "turnCount": 6, "recentOutputs": ["…", "…"] }
```

- 不阻塞、不等待，立即返回；用于「它是还在干活，还是已经静默停滞？」的决策（继续等 / 打断 / 重派）。
- 活动观测来自插件对 `subagent/assistant-output`、`agent/status` 事件的订阅（payload 形状做了特征检测，未知形状忽略）。
- `observed: false` 表示插件未观测到该子代理的任何活动——如实在报，不猜测原因。

### wait_some_subagent — 首个收尾收割

```
wait_some_subagent({ subagent_ids: ["id-a", "id-b", "id-c"] })
→ { "status": "settled", "subagent_id": "id-b",
    "stop_reason": "completed", "closing_message": "…" }
```

- 传入 ≥2 个 id，阻塞到**任意一个**收尾即返回该 id；重复调用（剔除已收者）即可逐个收割并行任务。
- 任一列出者已收尾则立即返回（`stop_reason: "unknown"`）；超时附带最久无活动者的诊断。

### wait_every_subagent — 全部收尾的屏障

```
wait_every_subagent({ subagent_ids: ["id-a", "id-b"] })
→ { "status": "settled",
    "results": [
      { "subagent_id": "id-a", "stop_reason": "completed",
        "closing_message": "Spec written to docs/plan.md." },
      { "subagent_id": "id-b", "stop_reason": "error",
        "closing_message": "npm install failed: peer dep conflict." } ],
    "failed": ["id-b"] }
```

模型看到的文本：

```
Subagent id-a settled: completed
Spec written to docs/plan.md.
Subagent id-b settled: error
npm install failed: peer dep conflict.
Failed: id-b
```

- 传入 ≥2 个 id，阻塞到**每一个**都收尾后，**按入参顺序**返回各子代理结果，外加 `failed`（`stop_reason` 不是 `"completed"` 的 id 列表，仅非空时给出）。
- 调用前已收尾的子代理以 `stop_reason: "unknown"` 报告；异常结束（`error`/`aborted`/`max-tokens`/`refusal`）与正常结束一样触发收尾，不会挂住屏障。
- 超时时结果在 `pending` 中列出仍在运行的 id（附带活动诊断），不携带部分结果——之后可重新调用该工具，或改用逐个等待。

## 为什么需要它

现有子代理系统能给你的：

- `subagent` + `run_in_background: true` → 立即返回 `subagentId`，工作异步继续，稍后才送达 settlement 通知。
- `subagent` + `run_in_background: false` → 只在**启动**时阻塞。
- `send_message` → 发完即返回，从不等待回答。
- `list_agents` → 快照，不是等待（且明确提示"不要用来轮询"）。

缺的是：后台启动子代理之后，没有工具能**阻塞等待它完成**。这正是 `wait_subagent` 做的事——当你的下一步依赖子代理的结果时用它，而不是靠猜或轮询。并行派发时按流程选等待形态：`wait_some_subagent` 逐个收割（循环调用），`wait_every_subagent` 在需要全部结果的步骤前做屏障。

## 工作原理

- 在每个 root agent 上注册四个工具（与 `dsh-proactive` 相同的注册模式）。
- **成员资格门控**：`ctx.subagents.listChildren(parent.id)` —— 与 `list_agents` 读的同一个 projection —— 同时覆盖存活与仅存于存储的子代理，未知 id 直接报错，而不是被误报为已收尾。已知子代理若不在存活注册表中，说明早已收尾。
- 等待类工具监听 `subagent/end` 生命周期事件（子代理 activation 被释放时触发），作用域挂在插件上下文上（所有 agent 上下文的公共祖先）。`wait_every_subagent` 从同一事件流为每个列出的 id 记录一条结果，全部记录齐后才解除阻塞。
- 收尾时，子代理从存活注册表移除与 `subagent/end` 派发发生在同一个同步块里（`finishDisposal`），因此"先挂监听、再复查注册表"的顺序无竞态。此时已不在注册表中的子代理被记为早已收尾（`stop_reason: "unknown"`）。
- **活性观测（v1.1）**：插件上下文订阅 `subagent/assistant-output` 与 `agent/status` 事件，按子代理 id 维护活动表（最后活动时间、轮次、最近 5 条输出摘要各截 200 字符，上限追踪 256 个 id，LRU 淘汰）。payload 形状特征检测（`id`/`subagentId`/`agentId`/`agent.id`），未知形状忽略——事件缺失或形状不匹配时活性功能自动降级，不影响等待类工具。
- 可选 `timeout_ms` 参数：超时返回附 `diagnostics`（`wait_every_subagent` 则为 `pending` 列表；未观测到活动如实报 `observed: false`）。省略则无限等待——通常这是最佳选择。
- 尊重调用方的 `AbortSignal`（返回 `status: "cancelled"`）。

## 工具签名

```
wait_subagent(subagent_id: string, timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    subagent_id: string,
    stop_reason?: "completed" | "aborted" | "error" | "max-tokens" | "refusal" | "unknown",
    closing_message?: string,
    diagnostics?: { observed: boolean, lastActivityAgoMs?: integer,
                    turnCount?: integer, recentOutputs?: string[] } }

get_subagent_status(subagent_id: string)
→ { status: "running" | "settled", subagent_id: string, observed: boolean,
    lastActivityAgoMs?: integer, turnCount?: integer, recentOutputs?: string[] }

wait_some_subagent(subagent_ids: string[2+], timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    subagent_id: string,   // 首个收尾者（或超时诊断对象）
    stop_reason?: …, closing_message?: string, diagnostics?: … }

wait_every_subagent(subagent_ids: string[2+], timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    results?: [ { subagent_id: string,
                  stop_reason: "completed" | "aborted" | "error" | "max-tokens" | "refusal" | "unknown",
                  closing_message: string }, … ],   // 输入顺序，settled 时给出
    failed?: string[],                              // stop_reason != "completed"，非空时给出
    pending?: [ { subagent_id: string, observed: boolean,
                  lastActivityAgoMs?: integer, turnCount?: integer,
                  recentOutputs?: string[] }, … ] } // 仍在运行的 id，timeout 时给出
```

## 注意：不要在同一步里既等待又打断

`wait_subagent` 是并发安全的，但 `interrupt_agent` 不是——它独占工具通道，会排在任何进行中的调用之后。在同一步并行发起 `wait_subagent` 和 `interrupt_agent` 会被串行化：等待先跑满超时，打断才落地。请先调用 `interrupt_agent`，下一步再 `wait_subagent`（已被打断的子代理会很快收尾）。

## 安装

```bash
dsh plugin --profile web add dsh-wait-subagent
```

或从 GitHub 直装（源码安装——纯 ESM JavaScript，无构建步骤，pnpm ≥ 10 无需 allowBuilds 批准）：

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-wait-subagent
```

安装后重启 DSH 实例即可；插件自带的 `cordis.patch.yml` 会自动注册 loader entry。

## 权限与兼容

- **涉及范围**：在每个 root agent 上注册四个模型可调用的 Agent 工具（`wait_subagent` / `get_subagent_status` / `wait_some_subagent` / `wait_every_subagent`）。无 web client、无 UI 改动、无配置项。
- **阻塞语义**：等待类工具占用调用方 agent 的工具通道，直到目标子代理收尾、可选超时到期或调用方中止——这正是功能本身。等待机制是事件驱动（`subagent/end` 生命周期事件），非轮询，阻塞期间 CPU 占用可忽略。`get_subagent_status` 立即返回不阻塞。省略 `timeout_ms` 的等待不设上限（设计如此）；需要上限时请给足量级的 `timeout_ms`。
- **无副作用**：无网络请求、无外部服务、无文件系统写入。活动表仅存于插件进程内存（重启即清空）。
- **依赖**：运行时零依赖——`@deepseek-ai/dsh-tools` 为 peer 依赖，由 DSH 宿主提供（兼容范围：`^0.1.0-rc.2 || ^0.1.1-rc.1 || 0.1.2-rc.1 || ^0.1.5-rc.1 || ^0.1.7-rc.1 || >=0.2.0-rc.2`），Node ≥ 22.5。本地开发/验证钉版 0.1.2-rc.1（devDependencies）。

## 本地开发

```bash
npm install
npm run verify        # 运行 scripts/verify.mjs —— 静态断言 + mock 功能测试
```

就这些——`lib/` 是纯 ESM JavaScript，没有构建步骤。

## 发新版

```bash
npm run release        # 递增 patch 版本号并打包到 /tmp/dsh-wait-subagent-<新版>.tgz
```

然后把 tarball 发布到 npm，并推送版本 commit 与 tag：

```bash
git push --follow-tags
```

用 `npm view dsh-wait-subagent version` 复验。

## 许可证

MIT

## 社区

- 感谢 [LINUX DO](https://linux.do/) 社区提供的交流环境。
