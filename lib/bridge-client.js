import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const DIRECT_SYMBOL = Symbol.for('dsh.go.direct')
const CONNECT_TIMEOUT_MS = 3_000
const DEFAULT_CALL_TIMEOUT_MS = 650_000
const MAX_OUTBOUND_LINE_BYTES = 4 * 1024 * 1024
const MAX_INBOUND_LINE_BYTES = 32 * 1024 * 1024

export class BridgeUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'BridgeUnavailableError'
    this.code = options.code || 'BRIDGE_UNAVAILABLE'
  }
}

/**
 * Resolve `/var/lib/dsh-app/phone/bridge.json` across PRoot and Android Direct launch modes.
 *
 * @param {string} configPath
 * @returns {string}
 */
export function resolveBridgeConfigPath(configPath) {
  const direct = globalThis[DIRECT_SYMBOL]
  if (direct && typeof direct.toHost === 'function') {
    try {
      const mapped = direct.toHost(configPath)
      if (typeof mapped === 'string' && mapped) return mapped
    } catch {
      // Fall through to filesystem probing.
    }
  }

  if (existsSync(configPath)) return configPath

  const rootfs = process.env.DSH_GO_DIRECT_ROOTFS || process.env.DSH_GO_RUNTIME_ROOT
  if (rootfs && configPath.startsWith('/')) {
    const candidate = path.join(rootfs, configPath)
    if (existsSync(candidate)) return candidate
  }

  return configPath
}

/**
 * Read and validate `bridge.json`.
 *
 * @param {string} configPath
 * @returns {{ v: number, abstract: string | null, tcpPort: number | null, token: string, fingerprint: string }}
 */
export function readBridgeConfig(configPath) {
  const resolvedPath = resolveBridgeConfigPath(configPath)
  let raw
  try {
    raw = readFileSync(resolvedPath, 'utf8')
  } catch (error) {
    throw new BridgeUnavailableError(
      `无法读取 Android PhoneBridge 配置（${resolvedPath}）：${error?.code || error?.message || error}`,
      { code: 'BRIDGE_CONFIG_MISSING', cause: error },
    )
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new BridgeUnavailableError(
      `Android PhoneBridge 配置文件 JSON 格式无效（${resolvedPath}）`,
      { code: 'BRIDGE_CONFIG_INVALID', cause: error },
    )
  }

  const abstractName = typeof parsed?.abstract === 'string' && parsed.abstract ? parsed.abstract : null
  const tcpPort = Number.isInteger(parsed?.tcpPort) && parsed.tcpPort > 0 && parsed.tcpPort <= 65535
    ? parsed.tcpPort
    : null
  const token = typeof parsed?.token === 'string' ? parsed.token : ''

  if (!abstractName && !tcpPort) {
    throw new BridgeUnavailableError('Android PhoneBridge 配置中既无 abstract socket 也无 tcpPort', {
      code: 'BRIDGE_ENDPOINT_EMPTY',
    })
  }
  if (!token) {
    throw new BridgeUnavailableError('Android PhoneBridge 配置缺少 token', {
      code: 'BRIDGE_TOKEN_MISSING',
    })
  }

  return {
    v: Number(parsed?.v || 1),
    abstract: abstractName,
    tcpPort,
    token,
    fingerprint: `${abstractName ?? ''}|${tcpPort ?? ''}|${token}`,
  }
}

/**
 * Connect to Android PhoneBridge using abstract unix socket first, then loopback TCP fallback.
 * Sends the mandatory first-line hello handshake.
 *
 * @param {ReturnType<typeof readBridgeConfig>} cfg
 * @param {number} connectTimeoutMs
 * @returns {Promise<{ socket: net.Socket, transport: string }>}
 */
