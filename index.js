/**
 * dsh-approval-reason-relay —— 审批被拒时补回「为什么问我」。
 *
 * 问题：
 *   `tools/pre-execute` 的 `ask` 决策会把「审批方要求批准的理由」放在
 *   `ask.reason` 里，`ApprovalService` 也把它写进 `approval/asked` 审计事件；
 *   但 `ToolExecutionPipeline.serviceAsk()` 在用户拒绝后固定写
 *   `the user rejected tool "<name>"`，`ask.reason` 就此丢失。
 *   自动审查（@deepseek-ai/dsh-experimental-auto-review）正是用这条路径
 *   把「审查模型拒绝的理由」交给用户裁决的，所以用户点拒绝之后，
 *   智能体只看得到「用户拒绝了」，看不到「自动审查为什么拒绝」。
 *
 * 做法（不动 DSH 核心、不 fork 自动审查）：
 *   1. 在 `approval/request` 上挂一个 prepend 监听，`next()` 拿到结局后，
 *      把这次请求的理由与结局按 (session, callId) 记下来。
 *   2. 在 `tools/post-execute` 上挂一个 prepend 监听：拿到下游决策后，
 *      分两种没跑成的情况把理由追加进模型可见内容 —
 *      a) 审批错误（用户拒绝 / 审批被取消 / 无可用通道）：保留 ApprovalError
 *         身份与 `info.reason`；
 *      b) 审批久无人裁决被撤销：管线此时产出的是规范取消结果
 *         `AbortError` + `ABORTED_BEFORE_DISPATCH`（不是审批错误），
 *         这也是模型原本只看到 "tool call aborted before dispatch" 的原因。
 *   这两条都**只对自动审查的拒绝生效**（`ask.reason` 以
 *   `Auto review denied tool "…"` 开头）；沙箱升级等其它审批方保持 DSH 原样。
 *
 * 只增加/替换模型可见文本，不改任何决策：允许仍是允许，拒绝仍是拒绝。
 */

/** 审批相关失败记录的错误名（@deepseek-ai/dsh-tools error-codes）。 */
const APPROVAL_ERROR_NAME = 'ApprovalError'

/**
 * 三种「没给授权」的结局：用户显式拒绝、审批被取消（含超时撤销）、
 * 没有可用审批通道。三者都不带理由，用户裁决时看到的理由要在这三种情况下都补回来。
 */
const NON_GRANT_CODES = new Set([
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'APPROVAL_UNAVAILABLE',
])

/** 记住的待结算审批请求上限；正常流程每条都在 post-execute 里被消费掉。 */
const MAX_REMEMBERED = 256

/** (session, callId) → { reason, outcome }：审批方给出的理由与最终结局。 */
const remembered = new Map()

/** 一次审批请求的稳定键：callId 只在 session 内唯一。 */
function memoKey(agent, callId) {
  return `${agent.session.id}\u0000${callId}`
}

/** 记下一条理由，超限时挤掉最早的一条。 */
function remember(key, reason) {
  if (remembered.size >= MAX_REMEMBERED) {
    const oldest = remembered.keys().next()
    if (!oldest.done) remembered.delete(oldest.value)
  }
  remembered.set(key, reason)
}

/** 批准类结果不需要解释，消费后直接丢掉。 */
function take(key) {
  const reason = remembered.get(key)
  remembered.delete(key)
  return reason
}

/**
 * 审批超时/撤销时，管线产出的是**规范取消结果**而不是审批错误：
 * `ApprovalService` 与调用方 signal 打平后 `approvalCancelled` 为真，
 * `ToolExecutionPipeline.prepare()` 直接返回 `toolAbortedBeforeDispatchResult()`
 * （`AbortError` + `ABORTED_BEFORE_DISPATCH`，或已派发后的 `ABORTED`）。
 * 这才是「用户一直不在」时模型实际拿到的那条结果。
 */
const CANCELLATION_CODES = new Set(['ABORTED_BEFORE_DISPATCH', 'ABORTED'])

