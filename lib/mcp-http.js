import crypto from 'node:crypto'
import http from 'node:http'
import { isIpAllowed, normalizeIp } from './cidr.js'
import { BridgeUnavailableError } from './bridge-client.js'
import { filterTools, isToolAllowed } from './tools-policy.js'

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
])
export const LATEST_PROTOCOL_VERSION = '2025-11-25'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const IDLE_SWEEP_INTERVAL_MS = 10_000
const GATEWAY_SERVER_NAME = 'dsh-phone-mcp-gateway'

/**
 * Constant-time token comparison using SHA-256 digests so token length is never leaked.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function verifyBearerToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  if (!provided || !expected) return false
  const digestA = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const digestB = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(digestA, digestB)
}

/**
 * Extract bearer token from an HTTP Authorization header.
 *
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
export function extractBearerToken(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  return token || null
}

/**
 * Sanitize client name + IP into a valid, compact PhoneCaller.sessionId
 * (McpServer.kt requires 1..256 chars with no ASCII control characters).
 *
 * @param {string | undefined | null} clientName
 * @param {string} remoteIp
 * @param {Set<string>} existingIds
 * @returns {string}
 */
export function buildCallerSessionId(clientName, remoteIp, existingIds) {
  const clean = (value, maxLen) => {
    if (typeof value !== 'string') return ''
    let out = ''
    for (const ch of value) {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) continue
      if (ch === '[' || ch === ']') continue
      out += ch
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, maxLen)
  }

  const namePart = clean(clientName, 32) || 'mcp'
  const ipPart = clean(remoteIp, 45) || 'unknown'
  const base = `${namePart}@${ipPart}`.slice(0, 80)

  if (!existingIds.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base} #${suffix}`.slice(0, 96)
    if (!existingIds.has(candidate)) return candidate
  }
  return `${base} #${crypto.randomBytes(3).toString('hex')}`.slice(0, 96)
}

/**
 * Guard against browser DNS-rebinding / cross-site requests when an Origin header is sent.
 * Non-browser CLI/Agent clients omit Origin and pass directly to CIDR + Bearer auth.
 *
 * @param {http.IncomingMessage} req
 * @param {ReturnType<import('./cidr.js').compileCidrs>['rules']} cidrRules
 * @returns {boolean}
 */
function isOriginAllowed(req, cidrRules) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || !origin.trim()) return false
  if (origin === 'null') return false

  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const originHost = parsed.hostname.toLowerCase()
  if (originHost === 'localhost') return true
  if (isIpAllowed(originHost, cidrRules)) return true

  const reqHostHeader = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (reqHostHeader) {
    try {
      const reqHost = new URL(`http://${reqHostHeader}`).hostname.toLowerCase()
      if (reqHost && reqHost === originHost) return true
    } catch {
      // Ignore malformed Host header.
    }
  }
  return false
}

/**
 * Read HTTP request body up to a strict byte limit.
 *
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false

    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        done = true
        req.pause()
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })

    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })

    req.on('aborted', () => {
      if (done) return
      done = true
      reject(Object.assign(new Error('Request aborted'), { code: 'ECONNRESET' }))
    })
  })
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  }
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function acceptsSse(req) {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream')
}

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}

function newRunId() {
  return `run-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function newCallId() {
  return `call-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/**
 * Standard MCP Streamable HTTP gateway sitting in front of Android PhoneBridgeClient.
 */