function openBridgeSocket(cfg, connectTimeoutMs) {
  /** @type {Array<{ options: net.NetConnectOpts, transport: string }>} */
  const targets = []
  if (cfg.abstract) {
    targets.push({ options: { path: `\0${cfg.abstract}` }, transport: `unix:@${cfg.abstract}` })
  }
  if (cfg.tcpPort) {
    targets.push({ options: { host: '127.0.0.1', port: cfg.tcpPort }, transport: `tcp:127.0.0.1:${cfg.tcpPort}` })
  }

  const errors = []

  return new Promise((resolve, reject) => {
    const attempt = (index) => {
      if (index >= targets.length) {
        reject(new BridgeUnavailableError(
          `无法连接 Android PhoneBridge（${errors.join('; ') || '无可用通道'}）`,
          { code: 'BRIDGE_CONNECT_FAILED' },
        ))
        return
      }

      const target = targets[index]
      const socket = net.connect(target.options)
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        errors.push(`${target.transport}: connect timeout`)
        socket.destroy()
        attempt(index + 1)
      }, connectTimeoutMs)

      socket.once('connect', () => {
        if (settled) {
          socket.destroy()
          return
        }
        settled = true
        clearTimeout(timer)
        if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
        const hello = `${JSON.stringify({ dshPhone: 1, token: cfg.token })}\n`
        socket.write(hello)
        resolve({ socket, transport: target.transport })
      })

      socket.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        errors.push(`${target.transport}: ${err?.code || err?.message || err}`)
        socket.destroy()
        attempt(index + 1)
      })
    }

    attempt(0)
  })
}

/**
 * Persistent multiplexed JSON-RPC 2.0 client to Android dsh-Go's PhoneBridge.
 * Automatically reconnects if the socket drops or `bridge.json` rotates.
 */