/** 审批被取消（含超时）时，调用为什么没跑。 */
function cancelledText(toolName, reason) {
  return `Error: approval was cancelled before a decision (for example, the prompt timed out), `
    + `so tool "${toolName}" did not run: ${reason}`
}

/** 审批未获授权时，调用为什么没跑；只陈述审批结果，不提是谁点的拒绝。 */
function deniedText(toolName, reason) {
  return `Error: approval was denied, so tool "${toolName}" did not run: ${reason}`
}

/**
 * 只接自动审查的拒绝。`askUser()` 拼出的审计理由是
 * `Auto review denied tool "<name>"[: <reviewer reason>]`，据此识别。
 * 沙箱升级等其它审批方保持 DSH 原样，不碰。
 */
const AUTO_REVIEW_ASK_PREFIX = 'Auto review denied tool "'

/** 插件名（loader 诊断用）。 */
export const name = 'approval-reason-relay'

/** 只在审批与工具服务就绪后挂监听，保证第一次工具调用前已注册。 */
export const inject = ['approval', 'tools']

/**
 * 记录审批理由与结局，并在调用因审批未获授权而没跑成时把它补进模型可见的结果。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  ctx.on('approval/request', async (req, next) => {
    const { reason, callId } = req
    /**
     * 必须**在** `next()` 之前记下：`ApprovalService.decide()` 是「答案 vs signal」竞速，
     * signal 一中止就立刻返回 `cancelled` 并丢弃还在等待的审批链，`next()` 可能永远不返回。
     * 先记 `{reason, outcome: undefined}`，回来后再补结局。
     */
    const memo = typeof reason === 'string' && reason.length > 0 && callId !== undefined
      ? { reason, outcome: undefined }
      : undefined
    if (memo !== undefined) remember(memoKey(req.agent, callId), memo)
    try {
      const outcome = await next()
      if (memo !== undefined) memo.outcome = outcome
      return outcome
    } catch (error) {
      // 审批链在撤销时可能直接抛；服务层会把它归一成 'unavailable'。
      if (memo !== undefined) memo.outcome = 'unavailable'
      throw error
    }
  }, { prepend: true })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const { callId, agent } = exec
    if (callId === undefined || agent === undefined) return decision

    const memo = take(memoKey(agent, callId))
    if (memo === undefined) return decision
    // @deepseek-ai/dsh-experimental-auto-review 的 ask.reason 恒以这句开头（英文审计文本）。
    if (!memo.reason.startsWith(AUTO_REVIEW_ASK_PREFIX)) return decision

    const info = result.isError ? result.error.info : undefined
    const approvalFailure = info !== undefined
      && info.name === APPROVAL_ERROR_NAME
      && NON_GRANT_CODES.has(info.code)
    /**
     * 规范取消结果 + 有审批 memo 且没被授予过 = 审批还没裁决调用就被撤销（超时/取消）。
     * 这里不看 `memo.outcome === 'cancelled'`：真出现竞态时 outcome 可能停在 undefined
     * 或变成 'unavailable'，但「取消结果 + 非 allowed-once」这个组合已经足够确定。
     */
    const cancelledWhilePending = memo.outcome !== 'allowed-once'
      && info !== undefined
      && CANCELLATION_CODES.has(info.code)
    if (!approvalFailure && !cancelledWhilePending) return decision

    // 上游那句「the user rejected …」不再透传：模型看到的应是审批结果 + 审批方理由本身。
    const text = cancelledWhilePending
      ? cancelledText(exec.name, memo.reason)
      : deniedText(exec.name, memo.reason)
    const feedback = [{ type: 'text', text }]
    const failureInfo = approvalFailure ? { ...info, reason: memo.reason } : info
    // 别的策略已经显式 block 时保留它的措辞，我们的说明追加在后。
    if (decision.kind === 'block') {
      return { ...decision, feedback: [...decision.feedback, ...feedback] }
    }
    return { kind: 'block', feedback, info: failureInfo }
  }, { prepend: true })
}
