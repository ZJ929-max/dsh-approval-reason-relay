/**
 * dsh-approval-reason-relay 的行为测试：用最小 ctx 桩驱动两个 waterfall 监听。
 * 运行：node test/relay.test.mjs
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { apply } from '../index.js'

const APPROVAL_REJECTED = 'APPROVAL_REJECTED'

function harness() {
  const listeners = new Map()
  apply({
    on(event, fn) {
      const bucket = listeners.get(event) ?? []
      bucket.push(fn)
      listeners.set(event, bucket)
      return () => {}
    },
  })
  const at = event => {
    const bucket = listeners.get(event)
    assert.ok(bucket && bucket.length === 1, `${event} should have exactly one listener`)
    return bucket[0]
  }
  return { approval: at('approval/request'), post: at('tools/post-execute') }
}

function agent(id = 'session-1') {
  return { session: { id } }
}

/** 管线在三种非授权结局下写入的工具结果。 */
function failure(callId, code, message, name = 'pwsh') {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message.replace(/\{name\}/g, name)}` }],
    error: {
      message: message.replace(/\{name\}/g, name),
      info: { name: 'ApprovalError', code },
    },
  }
}

/** 用户点「拒绝」的结果。 */
function rejection(callId, name = 'pwsh') {
  return failure(callId, APPROVAL_REJECTED, 'the user rejected tool "{name}"', name)
}

function callExec(callId, owner = agent()) {
  return { callId, name: 'pwsh', agent: owner }
}

async function ask(t, reason, callId = 'call-1', outcome = 'rejected', owner = agent()) {
  return t.approval({ agent: owner, toolName: 'pwsh', callId, reason }, async () => outcome)
}

const cases = []
const test = (title, fn) => cases.push([title, fn])

test('自动审查的理由在用户拒绝后进入模型可见内容', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": deleting a pre-existing directory outside the project')
  const decision = await t.post(
    callExec('call-1'),
    rejection('call-1'),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  const text = decision.feedback.map(block => block.text).join('\n')
  // 只说被自动审查拒绝，不提「用户拒绝」
  assert.match(text, /^Error: approval was denied, so tool "pwsh" did not run: Auto review denied tool "pwsh"/)
  assert.match(text, /deleting a pre-existing directory outside the project/)
  assert.doesNotMatch(text, /user rejected/)
  assert.equal(decision.feedback.length, 1)
  assert.equal(decision.info.code, APPROVAL_REJECTED)
  assert.equal(decision.info.name, 'ApprovalError')
  assert.equal(decision.info.reason, 'Auto review denied tool "pwsh": deleting a pre-existing directory outside the project')
})

test('没有理由的审批请求不改变结果', async () => {
  const t = harness()
  await ask(t, undefined)
  const original = { kind: 'accept' }
  const decision = await t.post(callExec('call-2'), rejection('call-2'), async () => original)
  assert.equal(decision, original)
})

test('审批被取消/超时（APPROVAL_CANCELLED）时同样带回理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason T', 'call-4', 'cancelled')
  const decision = await t.post(
    callExec('call-4'),
    failure('call-4', 'APPROVAL_CANCELLED', 'approval for tool "{name}" was cancelled'),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  const text = decision.feedback.map(block => block.text).join('\n')
  assert.match(text, /approval was denied/)
  assert.match(text, /reason T/)
  assert.equal(decision.info.code, 'APPROVAL_CANCELLED')
})

test('审批超时（outcome=cancelled → 规范取消结果）时带回理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "edit": 目标与范围无法确认', 'call-6', 'cancelled')
  const decision = await t.post(
    callExec('call-6'),
    {
      isError: true,
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
    },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  const text = decision.feedback.map(block => block.text).join('\n')
  // 取消结果被替换成一句完整说明（不再透传 "aborted before dispatch" 那句空话）
  assert.match(text, /^Error: approval was cancelled before a decision/)
  assert.match(text, /prompt timed out/)
  assert.match(text, /Auto review denied tool "edit": 目标与范围无法确认/)
  // 取消结果的 AbortError 身份保持不变
  assert.equal(decision.info.name, 'AbortError')
  assert.equal(decision.info.code, 'ABORTED_BEFORE_DISPATCH')
})

test('审批已允许、随后因别的原因取消时不乱加理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason L', 'call-7', 'allowed-once')
  const original = { kind: 'accept' }
  const aborted = {
    isError: true,
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
  }
  assert.equal(await t.post(callExec('call-7'), aborted, async () => original), original)
})

test('超时竞态：审批链还没返回、结局未知时也要带回理由', async () => {
  const t = harness()
  let release
  const never = new Promise(resolve => { release = resolve })
  // 审批 listener 的 next() 挂住（模拟 decide() 因 signal 中止而丢弃审批链）
  const inFlight = t.approval(
    { agent: agent(), toolName: 'pwsh', callId: 'call-9', reason: 'Auto review denied tool "pwsh": reason R' },
    () => never,
  )
  const decision = await t.post(
    callExec('call-9'),
    {
      isError: true,
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
    },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback.map(b => b.text).join('\n'), /reason R/)
  release('cancelled')
  await inFlight
})

test('非自动审查的审批（例如沙箱升级）保持 DSH 原样', async () => {
  const t = harness()
  await ask(t, 'escalate sandbox to danger-full-access: 把项目搬到 C:\\dev', 'call-10')
  const original = { kind: 'accept' }
  assert.equal(await t.post(callExec('call-10'), rejection('call-10'), async () => original), original)
})

test('审批被取消但管线给的是审批错误时走审批错误分支', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason M', 'call-8', 'cancelled')
  const decision = await t.post(
    callExec('call-8'),
    failure('call-8', 'APPROVAL_CANCELLED', 'approval for tool "{name}" was cancelled'),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback.map(b => b.text).join('\n'), /reason M/)
  assert.doesNotMatch(decision.feedback.map(b => b.text).join('\n'), /prompt timed out/)
})

test('无可用审批通道（APPROVAL_UNAVAILABLE）时同样带回理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason U', 'call-5', 'unavailable')
  const decision = await t.post(
    callExec('call-5'),
    failure('call-5', 'APPROVAL_UNAVAILABLE', 'tool "{name}" requires approval, but no approval channel is available'),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback.map(block => block.text).join('\n'), /reason U/)
})

test('被允许的调用不追加任何文本，且理由被消费', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason A', 'call-3', 'allowed-once')
  const original = { kind: 'accept' }
  const allowed = { isError: false, content: [{ type: 'text', text: 'ok' }] }
  assert.equal(await t.post(callExec('call-3'), allowed, async () => original), original)
  // 理由已消费：同一 callId 的第二次结果不会被追加
  const after = await t.post(callExec('call-3'), rejection('call-3'), async () => ({ kind: 'accept' }))
  assert.deepEqual(after, { kind: 'accept' })
})

test('下游替换过内容时以审批理由为准（不再提「用户拒绝」）', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason B')
  const replaced = [{ type: 'text', text: 'Error: the user rejected tool "pwsh"' }]
  const decision = await t.post(
    callExec('call-1'),
    rejection('call-1'),
    async () => ({ kind: 'accept', content: replaced }),
  )
  assert.equal(decision.kind, 'block')
  assert.equal(decision.feedback.length, 1)
  assert.match(decision.feedback[0].text, /^Error: approval was denied/)
  assert.match(decision.feedback[0].text, /reason B/)
  assert.doesNotMatch(decision.feedback[0].text, /user rejected/)
})

test('下游是 block 时把说明追加到它的反馈里', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason C')
  const decision = await t.post(
    callExec('call-1'),
    rejection('call-1'),
    async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }] }),
  )
  assert.equal(decision.kind, 'block')
  assert.equal(decision.feedback.length, 2)
  assert.match(decision.feedback[1].text, /reason C/)
})

test('callId 不匹配时不串理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason D', 'call-9')
  const original = { kind: 'accept' }
  assert.equal(await t.post(callExec('call-1'), rejection('call-1'), async () => original), original)
})

test('不同会话的同一 callId 不串理由', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason E', 'call-1', 'rejected', agent('session-A'))
  const original = { kind: 'accept' }
  assert.equal(
    await t.post(callExec('call-1', agent('session-B')), rejection('call-1'), async () => original),
    original,
  )
})

test('非审批拒绝的错误不被改写', async () => {
  const t = harness()
  await ask(t, 'Auto review denied tool "pwsh": reason F')
  const original = { kind: 'accept' }
  const other = {
    isError: true,
    content: [{ type: 'text', text: 'Error: boom' }],
    error: { message: 'boom', info: { name: 'Error', code: 'SOMETHING_ELSE' } },
  }
  assert.equal(await t.post(callExec('call-1'), other, async () => original), original)
})

// 输出同时写一份文件：本机沙箱禁止 pwsh 捕获子进程管道的输出。
const lines = []
function record(line) {
  lines.push(line)
  console.log(line)
}
function flush() {
  if (process.env.RELAY_TEST_LOG) {
    writeFileSync(process.env.RELAY_TEST_LOG, `${lines.join('\n')}\n`)
  }
}

try {
  for (const [title, fn] of cases) {
    await fn()
    record(`ok - ${title}`)
  }
  record(`${cases.length} passed`)
} catch (error) {
  record(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
}
flush()