export class PhoneBridgeClient {
  /**
   * @param {{
   *   configPath?: string | (() => string),
   *   connectTimeoutMs?: number,
   *   callTimeoutMs?: number,
   *   logger?: { info?: Function, warn?: Function, debug?: Function },
   * }} [options]
   */
  constructor(options = {}) {
    this._configPath = options.configPath || '/var/lib/dsh-app/phone/bridge.json'
    this._connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this._callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this._logger = options.logger || null

    /** @type {net.Socket | null} */
    this._socket = null
    /** @type {string | null} */
    this._fingerprint = null
    /** @type {string | null} */
    this._transport = null
    /** @type {Promise<void> | null} */
    this._connecting = null
    /** @type {Buffer} */
    this._rxBuffer = Buffer.alloc(0)
    this._nextId = 1
    this._closed = false

    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout, cleanupAbort?: Function }>} */
    this._pending = new Map()
    /** @type {Record<string, unknown> | null} */
    this._upstreamInitializeResult = null
  }

  _getConfigPath() {
    return typeof this._configPath === 'function' ? this._configPath() : this._configPath
  }

  get connected() {
    return Boolean(this._socket && !this._socket.destroyed && this._socket.writable)
  }

  get transport() {
    return this.connected ? this._transport : null
  }

  /**
   * Probe whether `bridge.json` exists and is readable without forcing a socket reconnect.
   */
  probeConfig() {
    try {
      const cfg = readBridgeConfig(this._getConfigPath())
      return {
        available: true,
        hasAbstract: Boolean(cfg.abstract),
        tcpPort: cfg.tcpPort,
        connected: this.connected,
        transport: this.transport,
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
        connected: this.connected,
        transport: this.transport,
      }
    }
  }

  /**
   * Ensure a live authenticated socket matching the latest `bridge.json`.
   */
  async ensureConnected() {
    if (this._closed) {
      throw new BridgeUnavailableError('PhoneBridge 客户端已关闭', { code: 'BRIDGE_CLOSED' })
    }

    const latestCfg = readBridgeConfig(this._getConfigPath())
    if (this.connected && this._fingerprint === latestCfg.fingerprint) {
      return
    }

    // If bridge.json rotated (engine restart or TCP fallback added), drop stale socket.
    if (this._socket && this._fingerprint !== latestCfg.fingerprint) {
      this._dropSocket(new BridgeUnavailableError('Android PhoneBridge 已重启，正在重连', { code: 'BRIDGE_ROTATED' }))
    }

    if (this._connecting) {
      await this._connecting
      if (this.connected && this._fingerprint === latestCfg.fingerprint) return
    }

    this._connecting = this._connectWithConfig(latestCfg)
    try {
      await this._connecting
    } finally {
      this._connecting = null
    }
  }

  /**
   * @param {ReturnType<typeof readBridgeConfig>} cfg
   */
  async _connectWithConfig(cfg) {
    const { socket, transport } = await openBridgeSocket(cfg, this._connectTimeoutMs)
    if (this._closed) {
      socket.destroy()
      throw new BridgeUnavailableError('PhoneBridge 客户端已关闭', { code: 'BRIDGE_CLOSED' })
    }

    this._socket = socket
    this._fingerprint = cfg.fingerprint
    this._transport = transport
    this._rxBuffer = Buffer.alloc(0)

    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', (err) => {
      this._dropSocket(new BridgeUnavailableError(
        `Android PhoneBridge 连接错误：${err?.code || err?.message || err}`,
        { code: 'BRIDGE_SOCKET_ERROR', cause: err },
      ))
    })
    socket.on('close', () => {
      if (this._socket === socket) {
        this._dropSocket(new BridgeUnavailableError('Android PhoneBridge 连接已断开', { code: 'BRIDGE_DISCONNECTED' }))
      }
    })

    // Perform an MCP initialize handshake immediately to verify the hello token succeeded.
    try {
      const initResult = await this._sendRawRequest(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'dsh-phone-mcp-gateway', version: '0.1.0' },
        },
        { timeoutMs: this._connectTimeoutMs },
      )
      this._upstreamInitializeResult = initResult
    } catch (error) {
      this._dropSocket(error instanceof Error ? error : new Error(String(error)))
      throw new BridgeUnavailableError(
        `Android PhoneBridge 握手失败（可能是 bridge token 已过期或手机操控未就绪）：${error?.message || error}`,
        { code: 'BRIDGE_HANDSHAKE_FAILED', cause: error },
      )
    }
  }

  /**
   * @param {Buffer} chunk
   */
  _onData(chunk) {
    this._rxBuffer = this._rxBuffer.length === 0 ? chunk : Buffer.concat([this._rxBuffer, chunk])

    while (true) {
      const nl = this._rxBuffer.indexOf(0x0a)
      if (nl === -1) {
        if (this._rxBuffer.length > MAX_INBOUND_LINE_BYTES) {
          this._dropSocket(new BridgeUnavailableError('PhoneBridge 响应行超过最大限制', { code: 'BRIDGE_LINE_TOO_LONG' }))
        }
        return
      }

      if (nl > MAX_INBOUND_LINE_BYTES) {
        this._dropSocket(new BridgeUnavailableError('PhoneBridge 响应行超过最大限制', { code: 'BRIDGE_LINE_TOO_LONG' }))
        return
      }

      const line = this._rxBuffer.subarray(0, nl).toString('utf8').replace(/\r$/, '')
      this._rxBuffer = this._rxBuffer.subarray(nl + 1)
      if (!line.trim()) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this._logger?.warn?.('[phone-mcp-gateway] ignored malformed JSON line from PhoneBridge')
        continue
      }

      if (msg && typeof msg === 'object' && Object.hasOwn(msg, 'id') && typeof msg.id === 'number') {
        const entry = this._pending.get(msg.id)
        if (!entry) continue
        this._pending.delete(msg.id)
        clearTimeout(entry.timer)
        entry.cleanupAbort?.()

        if (msg.error) {
          const rpcError = new Error(String(msg.error.message || 'PhoneBridge JSON-RPC error'))
          rpcError.rpcCode = typeof msg.error.code === 'number' ? msg.error.code : -32603
          rpcError.rpcData = msg.error.data
          entry.reject(rpcError)
        } else {
          entry.resolve(msg.result)
        }
      }
    }
  }

  /**
   * @param {Error} reason
   */
  _dropSocket(reason) {
    const sock = this._socket
    this._socket = null
    this._fingerprint = null
    this._transport = null
    this._rxBuffer = Buffer.alloc(0)

    if (sock && !sock.destroyed) {
      sock.removeAllListeners()
      sock.destroy()
    }

    for (const [id, entry] of this._pending.entries()) {
      this._pending.delete(id)
      clearTimeout(entry.timer)
      entry.cleanupAbort?.()
      entry.reject(reason)
    }
  }

  /**
   * Send a JSON-RPC request over the current connected socket.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<any>}
   */
  _sendRawRequest(method, params, options = {}) {
    const socket = this._socket
    if (!socket || socket.destroyed || !socket.writable) {
      return Promise.reject(new BridgeUnavailableError('Android PhoneBridge 未连接', { code: 'BRIDGE_NOT_CONNECTED' }))
    }

    if (options.signal?.aborted) {
      return Promise.reject(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
    }

    const id = this._nextId++
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    })

    if (Buffer.byteLength(payload, 'utf8') > MAX_OUTBOUND_LINE_BYTES) {
      return Promise.reject(Object.assign(new Error('请求体超过 PhoneBridge 4 MiB 单行上限'), { rpcCode: -32602 }))
    }

    const timeoutMs = options.timeoutMs ?? this._callTimeoutMs

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.delete(id)) return
        cleanupAbort?.()
        reject(new BridgeUnavailableError(`PhoneBridge 调用 ${method} 超时（${timeoutMs}ms）`, { code: 'BRIDGE_TIMEOUT' }))
      }, timeoutMs)

      let cleanupAbort
      if (options.signal) {
        const onAbort = () => {
          if (!this._pending.delete(id)) return
          clearTimeout(timer)
          reject(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        cleanupAbort = () => options.signal.removeEventListener('abort', onAbort)
      }

      this._pending.set(id, { resolve, reject, timer, cleanupAbort })
      socket.write(`${payload}\n`, (err) => {
        if (!err) return
        if (!this._pending.delete(id)) return
        clearTimeout(timer)
        cleanupAbort?.()
        reject(new BridgeUnavailableError(`写入 PhoneBridge 失败：${err.message}`, { code: 'BRIDGE_WRITE_FAILED', cause: err }))
      })
    })
  }

  /**
   * Send a JSON-RPC request, ensuring connection and retrying once if a stale idle socket dropped.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number, signal?: AbortSignal, allowRetryOnDisconnect?: boolean }} [options]
   */
  async request(method, params, options = {}) {
    await this.ensureConnected()
    try {
      return await this._sendRawRequest(method, params, options)
    } catch (error) {
      const canRetry = options.allowRetryOnDisconnect === true
        && error instanceof BridgeUnavailableError
        && (error.code === 'BRIDGE_DISCONNECTED' || error.code === 'BRIDGE_WRITE_FAILED' || error.code === 'BRIDGE_ROTATED')
        && !options.signal?.aborted
      if (!canRetry) throw error

      await this.ensureConnected()
      return await this._sendRawRequest(method, params, options)
    }
  }

  /**
   * Fetch native tools list from PhoneBridge.
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ tools: Array<Record<string, unknown>> }>}
   */
  async listTools(options = {}) {
    const result = await this.request('tools/list', {}, {
      timeoutMs: 15_000,
      signal: options.signal,
      allowRetryOnDisconnect: true,
    })
    return {
      tools: Array.isArray(result?.tools) ? result.tools : [],
    }
  }

  /**
   * Execute a native phone tool with synthesized PhoneCaller metadata.
   * Never auto-retries a tool call to avoid duplicate physical taps/actions.
   *
   * @param {{
   *   name: string,
   *   arguments?: Record<string, unknown>,
   *   caller: { sessionId: string, runId: string, callId: string, runLifecycle: 0 | 1 },
   *   signal?: AbortSignal,
   * }} call
   */
  async callTool(call) {
    return await this.request(
      'tools/call',
      {
        name: call.name,
        arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
        _meta: {
          'dsh-go/phone-caller': {
            v: 1,
            sessionId: call.caller.sessionId,
            runId: call.caller.runId,
            callId: call.caller.callId,
            runLifecycle: call.caller.runLifecycle,
          },
        },
      },
      {
        timeoutMs: this._callTimeoutMs,
        signal: call.signal,
        allowRetryOnDisconnect: false,
      },
    )
  }

  /**
   * Notify PhoneBridge that an external caller run has ended so virtual displays & leases release immediately.
   *
   * @param {{ sessionId: string, runId: string, completion?: 'completed' | 'other' | 'unknown' }} params
   */
  async endRun(params) {
    try {
      await this.request(
        'dsh-go/phone-run-end',
        {
          v: 1,
          sessionId: params.sessionId,
          runId: params.runId,
          completion: params.completion || 'completed',
        },
        {
          timeoutMs: 10_000,
          allowRetryOnDisconnect: true,
        },
      )
      return true
    } catch (error) {
      this._logger?.warn?.(`[phone-mcp-gateway] phone-run-end failed for ${params.sessionId}: ${error?.message || error}`)
      return false
    }
  }

  close() {
    this._closed = true
    this._dropSocket(new BridgeUnavailableError('PhoneBridge 客户端已关闭', { code: 'BRIDGE_CLOSED' }))
  }
}
