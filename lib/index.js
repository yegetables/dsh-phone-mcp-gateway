import { readFileSync } from 'node:fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { PhoneBridgeClient } from './bridge-client.js'
import { Config, CREDENTIAL_REF, readRuntimeConfig } from './config.js'
import { credentialValue } from './credentials.js'
import { createDshChat, supportsChat } from './dsh-chat.js'
import { McpHttpGateway } from './mcp-http.js'
import { formatSlashCommandOutput } from './status.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const name = 'phone-mcp-gateway'
export const inject = ['credentials']
export { Config }

/**
 * Cordis 插件入口。
 *
 * Cordis 要求 async 的 apply 回调 resolve 成 void：返回对象会被当成非法 effect
 * （`TypeError: Invalid effect`），返回函数才会被当作 dispose。所以这里只转发，
 * 不把运行句柄交出去；需要句柄的调用方（测试、调试）直接用 {@link start}。
 *
 * @param {any} ctx
 * @param {any} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  await start(ctx, config)
}

/**
 * 真正的初始化逻辑，返回网关与桥接的运行句柄（仅供测试/调试；Cordis 不经过这里）。
 *
 * @param {any} ctx
 * @param {any} config
 */
export async function start(ctx, config) {
  const logger = ctx.logger || console
  let closed = false

  /** @type {{ loaded: boolean, value: string | null }} */
  let tokenCache = { loaded: false, value: null }

  const getRuntimeConfig = () => readRuntimeConfig(config)

  async function resolveToken(force = false) {
    if (!force && tokenCache.loaded) return tokenCache.value
    const refName = getRuntimeConfig().credentialRef || CREDENTIAL_REF
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(refName))
      const value = credentialValue(resolved)
      tokenCache = { loaded: true, value }
      return value
    } catch (error) {
      logger?.warn?.(`[phone-mcp-gateway] failed to resolve credential ${refName}: ${error?.message || error}`)
      tokenCache = { loaded: true, value: null }
      return null
    }
  }

  async function describeToken() {
    const refName = getRuntimeConfig().credentialRef || CREDENTIAL_REF
    try {
      const info = await ctx.credentials.describe(credentialRef(refName))
      return {
        configured: Boolean(info?.configured),
        masked: info?.masked,
        source: info?.source,
      }
    } catch {
      const val = await resolveToken()
      return { configured: Boolean(val) }
    }
  }

  const bridge = new PhoneBridgeClient({
    configPath: () => getRuntimeConfig().bridgeConfigPath,
    logger,
  })

  /** dsh 的会话服务；宿主没有它（或版本太旧）时 ask_dsh 不会出现在工具表里。 */
  let sessionController = null

  const chat = createDshChat({
    getSessionController: () => sessionController,
    getSettings: () => getRuntimeConfig().chat,
    logger,
  })

  /** 插件自己实现的对话工具：不点屏幕、不弹确认，直接和手机上的 dsh 说话。 */
  const askDshTool = {
    name: 'ask_dsh',
    description:
      '和这台手机上的 dsh 对话：发一条消息，等它跑完这一轮，把答复返回。它与手机操控工具是两条通道，不模拟点屏幕、不触发确认弹窗。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', description: '发给手机上的 dsh 的话' },
        session: { type: 'string', description: '可选的 dsh 会话 id；省略则使用插件自己的专用会话' },
        timeout_sec: { type: 'integer', description: '本次最长等待秒数（默认取插件设置）' },
      },
      required: ['message'],
    },
    async handler(args, { signal }) {
      const result = await chat.ask({
        message: args?.message,
        sessionId: args?.session,
        timeoutMs: Number.isInteger(args?.timeout_sec) ? Math.max(1, args.timeout_sec) * 1000 : undefined,
        signal,
      })
      const header = result.timedOut
        ? `[${result.sessionId}] 等待超时，以下是这一轮已产生的部分答复`
        : `[${result.sessionId}]`
      return {
        text: `${header}\n\n${result.reply || '（这一轮没有产生文本答复）'}`,
        isError: false,
      }
    },
  }

  const gateway = new McpHttpGateway({
    bridge,
    getRuntimeConfig,
    getExpectedToken: () => resolveToken(false),
    getLocalTools: () => (supportsChat(sessionController) ? [askDshTool] : []),
    serverVersion: pkg.version || '0.1.0',
    logger,
  })

  /** Serializes volatile start/stop transitions to prevent overlapping listen/close calls. */
  let lifecycleQueue = Promise.resolve()
  function syncListenerState() {
    lifecycleQueue = lifecycleQueue.then(async () => {
      if (closed) return
      const snapshot = getRuntimeConfig()
      if (snapshot.enabled && !gateway.listening) {
        try {
          await gateway.start({ bindHost: snapshot.bindHost, port: snapshot.port })
          const addr = gateway.listenAddress
          logger?.info?.(
            `[phone-mcp-gateway] listening on http://${addr?.host ?? snapshot.bindHost}:${addr?.port ?? snapshot.port}${snapshot.endpointPath}`,
          )
        } catch (error) {
          logger?.warn?.(`[phone-mcp-gateway] failed to start HTTP listener: ${error?.message || error}`)
        }
      } else if (!snapshot.enabled && gateway.listening) {
        await gateway.stop()
        logger?.info?.('[phone-mcp-gateway] stopped HTTP listener (disabled in settings)')
      }
    }).catch((error) => {
      logger?.warn?.(`[phone-mcp-gateway] lifecycle sync failed: ${error?.message || error}`)
    })
    return lifecycleQueue
  }

  // Listen to credential updates from DSH credential store (immediate effect, no restart needed).
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/reference-updated', (ref) => {
      const target = getRuntimeConfig().credentialRef || CREDENTIAL_REF
      if (String(ref) === target) {
        tokenCache = { loaded: false, value: null }
        void resolveToken(true)
      }
    })

    // Listen to Cordis volatile config updates.
    ctx.on('loader/volatile-update', (paths) => {
      if (!Array.isArray(paths)) return
      const roots = new Set(paths.map((p) => (Array.isArray(p) ? p[0] : undefined)))
      if (roots.has('enabled')) {
        void syncListenerState()
      }
      if (roots.has('auth')) {
        tokenCache = { loaded: false, value: null }
        void resolveToken(true)
      }
      if (roots.has('tools')) {
        gateway.notifyToolsChanged()
      }
    })
  }

  // Register lightweight `/phone-mcp` slash command when `commands` service is available.
  const registerCommand = (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'phone-mcp',
      description: '查看手机 MCP 外部网关状态、连接地址与客户端配置',
      input: {
        hint: '可选：status（默认）| config | sessions',
      },
      async handler(invocation) {
        const snapshot = getRuntimeConfig()
        const credentialInfo = await describeToken()
        const text = formatSlashCommandOutput({
          subcommand: invocation?.rawInput || '',
          runtimeConfig: snapshot,
          listening: gateway.listening,
          listenAddress: gateway.listenAddress,
          listenError: gateway.listenError,
          credentialInfo,
          bridgeProbe: bridge.probeConfig(),
          sessions: gateway.listSessions(),
          chatAvailable: supportsChat(sessionController),
        })
        return { kind: 'success', text }
      },
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], registerCommand)

    // 会话服务是可选依赖：宿主没有它时插件照常提供手机操控，只是没有 ask_dsh。
    ctx.inject(['sessionController'], (chatCtx) => {
      sessionController = chatCtx.sessionController ?? null
      if (sessionController) {
        logger?.info?.('[phone-mcp-gateway] ask_dsh 已启用（与手机上的 dsh 对话）')
        gateway.notifyToolsChanged()
      }
    })
  } else if (ctx.commands) {
    registerCommand(ctx)
  }

  // Cleanup on plugin dispose / reload.
  async function dispose() {
    if (closed) return
    closed = true
    await lifecycleQueue
    await gateway.stop()
    bridge.close()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose)
  }

  // Initial token preload + HTTP listener start (if enabled).
  await resolveToken(true)
  await syncListenerState()

  return {
    gateway,
    bridge,
    dispose,
    syncListenerState,
  }
}
