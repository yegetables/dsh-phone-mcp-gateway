import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshChat, extractAssistantText, supportsChat } from '../lib/dsh-chat.js'

function fakeController({ createSessionId = 'sess-1', waitResult } = {}) {
  const calls = { create: [], prompt: [], wait: [], cancel: [] }
  const controller = {
    calls,
    async create(request) {
      calls.create.push(request)
      return { sessionId: createSessionId }
    },
    async prompt(request, signal) {
      calls.prompt.push({ request, aborted: Boolean(signal?.aborted) })
      return { accepted: true }
    },
    async wait(request, signal) {
      calls.wait.push({ request, aborted: Boolean(signal?.aborted) })
      if (typeof waitResult === 'function') return waitResult(request)
      return waitResult ?? {
        reason: 'idle',
        state: { cursor: 1, active: false, running: false, queue: null, pendingInput: [] },
        output: {
          records: [{ type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '手机这边的答复' }] } } }],
          truncated: false,
        },
      }
    },
    async state(request) {
      calls.state = calls.state || []
      calls.state.push(request)
      return { cursor: 41, active: false, running: false, queue: null, pendingInput: [] }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { cancelled: true }
    },
  }
  return controller
}

test('extractAssistantText 兼容不同记录结构，并跳过用户消息', () => {
  // dsh 会话事件（wait() 的真实形态）：按 seq 升序拼回
  assert.equal(
    extractAssistantText([
      { type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'text', text: '答句二' }] } } },
      { type: 'user/message', seq: 11, data: { message: { content: [{ type: 'text', text: '问句' }] } } },
      { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '答句一' }] } } },
    ]),
    '答句一\n\n答句二',
  )
  // 旧形态：直接给消息对象
  assert.equal(
    extractAssistantText([
      { role: 'user', content: [{ type: 'text', text: '问句' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答句' }] },
    ]),
    '答句',
  )
  assert.equal(extractAssistantText([{ text: '扁平文本' }]), '扁平文本')
  assert.equal(extractAssistantText([{ role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] }]), '')
  assert.equal(extractAssistantText([{ type: 'tool/result', seq: 1, data: {} }]), '')
  assert.equal(extractAssistantText(undefined), '')
})

test('supportsChat 只有在 prompt/wait/create 都在时才为真', () => {
  assert.equal(supportsChat(fakeController()), true)
  assert.equal(supportsChat({ prompt() {}, wait() {} }), false)
  assert.equal(supportsChat(null), false)
})

test('createDshChat：新建会话 → 发消息 → 等这一轮 → 返回答复', async () => {
  const controller = fakeController()
  const chat = createDshChat({
    getSessionController: () => controller,
    getSettings: () => ({ timeoutMs: 1000, allowNewSession: true }),
  })

  const result = await chat.ask({ message: '你好' })
  assert.equal(result.sessionId, 'sess-1')
  assert.equal(result.reply, '手机这边的答复')
  assert.equal(result.timedOut, false)

  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.prompt[0].request.sessionId, 'sess-1')
  assert.deepEqual(controller.calls.prompt[0].request.content, [{ type: 'text', text: '你好' }])
  assert.equal(controller.calls.prompt[0].request.mode, 'queue')
  assert.equal(controller.calls.wait[0].request.timeoutMs, 1000)
  // 只取发消息之后的记录
  assert.equal(controller.calls.state[0].sessionId, 'sess-1')
  assert.equal(controller.calls.wait[0].request.afterSeq, 41)

  // 复用同一个私有会话，不再新建
  await chat.ask({ message: '第二句' })
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.prompt[1].request.sessionId, 'sess-1')
})

test('createDshChat：超时返回部分答复并标记 timedOut', async () => {
  const controller = fakeController({
    waitResult: {
      reason: 'timeout',
      state: { cursor: 2, active: true, running: true, queue: null, pendingInput: [] },
      output: { records: [{ type: 'assistant/message', seq: 9, data: { message: { content: [{ type: 'text', text: '说到一半' }] } } }], truncated: false },
    },
  })
  const chat = createDshChat({
    getSessionController: () => controller,
    getSettings: () => ({ timeoutMs: 50 }),
  })
  const result = await chat.ask({ message: '长任务' })
  assert.equal(result.timedOut, true)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.reply, '说到一半')
})

test('createDshChat：禁用新建且没配会话时明确报错', async () => {
  const controller = fakeController()
  const chat = createDshChat({
    getSessionController: () => controller,
    getSettings: () => ({ allowNewSession: false, sessionId: '' }),
  })
  await assert.rejects(() => chat.ask({ message: '你好' }), (error) => {
    assert.equal(error.code, 'CHAT_NO_SESSION')
    return true
  })
  assert.equal(controller.calls.create.length, 0)
})

test('createDshChat：宿主没有 sessionController 时给出 CHAT_UNAVAILABLE', async () => {
  const chat = createDshChat({ getSessionController: () => null, getSettings: () => ({}) })
  await assert.rejects(() => chat.ask({ message: 'hi' }), (error) => {
    assert.equal(error.code, 'CHAT_UNAVAILABLE')
    return true
  })
})

test('createDshChat：wait 先返回「还没开跑」的空结果时，会等这一轮真正跑完再取答复', async () => {
  const calls = { prompt: [], wait: [], state: [] }
  let waitCount = 0
  let running = false
  const controller = {
    async create() { return { sessionId: 'sess-race' } },
    async prompt(request) { calls.prompt.push(request); return { accepted: true } },
    async state() {
      calls.state.push(Date.now())
      // 第一次是读游标（未 running），prompt 之后第二轮才会 running
      return { cursor: 3, running }
    },
    async wait(request) {
      calls.wait.push(request)
      waitCount += 1
      if (waitCount === 1) {
        // 这一轮还没开跑：立刻返回 idle 且没有新记录
        return { reason: 'idle', state: { running: false }, output: { records: [], truncated: false } }
      }
      return {
        reason: 'idle',
        state: { running: false },
        output: { records: [{ type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '跑完了的答复' }] } } }], truncated: false },
      }
    },
    async cancel() { return { cancelled: true } },
  }

  const chat = createDshChat({
    getSessionController: () => controller,
    getSettings: () => ({ timeoutMs: 5000 }),
  })

  // prompt 之后让 state 报告 running，模拟这一轮开跑
  const originalPrompt = controller.prompt
  controller.prompt = async (request) => {
    running = true
    return originalPrompt(request)
  }

  const result = await chat.ask({ message: '你好' })
  assert.equal(result.reply, '跑完了的答复')
  assert.ok(calls.wait.length >= 2, '空结果后应再等一次，而不是直接返回空')
})
