# 审批拒绝理由回传（dsh-approval-reason-relay）

## 它修的是什么

在 **自动审查**（Auto review）访问模式下，审查模型拒绝一次工具调用、并把决定交给你裁决时，
审批请求里带着审查模型给出的理由（`ask.reason`，例如「删除的是项目外既有的目录」）。
你点「拒绝」之后，DSH 的工具执行管线固定只写一句：

```
Error: the user rejected tool "bash"
```

`ask.reason` 在这一步被丢掉，于是智能体只知道自己被拒，不知道**为什么**被拒——没法改参数重试，
只能瞎猜或者来问你。审查理由本身也没有进模型可见内容，它只留在 `approval/asked` 审计事件里
和 `ToolErrorInfo.reason`（持久化投影可见、模型不可见）里。

## 它怎么修

不动 DSH 核心，也不 fork 自动审查插件，只借两个已有的扩展点：

1. **`approval/request`（waterfall，prepend）**：审批请求发出时记下它的理由，等 `next()` 回来后
   连同**结局**（allowed-once / rejected / cancelled / unavailable）一起按 `(session, callId)` 存起来；
   屏幕上问你的流程完全不变。
2. **`tools/post-execute`（waterfall，prepend）**：先 `next()` 拿下游决策，再按两种「没跑成」补理由：

| 情况 | 管线给出的结果 | 模型看到的内容 |
|---|---|---|
| **自动审查**拒绝 + 用户点拒绝 | `ApprovalError` / `APPROVAL_REJECTED` | `Error: approval was denied, so tool "X" did not run: <审查理由>` |
| **自动审查**拒绝 + 无可用审批通道 | `ApprovalError` / `APPROVAL_UNAVAILABLE` | 同上 |
| **自动审查**拒绝 + 审批被取消（用户取消） | `ApprovalError` / `APPROVAL_CANCELLED` | 同上 |
| **自动审查**拒绝 + 你一直不在、超时撤销 | `AbortError` / `ABORTED_BEFORE_DISPATCH`（**不是**审批错误） | `Error: approval was cancelled before a decision (for example, the prompt timed out), so tool "X" did not run: <审查理由>` |
| 其它审批方（沙箱升级、需要批准的工具…） | 原样 | **完全不变**，DSH 写什么就是什么 |

识别方式是 `ask.reason` 的前缀：自动审查的 `askUser()` 恒拼成
`Auto review denied tool "<name>"[: <审查理由>]`。不匹配的一律原样放过。

最后一行是容易漏的坑：超时会把调用方 signal 一起中止，`ToolExecutionPipeline.prepare()` 于是直接返回
规范取消结果 `Error: tool call aborted before dispatch`，**根本不经过 `ApprovalError`**。
（真机证据：某个会话的 `approval/asked` 带了完整的审查理由，`approval/decided` 是 `cancelled`，
紧随其后的 `tool/ptc-dispatch` 却是 `aborted before dispatch`。）

还有两个实现细节：

- **memo 必须在 `next()` 之前写**。`ApprovalService.decide()` 是「答案 vs signal」竞速，signal 一中止就
  立刻返回 `cancelled` 并丢弃还在等待的审批链，`next()` 可能永远不返回——等它回来再记就会漏掉超时那次。
- 上游那句 `the user rejected tool "X"` **不再透传**：模型看到的是审批结果加审批方理由本身，
  不点明是谁点的拒绝。别的策略已经显式 `block` 时保留它的措辞，我们的说明追加在后。

结果（自动审查拒绝、你点拒绝）：

```
Error: approval was denied, so tool "pwsh" did not run:
Auto review denied tool "pwsh": deleting a pre-existing directory outside the project
```

超时场景：

```
Error: approval was cancelled before a decision (for example, the prompt timed out),
so tool "edit" did not run: Auto review denied tool "edit": 目标与范围无法确认…
```

## 边界

- **只加文本，不改决策**：允许仍是允许，拒绝仍是拒绝，不会让被拒的调用跑起来。
- 理由原样保留，不翻译（自动审查的审查理由是英文原文，翻译会改变证据）。
- **只作用于自动审查**：沙箱升级、其它需要批准的工具在拒绝/超时后仍是 DSH 原文
  （`the user rejected tool "X"` 等），不受本插件影响。没有给理由的请求也不会被改写。
- 记忆上限 256 条，每条在对应调用的 `tools/post-execute` 里被消费；被允许的调用消费后直接丢弃。
- 同一 `callId` 在 `session` 内唯一；跨会话/子智能体不会串。
- 不依赖工具的上下线，也不注册任何工具；卸载即恢复原行为。

## 兼容性

依赖两个稳定扩展点（`approval/request`、`tools/post-execute`）与三个持久化错误码
（`APPROVAL_REJECTED` / `APPROVAL_CANCELLED` / `APPROVAL_UNAVAILABLE`），均为 DSH 0.2.x 的公开契约。
若将来 `ToolExecutionPipeline.serviceAsk()` 自己把 `ask.reason` 写进失败消息，本插件追加的说明会与之重复，
届时卸载即可。

## 未验证

- 「整轮 120 秒无人裁决」在**新版插件**下的端到端效果：已按真机日志里的真实错误码
  （`outcome=cancelled` + `ABORTED_BEFORE_DISPATCH`）补齐分支并有单测，但还没在新的实例里重跑一次超时。
- 超时到底由谁计时（Host 的审批瀑布还是 Remote 事件通道）没有定位到具体代码；只确认了它表现出的
  两个事实：审批结局记为 `cancelled`，调用方 signal 同时被中止。

## 改代码后如何生效

`dsh-hmr` **不会**热替换这个 `link:` 安装的插件（`apply()` 写探针 18 秒无重跑，chokidar 不跟随 junction）。
不必重启 DSH：用 `plugin_manager` `set_plugin` 把 `include:approval-reason-relay` 先 `false` 再 `true`，
会重新 import 磁盘上的新代码（实测：探针标记写过一次，说明确实换了模块）。
