import z from '@deepseek-ai/schemastery'
import { compileCidrs } from './cidr.js'

export const CREDENTIAL_REF = 'DSH_PHONE_MCP_TOKEN'
export const DEFAULT_BRIDGE_CONFIG_PATH = '/var/lib/dsh-app/phone/bridge.json'

export const DEFAULT_ALLOWED_CIDRS = Object.freeze([
  '127.0.0.1/32',
  '::1/128',
  '100.64.0.0/10',
  'fd7a:115c:a1e0::/48',
  '192.168.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
])

// Exact-empty validation with a fixed message avoids Schemastery echoing a
// misplaced secret in error diagnostics. Mirrors dsh-media's verified pattern.
const SecretSentinel = z.transform(z.any(), (value) => {
  if (value !== '') throw new Error('访问密钥只能通过 DSH 凭据服务写入。')
  return ''
}, true).default('').role('secret')

export const Config = z.object({
  enabled: z.boolean()
    .default(true)
    .volatile()
    .description({
      zh: '启用手机 MCP 外部网关（即改即生效；未配置密钥时会自动拒绝所有外部请求）',
      en: 'Enable external phone MCP gateway (takes effect immediately; refuses all requests until a token is configured)',
    }),

  bindHost: z.string()
    .default('0.0.0.0')
    .description({
      zh: '监听地址（默认 0.0.0.0 供局域网 / Tailscale 连接；仅走 adb forward 时可填 127.0.0.1，保存后重载生效）',
      en: 'Bind address (0.0.0.0 for LAN/Tailscale, or 127.0.0.1 for adb forward only; reloads plugin on save)',
    }),

  port: z.number()
    .min(1)
    .max(65535)
    .step(1)
    .default(3847)
    .description({
      zh: '监听端口（保存后重载生效）',
      en: 'Listen port (reloads plugin on save)',
    }),

  endpointPath: z.string()
    .pattern(/^\/[A-Za-z0-9/_-]*$/)
    .default('/mcp')
    .description({
      zh: 'MCP Streamable HTTP 路径（默认 /mcp，保存后重载生效）',
      en: 'MCP Streamable HTTP path (default /mcp; reloads plugin on save)',
    }),

  auth: z.object({
    credentialRef: z.const(CREDENTIAL_REF)
      .default(CREDENTIAL_REF)
      .role('credential-ref')
      .description({
        zh: 'DSH 凭据名（固定）',
        en: 'DSH credential reference (fixed)',
      }),
    token: SecretSentinel.description({
      zh: '访问密钥（Authorization: Bearer <密钥>，存储在 DSH 凭据库，不会明文写入配置文件）',
      en: 'Access token (Authorization: Bearer <token>, stored in DSH credential store)',
    }),
  }).volatile().description({
    zh: '访问鉴权（单密钥走 DSH 凭据库）',
    en: 'Authentication (single bearer token in DSH credential store)',
  }),

  allowedCidrs: z.array(z.string())
    .default([...DEFAULT_ALLOWED_CIDRS])
    .volatile()
    .description({
      zh: '允许访问的来源网段（CIDR 列表，如 192.168.0.0/16、100.64.0.0/10、127.0.0.1/32；留空则拒绝全部）',
      en: 'Allowed client CIDR ranges (e.g. 192.168.0.0/16, 100.64.0.0/10, 127.0.0.1/32; empty denies all)',
    }),

  tools: z.object({
    screen: z.boolean()
      .default(true)
      .description({
        zh: '核心屏幕交互（screen / collect / tap / type / scroll / key / tap_xy / handoff）',
        en: 'Core screen interaction (screen, collect, tap, type, scroll, key, tap_xy, handoff)',
      }),
    apps: z.boolean()
      .default(true)
      .description({
        zh: '应用与系统意图（apps / open / intent：闹钟、日历写入、拨号、分享、导航、设置页）',
        en: 'Apps and system intents (apps, open, intent)',
      }),
    notify: z.boolean()
      .default(true)
      .description({
        zh: '发送手机通知（notify）',
        en: 'Post phone notification (notify)',
      }),
    clipboard: z.boolean()
      .default(true)
      .description({
        zh: '读写手机剪贴板（clipboard）',
        en: 'Read/write phone clipboard (clipboard)',
      }),
    calendar: z.boolean()
      .default(true)
      .description({
        zh: '读取手机日历日程（calendar_list）',
        en: 'Read phone calendar events (calendar_list)',
      }),
    androidShell: z.boolean()
      .default(false)
      .description({
        zh: 'Android Shell 命令（android_shell，默认关闭；需手机已开 Shizuku/ADB 且仍受手机逐条确认）',
        en: 'Android Shell command (android_shell, off by default; still requires Shizuku/ADB and per-command approval)',
      }),
    diagnostics: z.boolean()
      .default(false)
      .description({
        zh: 'dsh-Go 故障诊断报告（diagnostics，默认关闭；仅排障时按需开启）',
        en: 'dsh-Go diagnostics report (diagnostics, off by default; enable only for troubleshooting)',
      }),
    chat: z.boolean()
      .default(true)
      .description({
        zh: '与手机上的 dsh 对话（ask_dsh）：把消息发给手机里的 dsh，等这一轮跑完并回传答复',
        en: 'Talk to the phone\'s own dsh (ask_dsh): send a message, wait for the turn, return the reply',
      }),
    allowUnknownTools: z.boolean()
      .default(false)
      .description({
        zh: '放行未来上游新增的未分类工具（默认关闭，保守拒绝未知工具）',
        en: 'Allow unknown future upstream tools (off by default, fail-closed)',
      }),
    disabledTools: z.array(z.string())
      .default([])
      .description({
        zh: '额外屏蔽的单个工具名（精确匹配，优先级高于上方分组开关，如 tap_xy、intent）',
        en: 'Extra individual tool names to block (exact match, overrides group switches)',
      }),
  }).volatile().description({
    zh: '对外暴露的工具开关（全部即改即生效）',
    en: 'Exposed tool switches (all take effect immediately)',
  }),

  session: z.object({
    idleTimeoutSec: z.number()
      .min(30)
      .max(3600)
      .step(1)
      .default(300)
      .description({
        zh: '会话空闲超时（秒）：超时自动向手机发 phone-run-end 释放后台虚拟屏与任务租约',
        en: 'Session idle timeout (seconds): sends phone-run-end automatically to release phone leases',
      }),
    maxSessions: z.number()
      .min(1)
      .max(16)
      .step(1)
      .default(4)
      .description({
        zh: '最大并发外部 MCP 会话数',
        en: 'Maximum concurrent external MCP sessions',
      }),
    heartbeatIntervalSec: z.number()
      .min(5)
      .max(120)
      .step(1)
      .default(15)
      .description({
        zh: 'SSE 心跳间隔（秒）：防止 handoff 或弹窗确认等待期间客户端超时断连',
        en: 'SSE keepalive interval (seconds) to avoid client timeouts during confirmation or handoff waits',
      }),
  }).volatile().collapse().description({
    zh: '会话与超时设置（高级）',
    en: 'Session & timeout settings (advanced)',
  }),

  chat: z.object({
    sessionId: z.string()
      .default('')
      .description({
        zh: '对话固定使用的 dsh 会话 id（留空则由插件自动新建一个专用会话并复用）',
        en: 'dsh session id to talk to (empty: the plugin creates and reuses its own session)',
      }),
    timeoutSec: z.number()
      .min(30)
      .max(3600)
      .step(1)
      .default(300)
      .description({
        zh: '单次对话最长等待（秒），超时返回已产生的部分答复',
        en: 'Longest wait per ask_dsh call (seconds); on timeout the partial reply is returned',
      }),
    allowNewSession: z.boolean()
      .default(true)
      .description({
        zh: '允许自动新建会话（关闭后必须在上方填好会话 id）',
        en: 'Allow creating a session automatically (when off, sessionId must be set)',
      }),
  }).volatile().collapse().description({
    zh: '对话工具（ask_dsh）设置',
    en: 'Chat tool (ask_dsh) settings',
  }),

  bridgeConfigPath: z.string()
    .default(DEFAULT_BRIDGE_CONFIG_PATH)
    .collapse()
    .description({
      zh: 'Android PhoneBridge 配置文件路径（默认即可，自动兼容 PRoot 与 Direct 模式）',
      en: 'Android PhoneBridge config path (default works in both PRoot and Direct modes)',
    }),
})

