import { randomUUID } from 'node:crypto'

/** 单次回复的字符上限，避免把超长回答整段塞回 MCP 结果。 */
const MAX_REPLY_CHARS = 100_000

/**
 * 从 dsh `sessionController.wait()` 返回的历史记录里取出助手文本。
 *
 * `wait()` 给的 `output.records` 是**会话事件**（`{ type, seq, time, data }`，按新到旧排列），
 * 助手回复在 `assistant/message` 事件的 `data.message.content` 里。不同 dsh 版本也出现过
 * 直接给消息对象的形式，这里一并兼容，取不到就跳过，不做结构断言。
 *
 * @param {unknown} records
 * @returns {string}
 */
export function extractAssistantText(records) {
  if (!Array.isArray(records)) return ''

  // wait() 声明是「最新在前」，按 seq 升序拼回去才是说话顺序。
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

    // dsh 会话事件：assistant/message 携带一条完整的助手消息。
    if (typeof rec.type === 'string') {
      if (rec.type !== 'assistant/message') continue
      collectText(rec.data?.message?.content, parts)
      continue
    }

    // 兼容直接给消息对象的旧形式。
    if (rec.role === 'user' || rec.kind === 'user') continue
    if (!collectText(rec.content, parts) && typeof rec.text === 'string') parts.push(rec.text)
  }

  const text = parts.join('\n\n').trim()
  return text.length > MAX_REPLY_CHARS
    ? `${text.slice(0, MAX_REPLY_CHARS)}\n\n…（回复超过 ${MAX_REPLY_CHARS} 字符，已截断）`
    : text
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
  async function ask({ message, sessionId, timeoutMs, signal }) {
    const sc = getSessionController()
    if (!supportsChat(sc)) {
      throw Object.assign(new Error('本机的 dsh 没有暴露 sessionController，无法对话'), { code: 'CHAT_UNAVAILABLE' })
    }

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
      const created = await sc.create({})
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
        const before = await sc.state({ sessionId: targetSession })
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
    try {
      waited = await sc.wait(
        {
          sessionId: targetSession,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          timeoutMs: timeoutMs ?? settings.timeoutMs ?? 300_000,
        },
        signal,
      )
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

    const reply = extractAssistantText(waited?.output?.records)
    const reason = typeof waited?.reason === 'string' ? waited.reason : 'idle'
    return {
      sessionId: targetSession,
      reply,
      reason,
      timedOut: reason === 'timeout',
    }
  }

  return { ask, supportsChat: () => supportsChat(getSessionController()) }
}
