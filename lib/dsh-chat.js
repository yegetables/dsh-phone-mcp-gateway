import { randomUUID } from 'node:crypto'

/** 单次回复的字符上限，避免把超长回答整段塞回 MCP 结果。 */
const MAX_REPLY_CHARS = 100_000

/** 明确不是助手输出的事件类型，解析时直接跳过。 */
const NON_ASSISTANT_TYPES = new Set(['user/message', 'system/message', 'developer/message', 'tool/result'])

/**
 * 从 dsh `sessionController.wait()` 返回的历史记录里取出助手文本。
 *
 * `wait()` 给的 `output.records` 是**会话事件**（`{ type, seq, time, data }`，按新到旧排列），
 * 助手回复在 `assistant/message` 事件的 `data.message.content` 里。不同 dsh 版本的字段位置
 * 不完全一样，所以这里对每条事件递归找 `{ type: 'text', text }` 块，而不是只认一条固定路径。
 *
 * @param {unknown} records
 * @returns {string}
 */
export function extractAssistantText(records) {
  if (!Array.isArray(records)) return ''

  const ordered = records
    .filter((record) => record && typeof record === 'object')
    .slice()
    .sort((a, b) => {
      const left = Number(/** @type {any} */ (a).seq)
      const right = Number(/** @type {any} */ (b).seq)
      if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
      return left - right
    })

  const parts = []
  for (const record of ordered) {
    const rec = /** @type {Record<string, any>} */ (record)

    if (typeof rec.type === 'string') {
      if (NON_ASSISTANT_TYPES.has(rec.type)) continue
      collectTextBlocks(rec.data ?? rec)
      continue
    }

    // 兼容直接给消息对象的旧形式。
    if (rec.role === 'user' || rec.kind === 'user') continue
    if (!collectText(rec.content, parts) && typeof rec.text === 'string') parts.push(rec.text)
  }

  function collectTextBlocks(value, depth = 0) {
    if (!value || depth > 6) return
    if (Array.isArray(value)) {
      for (const item of value) collectTextBlocks(item, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    if (typeof value.text === 'string' && (value.type === 'text' || value.type === undefined)) {
      parts.push(value.text)
      return
    }
    for (const key of ['message', 'content', 'data', 'payload']) {
      if (value[key]) collectTextBlocks(value[key], depth + 1)
    }
  }

  const text = parts.join('\n\n').trim()
  return text.length > MAX_REPLY_CHARS
    ? `${text.slice(0, MAX_REPLY_CHARS)}\n\n…（回复超过 ${MAX_REPLY_CHARS} 字符，已截断）`
    : text
}

/**
 * 调试用：把 wait() 的结果压成一段可读摘要，用来核对真实事件结构。
 *
 * @param {any} waited
 * @returns {string}
 */
export function describeWaitResult(waited) {
  const records = Array.isArray(waited?.output?.records) ? waited.output.records : []
  const types = records.map((record) => String(record?.type ?? typeof record))
  const samples = records.slice(0, 3).map((record) => {
    try {
      return JSON.stringify(record).slice(0, 700)
    } catch {
      return '<unserializable>'
    }
  })
  return JSON.stringify(
    {
      reason: waited?.reason,
      state: waited?.state
        ? { running: waited.state.running, active: waited.state.active, cursor: waited.state.cursor, queue: Array.isArray(waited.state.queue) ? waited.state.queue.length : waited.state.queue }
        : null,
      recordCount: records.length,
      recordTypes: types.slice(0, 12),
      truncated: waited?.output?.truncated,
      samples,
    },
    null,
    2,
  )
}

/**
 * 把 content 里的文本块追加到 parts；返回是否识别为内容数组。
 *
 * @param {unknown} content
 * @param {string[]} parts
 * @returns {boolean}
 */
function collectText(content, parts) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) {
      parts.push(block.text)
    }
  }
  return true
}

/**
 * 判断注入进来的 dsh 会话服务是否具备对话所需的方法。
 *
 * @param {unknown} sessionController
 * @returns {boolean}
 */
export function supportsChat(sessionController) {
  const sc = /** @type {Record<string, any> | undefined} */ (sessionController)
  return Boolean(sc) && typeof sc.prompt === 'function' && typeof sc.wait === 'function' && typeof sc.create === 'function'
}

/**
 * 可被 abort 打断的等待。
 *
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 轮询会话状态，直到它进入 running（这一轮真的开跑），或到点/被取消。
 *
 * @param {any} sc
 * @param {string} sessionId
 * @param {number} until
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
async function waitUntilRunning(sc, sessionId, until, signal) {
  while (Date.now() < until) {
    // dsh 的每个 Remote 方法都要求 AbortSignal（内部会 signal.throwIfAborted()）。
    const current = await sc.state({ sessionId }, signal)
    if (current?.running) return true
    await delay(150, signal)
  }
  return false
}

/**
 * 把 dsh 会话服务包成一次「提问 → 等这一轮结束 → 取回复」的通道。
 *
 * 插件跑在手机的 dsh 引擎里，所以这是**真正和手机上的 dsh 对话**，不是模拟点输入框：
 * 外面发一条消息进来，dsh 按它自己的模型、工具、权限跑完这一轮，把回答交回给外部 agent。
 *
 * @param {{
 *   getSessionController: () => any,
 *   getSettings: () => { sessionId?: string, timeoutMs?: number, allowNewSession?: boolean },
 *   logger?: { info?: Function, warn?: Function },
 * }} options
 */
