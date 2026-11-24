import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const MOCK_TOOLS = [
  { name: 'screen', description: 'Read screen', inputSchema: { type: 'object', properties: {} } },
  { name: 'tap', description: 'Tap element', inputSchema: { type: 'object', properties: { screen: { type: 'string' }, id: { type: 'integer' } } } },
  { name: 'handoff', description: 'Ask human', inputSchema: { type: 'object', properties: { reason: { type: 'string' } } } },
  { name: 'apps', description: 'List apps', inputSchema: { type: 'object', properties: {} } },
  { name: 'notify', description: 'Post notification', inputSchema: { type: 'object', properties: {} } },
  { name: 'clipboard', description: 'Clipboard', inputSchema: { type: 'object', properties: {} } },
  { name: 'calendar_list', description: 'List calendar', inputSchema: { type: 'object', properties: {} } },
  { name: 'android_shell', description: 'Run Android shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'diagnostics', description: 'Diagnostics', inputSchema: { type: 'object', properties: {} } },
]

/**
 * Start a faithful mock of Android PhoneBridge.kt + McpServer.kt.
 *
 * @param {{
 *   useAbstract?: boolean,
 *   useTcp?: boolean,
 *   token?: string,
 *   onToolCall?: (call: { name: string, args: any, caller: any }) => Promise<any> | any,
 * }} [options]
 */
export async function startMockPhoneBridge(options = {}) {
  const token = options.token || crypto.randomBytes(16).toString('hex')
  const useAbstract = options.useAbstract === true
  const useTcp = options.useTcp !== false

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-bridge-test-'))
  const configPath = path.join(tmpDir, 'bridge.json')

  /** @type {Array<{ name: string, args: any, caller: any }>} */
  const toolCalls = []
  /** @type {Array<{ sessionId: string, runId: string, completion: string }>} */
  const runEnds = []
  /** @type {Set<net.Socket>} */
  const sockets = new Set()

  let abstractName = null
  let tcpPort = null
  /** @type {net.Server[]} */
  const servers = []

  const handleConnection = (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))

    let authed = false
    let buf = ''

    const sendLine = (obj) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify(obj)}\n`)
      }
    }

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      while (true) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue

        if (!authed) {
          try {
            const hello = JSON.parse(line)
            if (hello?.dshPhone === 1 && hello?.token === token) {
              authed = true
              continue
            }
          } catch {
            // Fall through to destroy.
          }
          socket.destroy()
          return
        }

        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          sendLine({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
          continue
        }

        if (!Object.hasOwn(msg, 'id')) continue
        const { id, method, params = {} } = msg

        if (method === 'initialize') {
          sendLine({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'dsh-app-phone', version: 'test' },
            },
          })
        } else if (method === 'ping') {
          sendLine({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'tools/list') {
          sendLine({ jsonrpc: '2.0', id, result: { tools: MOCK_TOOLS } })
        } else if (method === 'dsh-go/phone-run-end') {
          if (params.v !== 1 || !params.sessionId || !params.runId) {
            sendLine({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid phone run end context' } })
          } else {
            runEnds.push({
              sessionId: params.sessionId,
              runId: params.runId,
              completion: params.completion || 'unknown',
            })
            sendLine({ jsonrpc: '2.0', id, result: {} })
          }
        } else if (method === 'tools/call') {
          const caller = params?._meta?.['dsh-go/phone-caller'] ?? null
          const record = { name: params.name, args: params.arguments || {}, caller }
          toolCalls.push(record)

          Promise.resolve()
            .then(() => (options.onToolCall ? options.onToolCall(record) : {
              content: [{ type: 'text', text: `ok:${params.name}` }],
              isError: false,
            }))
            .then((result) => {
              sendLine({ jsonrpc: '2.0', id, result })
            })
            .catch((err) => {
              sendLine({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || String(err) } })
            })
        } else {
          sendLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        }
      }
    })
  }

  if (useAbstract) {
    abstractName = `dsh-app.phone.test.${crypto.randomBytes(6).toString('hex')}`
    const unixServer = net.createServer(handleConnection)
    await new Promise((resolve, reject) => {
      unixServer.once('error', reject)
      unixServer.listen(`\0${abstractName}`, resolve)
    })
    servers.push(unixServer)
  }

  if (useTcp) {
    const tcpServer = net.createServer(handleConnection)
    await new Promise((resolve, reject) => {
      tcpServer.once('error', reject)
      tcpServer.listen(0, '127.0.0.1', () => {
        const addr = tcpServer.address()
        tcpPort = typeof addr === 'object' && addr ? addr.port : null
        resolve()
      })
    })
    servers.push(tcpServer)
  }

  const writeConfig = (override = {}) => {
    writeFileSync(
      configPath,
      `${JSON.stringify({
        v: 1,
        abstract: override.abstract !== undefined ? override.abstract : abstractName,
        tcpPort: override.tcpPort !== undefined ? override.tcpPort : tcpPort,
        token: override.token !== undefined ? override.token : token,
      })}\n`,
      { mode: 0o600 },
    )
  }
  writeConfig()

  return {
    configPath,
    token,
    abstractName,
    tcpPort,
    toolCalls,
    runEnds,
    writeConfig,
    async close() {
      for (const s of sockets) s.destroy()
      sockets.clear()
      await Promise.all(servers.map((srv) => new Promise((r) => srv.close(() => r()))))
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