/**
 * Unwrap a Cordis volatile handle (`{ get() }`) or return plain value directly.
 *
 * @template T
 * @param {T | { get: () => T }} value
 * @returns {T}
 */
export function unwrapVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return /** @type {T} */ (value)
}

/**
 * Normalize an endpoint path to always start with `/` and strip trailing slash (except root `/`).
 *
 * @param {string | undefined} raw
 * @returns {string}
 */
export function normalizeEndpointPath(raw) {
  if (typeof raw !== 'string') return '/mcp'
  const trimmed = raw.trim()
  if (!trimmed) return '/mcp'
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash
}

/**
 * Produce a clean, immutable runtime snapshot from live Cordis config (handling volatile handles).
 *
 * @param {any} config
 */
export function readRuntimeConfig(config) {
  const enabled = Boolean(unwrapVolatile(config?.enabled) ?? true)
  const bindHost = String(unwrapVolatile(config?.bindHost) || '0.0.0.0').trim() || '0.0.0.0'
  const rawPort = Number(unwrapVolatile(config?.port) ?? 3847)
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 3847
  const endpointPath = normalizeEndpointPath(unwrapVolatile(config?.endpointPath))
  const authRaw = unwrapVolatile(config?.auth) || {}
  const credentialRef = typeof authRaw.credentialRef === 'string' && authRaw.credentialRef
    ? authRaw.credentialRef
    : CREDENTIAL_REF

  const cidrsRaw = unwrapVolatile(config?.allowedCidrs)
  const allowedCidrs = Array.isArray(cidrsRaw)
    ? cidrsRaw.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [...DEFAULT_ALLOWED_CIDRS]
  const compiledCidrs = compileCidrs(allowedCidrs)

  const toolsRaw = unwrapVolatile(config?.tools) || {}
  const tools = Object.freeze({
    screen: toolsRaw.screen !== false,
    apps: toolsRaw.apps !== false,
    notify: toolsRaw.notify !== false,
    clipboard: toolsRaw.clipboard !== false,
    calendar: toolsRaw.calendar !== false,
    androidShell: toolsRaw.androidShell === true,
    diagnostics: toolsRaw.diagnostics === true,
    chat: toolsRaw.chat !== false,
    allowUnknownTools: toolsRaw.allowUnknownTools === true,
    disabledTools: Object.freeze(
      Array.isArray(toolsRaw.disabledTools)
        ? toolsRaw.disabledTools.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : [],
    ),
  })

  const sessionRaw = unwrapVolatile(config?.session) || {}
  const clampInt = (v, min, max, fallback) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  const session = Object.freeze({
    idleTimeoutMs: clampInt(sessionRaw.idleTimeoutSec, 30, 3600, 300) * 1000,
    maxSessions: clampInt(sessionRaw.maxSessions, 1, 16, 4),
    heartbeatIntervalMs: clampInt(sessionRaw.heartbeatIntervalSec, 5, 120, 15) * 1000,
  })

  const bridgeConfigPath = String(unwrapVolatile(config?.bridgeConfigPath) || DEFAULT_BRIDGE_CONFIG_PATH).trim()
    || DEFAULT_BRIDGE_CONFIG_PATH

  const chatRaw = unwrapVolatile(config?.chat) || {}
  const chat = Object.freeze({
    sessionId: typeof chatRaw.sessionId === 'string' ? chatRaw.sessionId.trim() : '',
    timeoutMs: clampInt(chatRaw.timeoutSec, 30, 3600, 300) * 1000,
    allowNewSession: chatRaw.allowNewSession !== false,
  })

  return Object.freeze({
    enabled,
    bindHost,
    port,
    endpointPath,
    credentialRef,
    allowedCidrs: Object.freeze(allowedCidrs),
    cidrRules: compiledCidrs.rules,
    invalidCidrs: compiledCidrs.invalid,
    tools,
    session,
    chat,
    bridgeConfigPath,
  })
}