export function createDshChat({ getSessionController, getSettings, logger }) {
  /** 未指定会话时复用的私有会话 id（本次插件生命周期内保持不变）。 */
  let privateSessionId = null

  /**
   * @param {{ message: string, sessionId?: string, timeoutMs?: number, signal?: AbortSignal }} ask
   * @returns {Promise<{ sessionId: string, reply: string, reason: string, timedOut: boolean }>}
   */
  async function ask({ message, sessionId, timeoutMs, signal: providedSignal }) {
    const sc = getSessionController()
    if (!supportsChat(sc)) {
      throw Object.assign(new Error('本机的 dsh 没有暴露 sessionController，无法对话'), { code: 'CHAT_UNAVAILABLE' })
    }
    // dsh 的 Remote 方法都要 AbortSignal（内部直接 signal.throwIfAborted()），没有就补一个。
    const signal = providedSignal ?? new AbortController().signal

    const settings = getSettings() || {}
    const text = typeof message === 'string' ? message.trim() : ''
    if (!text) throw Object.assign(new Error('message 不能为空'), { code: 'INVALID_ARGUMENT' })

    let targetSession = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : (typeof settings.sessionId === 'string' && settings.sessionId.trim() ? settings.sessionId.trim() : privateSessionId)

    if (!targetSession) {
      if (settings.allowNewSession === false) {
        throw Object.assign(new Error('插件设置里禁止新建会话，且没有配置会话 id'), { code: 'CHAT_NO_SESSION' })
      }
      const created = await sc.create(settings.agentPreset ? { agentPreset: settings.agentPreset } : {})
      targetSession = created?.sessionId
      if (!targetSession) throw new Error('dsh 没有返回新会话 id')
      privateSessionId = targetSession
      logger?.info?.(`[phone-mcp-gateway] 对话使用新建会话 ${targetSession}`)
    }

    if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' })

    // 记下发消息前的游标：wait() 只回这一轮之后的记录，避免把会话旧历史也当成回复。
    let afterSeq
    if (typeof sc.state === 'function') {
      try {
        const before = await sc.state({ sessionId: targetSession }, signal)
        if (Number.isFinite(before?.cursor)) afterSeq = before.cursor
      } catch {
        // 读不到游标就退回「不带 afterSeq」，只是可能多带回历史记录。
      }
    }

    await sc.prompt(
      {
        requestId: randomUUID(),
        sessionId: targetSession,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      signal,
    )

    let waited
    let reply = ''
    let reason = 'idle'
    const totalTimeoutMs = timeoutMs ?? settings.timeoutMs ?? 300_000
    const deadline = Date.now() + totalTimeoutMs

    try {
      // prompt() 只是把消息投进 inbox；紧接着 wait() 可能撞上「这一轮还没开跑」的 idle 并立刻
      // 返回空结果（最初版本就是这么拿不到答复的）。所以空结果时不能直接收工，要等它真的跑起来。
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now())
        waited = await sc.wait(
          { sessionId: targetSession, ...(afterSeq === undefined ? {} : { afterSeq }), timeoutMs: Math.min(remaining, 20_000) },
          signal,
        )
        reason = typeof waited?.reason === 'string' ? waited.reason : 'idle'
        reply = extractAssistantText(waited?.output?.records)
        if (reply || reason === 'timeout') break

        const started = await waitUntilRunning(sc, targetSession, Math.min(deadline, Date.now() + 10_000), signal)
        if (!started) break
      }

      // 兜底：仍然没有文本时，读整个会话的助手记录（私有会话里就是这一轮的答复）。
      if (!reply) {
        try {
          const full = await sc.wait({ sessionId: targetSession, timeoutMs: 5_000 }, signal)
          reply = extractAssistantText(full?.output?.records)
        } catch {
          // 兜底失败就按没有文本返回。
        }
      }
    } catch (error) {
      // 客户端断开/取消时尽量把这一轮也停掉，别让手机继续跑。
      if (signal?.aborted && typeof sc.cancel === 'function') {
        try {
          await sc.cancel({ sessionId: targetSession })
        } catch {
          // 取消失败不影响把错误抛回去。
        }
      }
      throw error
    }

    return {
      sessionId: targetSession,
      reply,
      reason,
      timedOut: reason === 'timeout',
      debugInfo: describeWaitResult(waited),
    }
  }

  return { ask, supportsChat: () => supportsChat(getSessionController()) }
}