export class McpHttpGateway {
  /**
   * @param {{
   *   bridge: import('./bridge-client.js').PhoneBridgeClient,
   *   getRuntimeConfig: () => ReturnType<import('./config.js').readRuntimeConfig>,
   *   getExpectedToken: () => Promise<string | null>,
   *   serverVersion?: string,
   *   logger?: { info?: Function, warn?: Function, error?: Function },
   *   idleSweepIntervalMs?: number,
   * }} options
   */
  constructor(options) {
    this._bridge = options.bridge
    this._getRuntimeConfig = options.getRuntimeConfig
    this._getExpectedToken = options.getExpectedToken
    this._getLocalTools = typeof options.getLocalTools === 'function' ? options.getLocalTools : () => []
    this._serverVersion = options.serverVersion || '0.1.0'
    this._logger = options.logger || null
    this._idleSweepIntervalMs = options.idleSweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS

    /** @type {http.Server | null} */
    this._server = null
    /** @type {{ host: string, port: number } | null} */
    this._listenAddress = null
    /** @type {string | null} */
    this._listenError = null
    /** @type {NodeJS.Timeout | null} */
    this._sweepTimer = null

    /**
     * @type {Map<string, {
     *   id: string,
     *   callerSessionId: string,
     *   runId: string,
     *   clientName: string,
     *   remoteIp: string,
     *   protocolVersion: string,
     *   createdAt: number,
     *   lastActivityAt: number,
     *   lastPhoneActivityAt: number,
     *   hasCalledPhone: boolean,
     *   inFlight: Map<string, { controller: AbortController, toolName: string }>,
     *   sseStreams: Set<{ res: http.ServerResponse, heartbeat: NodeJS.Timeout }>,
     * }>}
     */
    this._sessions = new Map()
  }

  get listening() {
    return Boolean(this._server && this._server.listening)
  }

  get listenAddress() {
    return this._listenAddress
  }

  get listenError() {
    return this._listenError
  }

  listSessions() {
    return [...this._sessions.values()].map((s) => ({
      id: s.id,
      callerSessionId: s.callerSessionId,
      clientName: s.clientName,
      remoteIp: s.remoteIp,
      inFlightCount: s.inFlight.size,
      hasCalledPhone: s.hasCalledPhone,
      lastActivityAt: s.lastActivityAt,
    }))
  }

  /**
   * Start listening on configured `bindHost` and `port`.
   *
   * @param {{ bindHost?: string, port?: number }} [override]
   */
  async start(override = {}) {
    if (this._server) return
    const cfg = this._getRuntimeConfig()
    const host = override.bindHost ?? cfg.bindHost
    const port = override.port ?? cfg.port

    const server = http.createServer((req, res) => {
      void this._handleHttpRequest(req, res).catch((err) => {
        this._logger?.warn?.(`[phone-mcp-gateway] unhandled HTTP error: ${err?.message || err}`)
        if (!res.headersSent) {
          sendJson(res, 500, jsonRpcError(null, -32603, 'Internal server error'))
        } else if (!res.writableEnded) {
          res.end()
        }
      })
    })

    // Long tool calls (e.g. handoff up to 10 min) must not be killed by Node's default requestTimeout.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    server.keepAliveTimeout = 65_000

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this._listenError = err?.message || String(err)
        reject(err)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.removeListener('error', onError)
        const addr = server.address()
        this._listenError = null
        this._listenAddress = typeof addr === 'object' && addr
          ? { host: addr.address, port: addr.port }
          : { host, port }
        resolve()
      })
    })

    this._server = server
    this._sweepTimer = setInterval(() => {
      void this.sweepIdleSessions()
    }, this._idleSweepIntervalMs)
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref()
  }

  /**
   * Stop listening, close all streams, and release all active phone runs.
   */
  async stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer)
      this._sweepTimer = null
    }

    const sessionIds = [...this._sessions.keys()]
    await Promise.allSettled(sessionIds.map((id) => this._terminateSession(id, 'other')))

    const server = this._server
    this._server = null
    this._listenAddress = null

    if (server) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        if (typeof timer.unref === 'function') timer.unref()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
      })
    }
  }

  /**
   * Push `notifications/tools/list_changed` to all open GET /mcp SSE streams.
   */
  notifyToolsChanged() {
    const line = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`
    for (const session of this._sessions.values()) {
      for (const stream of session.sseStreams) {
        if (!stream.res.writableEnded && !stream.res.destroyed) {
          try {
            stream.res.write(line)
          } catch {
            // Stream cleanup happens on close/error.
          }
        }
      }
    }
  }

  /**
   * Reap sessions that have been idle longer than `session.idleTimeoutMs` with no in-flight calls.
   * Also releases phone task leases (via phone-run-end) for long-lived GET SSE sessions that have
   * not invoked any phone tool within `idleTimeoutMs`, without dropping their MCP session.
   */
  async sweepIdleSessions(now = Date.now()) {
    const cfg = this._getRuntimeConfig()
    const expiredSessions = []
    const idlePhoneLeases = []

    for (const session of this._sessions.values()) {
      if (session.inFlight.size > 0) continue

      const sessionIdle = now - session.lastActivityAt >= cfg.session.idleTimeoutMs
      if (session.sseStreams.size === 0 && sessionIdle) {
        expiredSessions.push(session.id)
      } else if (session.hasCalledPhone && now - session.lastPhoneActivityAt >= cfg.session.idleTimeoutMs) {
        idlePhoneLeases.push(session)
      }
    }

    const tasks = [
      ...expiredSessions.map((id) => this._terminateSession(id, 'completed')),
      ...idlePhoneLeases.map((session) => this._releaseIdlePhoneRun(session)),
    ]
    if (tasks.length > 0) {
      await Promise.allSettled(tasks)
    }
    return expiredSessions.length
  }

  /**
   * Release an idle phone run while keeping the MCP session alive (e.g. open GET /mcp stream).
   *
   * @param {any} session
   */
  async _releaseIdlePhoneRun(session) {
    if (!session.hasCalledPhone || session.inFlight.size > 0) return
    const runIdToEnd = session.runId
    session.runId = newRunId()
    session.hasCalledPhone = false
    await this._bridge.endRun({
      sessionId: session.callerSessionId,
      runId: runIdToEnd,
      completion: 'completed',
    })
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handleHttpRequest(req, res) {
    const cfg = this._getRuntimeConfig()

    // 1. Endpoint path matching
    let pathname
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { error: 'Invalid request URL' })
      return
    }
    if (pathname !== cfg.endpointPath) {
      sendJson(res, 404, { error: 'Not Found' })
      return
    }

    // 2. Method whitelist
    const method = (req.method || 'GET').toUpperCase()
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: 'GET, POST, DELETE' })
      return
    }

    // 3. Enabled check
    if (!cfg.enabled) {
      sendJson(res, 503, jsonRpcError(null, -32000, 'Phone MCP gateway is disabled in plugin settings'))
      return
    }

    // 4. Origin check (DNS rebinding / browser CSRF defense)
    if (!isOriginAllowed(req, cfg.cidrRules)) {
      sendJson(res, 403, { error: 'Forbidden origin' })
      return
    }

    // 5. CIDR allowlist check (fail-closed)
    const remoteIp = normalizeIp(req.socket?.remoteAddress)
    if (!remoteIp || !isIpAllowed(remoteIp, cfg.cidrRules)) {
      sendJson(res, 403, { error: 'Client IP not allowed by CIDR policy' })
      return
    }

    // 6. Bearer token authentication (DSH credential store; fail-closed when unconfigured)
    const expectedToken = await this._getExpectedToken()
    if (!expectedToken) {
      sendJson(
        res,
        503,
        jsonRpcError(
          null,
          -32001,
          `Access token (${cfg.credentialRef}) is not configured in DSH plugin settings`,
        ),
      )
      return
    }

    const providedToken = extractBearerToken(req.headers.authorization)
    if (!providedToken || !verifyBearerToken(providedToken, expectedToken)) {
      sendJson(
        res,
        401,
        jsonRpcError(null, -32002, 'Unauthorized: invalid or missing Bearer token'),
        { 'WWW-Authenticate': 'Bearer realm="dsh-phone-mcp"' },
      )
      return
    }

    // 7. Dispatch by HTTP method
    if (method === 'GET') {
      this._handleGetSse(req, res, cfg)
      return
    }
    if (method === 'DELETE') {
      await this._handleDeleteSession(req, res)
      return
    }
    await this._handlePost(req, res, cfg, remoteIp)
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {ReturnType<import('./config.js').readRuntimeConfig>} cfg
   */
  _handleGetSse(req, res, cfg) {
    if (!acceptsSse(req)) {
      sendJson(res, 406, { error: 'Accept header must include text/event-stream' })
      return
    }

    const sessionId = this._headerSessionId(req)
    if (!sessionId) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Missing Mcp-Session-Id header'))
      return
    }
    const session = this._sessions.get(sessionId)
    if (!session) {
      sendJson(res, 404, jsonRpcError(null, -32004, 'Unknown or expired MCP session'))
      return
    }

    session.lastActivityAt = Date.now()
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': session.id,
      'MCP-Protocol-Version': session.protocolVersion,
    })
    res.write(': connected\n\n')

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      session.lastActivityAt = Date.now()
      try {
        res.write(': keepalive\n\n')
      } catch {
        // Cleanup runs on close.
      }
    }, cfg.session.heartbeatIntervalMs)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    const stream = { res, heartbeat }
    session.sseStreams.add(stream)

    const cleanup = () => {
      clearInterval(heartbeat)
      session.sseStreams.delete(stream)
    }
    res.once('close', cleanup)
    res.once('error', cleanup)
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handleDeleteSession(req, res) {
    const sessionId = this._headerSessionId(req)
    if (!sessionId) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Missing Mcp-Session-Id header'))
      return
    }
    if (!this._sessions.has(sessionId)) {
      sendJson(res, 404, jsonRpcError(null, -32004, 'Unknown or expired MCP session'))
      return
    }
    await this._terminateSession(sessionId, 'completed')
    res.writeHead(200, { 'Cache-Control': 'no-store' })
    res.end()
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {ReturnType<import('./config.js').readRuntimeConfig>} cfg
   * @param {string} remoteIp
   */
  async _handlePost(req, res, cfg, remoteIp) {
    let rawBody
    try {
      rawBody = await readRequestBody(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err?.statusCode === 413) {
        sendJson(res, 413, jsonRpcError(null, -32600, 'Request body exceeds 2 MiB limit'))
      } else {
        sendJson(res, 400, jsonRpcError(null, -32700, 'Failed to read request body'))
      }
      return
    }

    let parsed
    try {
      parsed = JSON.parse(rawBody.toString('utf8'))
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error: invalid JSON'))
      return
    }

    const isBatch = Array.isArray(parsed)
    const messages = isBatch ? parsed : [parsed]
    if (messages.length === 0) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Invalid Request: empty batch'))
      return
    }

    // Handle single `initialize` request (creates a new MCP session).
    if (!isBatch && parsed && typeof parsed === 'object' && parsed.method === 'initialize') {
      await this._handleInitialize(parsed, res, cfg, remoteIp)
      return
    }

    // All non-initialize requests require a valid Mcp-Session-Id.
    const sessionId = this._headerSessionId(req)
    if (!sessionId) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'Missing Mcp-Session-Id header'))
      return
    }
    const session = this._sessions.get(sessionId)
    if (!session) {
      sendJson(res, 404, jsonRpcError(null, -32004, 'Unknown or expired MCP session'))
      return
    }
    session.lastActivityAt = Date.now()

    // Single `tools/call` over SSE when client accepts `text/event-stream` for long-call keepalive.
    if (
      !isBatch
      && parsed
      && typeof parsed === 'object'
      && parsed.method === 'tools/call'
      && Object.hasOwn(parsed, 'id')
      && acceptsSse(req)
    ) {
      await this._handleToolCallSse(parsed, session, res, cfg)
      return
    }

    // Process single or batch JSON-RPC messages and reply with JSON (or 202 if notifications only).
    const responses = []
    for (const msg of messages) {
      const reply = await this._dispatchJsonRpc(msg, session, res)
      if (reply !== null) responses.push(reply)
    }

    if (responses.length === 0) {
      res.writeHead(202, {
        'Mcp-Session-Id': session.id,
        'MCP-Protocol-Version': session.protocolVersion,
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }

    sendJson(res, 200, isBatch ? responses : responses[0], {
      'Mcp-Session-Id': session.id,
      'MCP-Protocol-Version': session.protocolVersion,
    })
  }

  /**
   * @param {any} msg
   * @param {http.ServerResponse} res
   * @param {ReturnType<import('./config.js').readRuntimeConfig>} cfg
   * @param {string} remoteIp
   */
  async _handleInitialize(msg, res, cfg, remoteIp) {
    if (!Object.hasOwn(msg, 'id')) {
      sendJson(res, 400, jsonRpcError(null, -32600, 'initialize request must include an id'))
      return
    }

    // Enforce maxSessions: first reap expired, then evict oldest idle session if full.
    await this.sweepIdleSessions()
    if (this._sessions.size >= cfg.session.maxSessions) {
      let oldestIdle = null
      for (const s of this._sessions.values()) {
        if (s.inFlight.size > 0) continue
        if (!oldestIdle || s.lastActivityAt < oldestIdle.lastActivityAt) {
          oldestIdle = s
        }
      }
      if (oldestIdle) {
        await this._terminateSession(oldestIdle.id, 'completed')
      } else {
        sendJson(
          res,
          503,
          jsonRpcError(msg.id, -32003, `Maximum concurrent MCP sessions (${cfg.session.maxSessions}) reached`),
        )
        return
      }
    }

    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    const protocolVersion = negotiateProtocolVersion(params.protocolVersion)
    const clientName = typeof params.clientInfo?.name === 'string' ? params.clientInfo.name.trim() : ''

    const existingCallerIds = new Set([...this._sessions.values()].map((s) => s.callerSessionId))
    const callerSessionId = buildCallerSessionId(clientName, remoteIp, existingCallerIds)
    const sessionId = crypto.randomUUID()
    const now = Date.now()

    this._sessions.set(sessionId, {
      id: sessionId,
      callerSessionId,
      runId: newRunId(),
      clientName: clientName || 'mcp',
      remoteIp,
      protocolVersion,
      createdAt: now,
      lastActivityAt: now,
      lastPhoneActivityAt: now,
      hasCalledPhone: false,
      inFlight: new Map(),
      sseStreams: new Set(),
    })

    sendJson(
      res,
      200,
      jsonRpcResult(msg.id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: GATEWAY_SERVER_NAME,
          version: this._serverVersion,
        },
      }),
      {
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': protocolVersion,
      },
    )
  }

  /**
   * Stream a `tools/call` response over SSE with periodic keepalive comments and disconnect cancellation.
   *
   * @param {any} msg
   * @param {any} session
   * @param {http.ServerResponse} res
   * @param {ReturnType<import('./config.js').readRuntimeConfig>} cfg
   */
  async _handleToolCallSse(msg, session, res, cfg) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': session.id,
      'MCP-Protocol-Version': session.protocolVersion,
    })

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      session.lastActivityAt = Date.now()
      try {
        res.write(': keepalive\n\n')
      } catch {
        // Disconnect handler takes care of cancellation.
      }
    }, cfg.session.heartbeatIntervalMs)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    try {
      const reply = await this._executeToolCall(msg, session, res)
      clearInterval(heartbeat)
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
        res.end()
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  /**
   * Dispatch a single JSON-RPC 2.0 message within an established MCP session.
   *
   * @param {any} msg
   * @param {any} session
   * @param {http.ServerResponse} res
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async _dispatchJsonRpc(msg, session, res) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonRpcError(null, -32600, 'Invalid Request')
    }

    const hasId = Object.hasOwn(msg, 'id')
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : null

    if (!method) {
      // Ignore client responses; reject malformed objects that have an id without result/error.
      if (hasId && !Object.hasOwn(msg, 'result') && !Object.hasOwn(msg, 'error')) {
        return jsonRpcError(id, -32600, 'Invalid Request')
      }
      return null
    }

    // Notifications (no id)
    if (!hasId) {
      if (method === 'notifications/cancelled') {
        await this._handleCancelledNotification(msg.params, session)
      }
      // `notifications/initialized` and other notifications produce no JSON-RPC response.
      return null
    }

    switch (method) {
      case 'ping':
        return jsonRpcResult(id, {})

      case 'tools/list': {
        const cfg = this._getRuntimeConfig()
        const localTools = this._localTools()
        let upstreamTools = []
        try {
          const upstream = await this._bridge.listTools()
          upstreamTools = Array.isArray(upstream.tools) ? upstream.tools : []
        } catch (err) {
          // 手机 Bridge 暂时不可用时，插件自己的工具（对话等）仍应可用。
          if (localTools.length === 0) return this._mapBridgeError(id, err)
        }
        return jsonRpcResult(id, { tools: filterTools([...upstreamTools, ...localTools], cfg.tools) })
      }

      case 'tools/call':
        return await this._executeToolCall(msg, session, res)

      case 'initialize':
        return jsonRpcError(id, -32600, 'Session already initialized')

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  /**
   * Execute `tools/call` with strict tool policy check, synthesized PhoneCaller, and disconnect cleanup.
   *
   * @param {any} msg
   * @param {any} session
   * @param {http.ServerResponse} res
   */
  async _executeToolCall(msg, session, res) {
    const id = msg.id
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    const toolName = typeof params.name === 'string' ? params.name : ''

    if (!toolName) {
      return jsonRpcError(id, -32602, 'tools/call requires a string tool name')
    }

    const cfg = this._getRuntimeConfig()
    if (!isToolAllowed(toolName, cfg.tools)) {
      return jsonRpcError(
        id,
        -32602,
        `Tool "${toolName}" is disabled by dsh-phone-mcp-gateway settings`,
      )
    }

    const args = params.arguments === undefined ? {} : params.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return jsonRpcError(id, -32602, 'tools/call arguments must be an object')
    }

    const local = this._localTools().find((tool) => tool.name === toolName)
    if (local) return await this._executeLocalToolCall(id, local, args, session, res)

    const requestKey = String(id)
    const controller = new AbortController()
    const runIdAtStart = session.runId
    session.inFlight.set(requestKey, { controller, toolName })
    session.hasCalledPhone = true
    const startedAt = Date.now()
    session.lastActivityAt = startedAt
    session.lastPhoneActivityAt = startedAt

    let clientDisconnected = false
    const onClientClose = () => {
      if (res.writableEnded) return
      clientDisconnected = true
      controller.abort(new Error('Client disconnected'))
      void this._interruptSessionRun(session, runIdAtStart)
    }
    res.once('close', onClientClose)

    try {
      const result = await this._bridge.callTool({
        name: toolName,
        arguments: args,
        caller: {
          sessionId: session.callerSessionId,
          runId: runIdAtStart,
          callId: newCallId(),
          runLifecycle: 1,
        },
        signal: controller.signal,
      })
      const finishedAt = Date.now()
      session.lastActivityAt = finishedAt
      session.lastPhoneActivityAt = finishedAt
      return jsonRpcResult(id, result)
    } catch (err) {
      if (clientDisconnected || controller.signal.aborted) {
        return jsonRpcError(id, -32000, 'Request cancelled')
      }
      return this._mapBridgeError(id, err)
    } finally {
      res.removeListener('close', onClientClose)
      session.inFlight.delete(requestKey)
      const endedAt = Date.now()
      session.lastActivityAt = endedAt
      session.lastPhoneActivityAt = endedAt
    }
  }

  /**
   * 插件自己实现的 MCP 工具（例如和手机上的 dsh 对话），不经过手机 PhoneBridge。
   *
   * @returns {Array<{ name: string, description: string, inputSchema: Record<string, unknown>, handler: Function }>}
   */
  _localTools() {
    try {
      const tools = this._getLocalTools()
      return Array.isArray(tools) ? tools : []
    } catch {
      return []
    }
  }

  /**
   * 执行插件自带工具：不占用手机任务租约，也不发 phone-run-end。
   *
   * @param {any} id
   * @param {any} tool
   * @param {Record<string, unknown>} args
   * @param {any} session
   * @param {http.ServerResponse} res
   */
  async _executeLocalToolCall(id, tool, args, session, res) {
    const requestKey = String(id)
    const controller = new AbortController()
    session.inFlight.set(requestKey, { controller, toolName: tool.name })
    session.lastActivityAt = Date.now()

    let clientDisconnected = false
    const onClientClose = () => {
      if (res.writableEnded) return
      clientDisconnected = true
      controller.abort(new Error('Client disconnected'))
    }
    res.once('close', onClientClose)

    try {
      const result = await tool.handler(args, {
        signal: controller.signal,
        callerSessionId: session.callerSessionId,
        clientName: session.clientName,
        remoteIp: session.remoteIp,
      })
      const text = typeof result === 'string' ? result : result?.text ?? ''
      const isError = Boolean(result && typeof result === 'object' && result.isError)
      return jsonRpcResult(id, { content: [{ type: 'text', text: String(text) }], isError })
    } catch (error) {
      if (clientDisconnected || controller.signal.aborted) {
        return jsonRpcError(id, -32000, 'Request cancelled')
      }
      const code = error?.code === 'INVALID_ARGUMENT' ? -32602 : -32001
      return jsonRpcError(id, code, error?.message || `${tool.name} failed`)
    } finally {
      res.removeListener('close', onClientClose)
      session.inFlight.delete(requestKey)
      session.lastActivityAt = Date.now()
    }
  }

  /**
   * Handle `notifications/cancelled` by aborting matching in-flight call and signaling phone-run-end.
   *
   * @param {any} params
   * @param {any} session
   */
  async _handleCancelledNotification(params, session) {
    const reqId = params && typeof params === 'object' ? params.requestId : undefined
    if (reqId === undefined || reqId === null) return

    const key = String(reqId)
    const active = session.inFlight.get(key)
    if (!active) return

    const runIdToEnd = session.runId
    active.controller.abort(new Error('Cancelled by client notification'))
    await this._interruptSessionRun(session, runIdToEnd)
  }

  /**
   * Interrupt an active run on Android PhoneBridge and rotate `session.runId` so future calls work cleanly
   * (PhoneTaskSessions permanently marks ended runIds as immutable).
   *
   * @param {any} session
   * @param {string} targetRunId
   */
  async _interruptSessionRun(session, targetRunId) {
    if (session.runId !== targetRunId) return
    const hadPhoneWork = session.hasCalledPhone
    session.runId = newRunId()
    session.hasCalledPhone = false
    // 插件自带工具（对话）不占手机租约，不必多发一次 phone-run-end。
    if (!hadPhoneWork) return
    await this._bridge.endRun({
      sessionId: session.callerSessionId,
      runId: targetRunId,
      completion: 'other',
    })
  }

  /**
   * Terminate a session, close its SSE streams, abort in-flight work, and send phone-run-end if needed.
   *
   * @param {string} sessionId
   * @param {'completed' | 'other' | 'unknown'} completion
   */
  async _terminateSession(sessionId, completion) {
    const session = this._sessions.get(sessionId)
    if (!session) return
    this._sessions.delete(sessionId)

    for (const active of session.inFlight.values()) {
      active.controller.abort(new Error('Session terminated'))
    }
    session.inFlight.clear()

    for (const stream of session.sseStreams) {
      clearInterval(stream.heartbeat)
      if (!stream.res.writableEnded && !stream.res.destroyed) {
        try {
          stream.res.end()
        } catch {
          // Ignore write errors on closing stream.
        }
      }
    }
    session.sseStreams.clear()

    if (session.hasCalledPhone) {
      session.hasCalledPhone = false
      await this._bridge.endRun({
        sessionId: session.callerSessionId,
        runId: session.runId,
        completion,
      })
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {string | null}
   */
  _headerSessionId(req) {
    const raw = req.headers['mcp-session-id']
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    return trimmed || null
  }

  /**
   * @param {any} id
   * @param {any} err
   */
  _mapBridgeError(id, err) {
    if (err && typeof err.rpcCode === 'number') {
      return jsonRpcError(id, err.rpcCode, String(err.message || 'PhoneBridge error'), err.rpcData)
    }
    if (err instanceof BridgeUnavailableError) {
      return jsonRpcError(id, -32010, err.message, { code: err.code })
    }
    return jsonRpcError(id, -32603, err?.message || 'PhoneBridge call failed')
  }
}
