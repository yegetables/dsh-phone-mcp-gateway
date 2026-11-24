import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PhoneBridgeClient } from '../lib/bridge-client.js'
import { readRuntimeConfig } from '../lib/config.js'
import { buildCallerSessionId, McpHttpGateway } from '../lib/mcp-http.js'
import { startMockPhoneBridge } from './helpers/mock-phone-bridge.mjs'

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-json
  }
  return { status: res.status, headers: res.headers, text, json }
}

test('buildCallerSessionId sanitizes control chars and deduplicates concurrent sessions', () => {
  const used = new Set()
  const first = buildCallerSessionId('opencode\n[evil]\x07', '100.64.0.9', used)
  assert.equal(first, 'opencodeevil@100.64.0.9')
  used.add(first)

  const second = buildCallerSessionId('opencode\n[evil]\x07', '100.64.0.9', used)
  assert.equal(second, 'opencodeevil@100.64.0.9 #2')

  const fallback = buildCallerSessionId('', '192.168.1.5', new Set())
  assert.equal(fallback, 'mcp@192.168.1.5')
})

test('MCP Streamable HTTP gateway enforces CIDR, Origin, Bearer auth, tool filtering, and PhoneCaller injection', async (t) => {
  const bridgeMock = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  let token = null
  const rawConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    allowedCidrs: ['127.0.0.1/32', '::1/128'],
    tools: {
      screen: true,
      apps: true,
      notify: true,
      clipboard: true,
      calendar: true,
      androidShell: false,
      diagnostics: false,
      allowUnknownTools: false,
      disabledTools: ['notify'],
    },
    session: {
      idleTimeoutSec: 300,
      maxSessions: 4,
      heartbeatIntervalSec: 15,
    },
    bridgeConfigPath: bridgeMock.configPath,
  }

  const bridge = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  const gateway = new McpHttpGateway({
    bridge,
    getRuntimeConfig: () => readRuntimeConfig(rawConfig),
    getExpectedToken: async () => token,
  })
  await gateway.start({ bindHost: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${gateway.listenAddress.port}/mcp`

  t.after(async () => {
    await gateway.stop()
    bridge.close()
    await bridgeMock.close()
  })

  // 1. Wrong path -> 404
  const notFound = await postJson(`http://127.0.0.1:${gateway.listenAddress.port}/other`, {})
  assert.equal(notFound.status, 404)

  // 2. Unconfigured token -> 503 fail-closed
  const noTokenCfg = await postJson(baseUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(noTokenCfg.status, 503)

  // 3. Configure token; missing / wrong Bearer -> 401
  token = 'super-secret-token-123'
  const missingAuth = await postJson(baseUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(missingAuth.status, 401)
  const wrongAuth = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { Authorization: 'Bearer wrong-token' },
  )
  assert.equal(wrongAuth.status, 401)

  const authHeader = { Authorization: `Bearer ${token}` }

  // 4. Malicious Origin -> 403
  const badOrigin = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { ...authHeader, Origin: 'https://evil.example.com' },
  )
  assert.equal(badOrigin.status, 403)

  // 5. CIDR rejection when loopback is removed
  rawConfig.allowedCidrs = ['100.64.0.0/10']
  const cidrDenied = await postJson(baseUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, authHeader)
  assert.equal(cidrDenied.status, 403)
  rawConfig.allowedCidrs = ['127.0.0.1/32', '::1/128']

  // 6. Initialize session
  const initRes = await postJson(
    baseUrl,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'opencode', version: '1.2.3' },
      },
    },
    authHeader,
  )
  assert.equal(initRes.status, 200)
  const sessionId = initRes.headers.get('mcp-session-id')
  assert.ok(sessionId)
  assert.equal(initRes.json.result.protocolVersion, '2025-11-25')
  assert.equal(initRes.json.result.capabilities.tools.listChanged, true)

  const sessionHeaders = { ...authHeader, 'Mcp-Session-Id': sessionId }

  // 7. notifications/initialized -> 202
  const notifRes = await postJson(
    baseUrl,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sessionHeaders,
  )
  assert.equal(notifRes.status, 202)

  // 8. tools/list reflects policy (android_shell, diagnostics, and disabledTools=['notify'] excluded)
  const listRes = await postJson(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionHeaders)
  assert.equal(listRes.status, 200)
  const listedNames = listRes.json.result.tools.map((tool) => tool.name)
  assert.ok(listedNames.includes('screen'))
  assert.ok(listedNames.includes('clipboard'))
  assert.ok(!listedNames.includes('android_shell'))
  assert.ok(!listedNames.includes('diagnostics'))
  assert.ok(!listedNames.includes('notify'))

  // 9. Attempting to call disabled tool directly is blocked before PhoneBridge
  const blockedCall = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'android_shell', arguments: { command: 'id' } } },
    sessionHeaders,
  )
  assert.equal(blockedCall.status, 200)
  assert.equal(blockedCall.json.error.code, -32602)
  assert.equal(bridgeMock.toolCalls.length, 0)

  // 10. Allowed tools/call injects synthesized PhoneCaller and overrides any spoofed _meta
  const callRes = await postJson(
    baseUrl,
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'screen',
        arguments: { image: false },
        _meta: { 'dsh-go/phone-caller': { v: 1, sessionId: 'spoofed', runId: 'spoofed', callId: 'spoofed', runLifecycle: 0 } },
      },
    },
    sessionHeaders,
  )
  assert.equal(callRes.status, 200)
  assert.equal(callRes.json.result.content[0].text, 'ok:screen')
  assert.equal(bridgeMock.toolCalls.length, 1)
  assert.equal(bridgeMock.toolCalls[0].caller.sessionId, 'opencode@127.0.0.1')
  assert.equal(bridgeMock.toolCalls[0].caller.runLifecycle, 1)
  const firstRunId = bridgeMock.toolCalls[0].caller.runId
  assert.ok(firstRunId.startsWith('run-'))

  // 11. DELETE /mcp terminates session and sends dsh-go/phone-run-end
  const delRes = await fetch(baseUrl, { method: 'DELETE', headers: sessionHeaders })
  assert.equal(delRes.status, 200)
  assert.deepEqual(bridgeMock.runEnds, [
    { sessionId: 'opencode@127.0.0.1', runId: firstRunId, completion: 'completed' },
  ])

  // Subsequent call with deleted sessionId returns 404
  const afterDel = await postJson(baseUrl, { jsonrpc: '2.0', id: 5, method: 'ping' }, sessionHeaders)
  assert.equal(afterDel.status, 404)
})

test('MCP Streamable HTTP streams SSE keepalives on slow tool call and notifies list_changed on GET SSE', async (t) => {
  const bridgeMock = await startMockPhoneBridge({
    useAbstract: false,
    useTcp: true,
    async onToolCall(call) {
      if (call.name === 'handoff') {
        await new Promise((r) => setTimeout(r, 120))
      }
      return { content: [{ type: 'text', text: `done:${call.name}` }], isError: false }
    },
  })

  const rawConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    allowedCidrs: ['127.0.0.1/32'],
    tools: { screen: true, apps: true, notify: true, clipboard: true, calendar: true, androidShell: false, diagnostics: false, disabledTools: [] },
    session: { idleTimeoutSec: 30, maxSessions: 4, heartbeatIntervalSec: 5 },
    bridgeConfigPath: bridgeMock.configPath,
  }

  const bridge = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  const gateway = new McpHttpGateway({
    bridge,
    getRuntimeConfig: () => ({
      ...readRuntimeConfig(rawConfig),
      session: { idleTimeoutMs: 30_000, maxSessions: 4, heartbeatIntervalMs: 35 },
    }),
    getExpectedToken: async () => 'tok',
  })
  await gateway.start({ bindHost: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${gateway.listenAddress.port}/mcp`
  const auth = { Authorization: 'Bearer tok' }

  t.after(async () => {
    await gateway.stop()
    bridge.close()
    await bridgeMock.close()
  })

  const init = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } },
    auth,
  )
  const sessionId = init.headers.get('mcp-session-id')
  const sessionHeaders = { ...auth, 'Mcp-Session-Id': sessionId }

  // 1. Open GET /mcp SSE channel and verify tools/list_changed push
  const sseChunks = []
  const getReq = http.request(baseUrl, {
    method: 'GET',
    headers: { ...sessionHeaders, Accept: 'text/event-stream' },
  })
  const gotListChanged = new Promise((resolve) => {
    getReq.on('response', (res) => {
      assert.equal(res.statusCode, 200)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        sseChunks.push(chunk)
        if (sseChunks.join('').includes('notifications/tools/list_changed')) {
          resolve(true)
        }
      })
      gateway.notifyToolsChanged()
    })
  })
  getReq.end()
  assert.equal(await gotListChanged, true)

  // 2. Call slow tool with Accept: text/event-stream -> receives keepalive + final SSE event
  const sseCall = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'handoff', arguments: { reason: 'login' } } },
    { ...sessionHeaders, Accept: 'application/json, text/event-stream' },
  )
  assert.equal(sseCall.status, 200)
  assert.ok(sseCall.headers.get('content-type')?.includes('text/event-stream'))
  assert.ok(sseCall.text.includes(': keepalive'))
  assert.ok(sseCall.text.includes('"done:handoff"'))

  // 3. Idle sweep while GET /mcp is still open releases phone lease WITHOUT dropping the MCP session
  const futureNow = Date.now() + 60_000
  const reapedSessions = await gateway.sweepIdleSessions(futureNow)
  assert.equal(reapedSessions, 0)
  assert.equal(bridgeMock.runEnds.length, 1)
  assert.equal(bridgeMock.runEnds[0].completion, 'completed')

  // Session still works after phone lease release and uses a fresh runId
  const secondCall = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen', arguments: {} } },
    sessionHeaders,
  )
  assert.equal(secondCall.status, 200)
  assert.notEqual(bridgeMock.toolCalls[1].caller.runId, bridgeMock.toolCalls[0].caller.runId)

  getReq.destroy()
})

test('notifications/cancelled interrupts in-flight call, ends phone run, and rotates runId', async (t) => {
  let releaseSlowCall
  const slowStarted = new Promise((resolve) => {
    releaseSlowCall = resolve
  })

  const bridgeMock = await startMockPhoneBridge({
    useAbstract: false,
    useTcp: true,
    async onToolCall(call) {
      if (call.name === 'handoff') {
        releaseSlowCall()
        await new Promise((r) => setTimeout(r, 5000))
      }
      return { content: [{ type: 'text', text: `ok:${call.name}` }], isError: false }
    },
  })

  const rawConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    allowedCidrs: ['127.0.0.1/32'],
    tools: { screen: true, apps: true, notify: true, clipboard: true, calendar: true, androidShell: false, diagnostics: false, disabledTools: [] },
    session: { idleTimeoutSec: 300, maxSessions: 4, heartbeatIntervalSec: 15 },
    bridgeConfigPath: bridgeMock.configPath,
  }

  const bridge = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  const gateway = new McpHttpGateway({
    bridge,
    getRuntimeConfig: () => readRuntimeConfig(rawConfig),
    getExpectedToken: async () => 'tok',
  })
  await gateway.start({ bindHost: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${gateway.listenAddress.port}/mcp`
  const auth = { Authorization: 'Bearer tok' }

  t.after(async () => {
    await gateway.stop()
    bridge.close()
    await bridgeMock.close()
  })

  const init = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'hermes' } } },
    auth,
  )
  const sessionId = init.headers.get('mcp-session-id')
  const sessionHeaders = { ...auth, 'Mcp-Session-Id': sessionId }

  const slowPromise = postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'handoff', arguments: { reason: 'wait' } } },
    sessionHeaders,
  )

  await slowStarted

  const cancelRes = await postJson(
    baseUrl,
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'user aborted' } },
    sessionHeaders,
  )
  assert.equal(cancelRes.status, 202)

  const slowResult = await slowPromise
  assert.equal(slowResult.status, 200)
  assert.equal(slowResult.json.error.code, -32000)

  assert.equal(bridgeMock.runEnds.length, 1)
  assert.equal(bridgeMock.runEnds[0].completion, 'other')

  // Next call works with a fresh rotated runId
  const nextCall = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'screen', arguments: {} } },
    sessionHeaders,
  )
  assert.equal(nextCall.status, 200)
  assert.equal(nextCall.json.result.content[0].text, 'ok:screen')
  assert.notEqual(bridgeMock.toolCalls[1].caller.runId, bridgeMock.toolCalls[0].caller.runId)
})

test('插件自带工具（ask_dsh）与手机工具并存，并受 tools.chat 开关控制', async (t) => {
  const bridgeMock = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  let chatEnabled = true
  const localCalls = []

  const rawConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    allowedCidrs: ['127.0.0.1/32'],
    tools: {
      screen: true,
      apps: true,
      notify: true,
      clipboard: true,
      calendar: true,
      androidShell: false,
      diagnostics: false,
      chat: true,
      allowUnknownTools: false,
      disabledTools: [],
    },
    session: { idleTimeoutSec: 300, maxSessions: 4, heartbeatIntervalSec: 15 },
    bridgeConfigPath: bridgeMock.configPath,
  }

  const bridge = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  const gateway = new McpHttpGateway({
    bridge,
    getRuntimeConfig: () => {
      const snapshot = readRuntimeConfig(rawConfig)
      return { ...snapshot, tools: { ...snapshot.tools, chat: chatEnabled } }
    },
    getExpectedToken: async () => 'tok',
    getLocalTools: () => [
      {
        name: 'ask_dsh',
        description: 'talk to the phone dsh',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        async handler(args) {
          localCalls.push(args.message)
          return { text: `[sess-1]\n\n收到：${args.message}` }
        },
      },
    ],
  })
  await gateway.start({ bindHost: '127.0.0.1', port: 0 })
  const baseUrl = `http://127.0.0.1:${gateway.listenAddress.port}/mcp`
  const auth = { Authorization: 'Bearer tok' }

  t.after(async () => {
    await gateway.stop()
    bridge.close()
    await bridgeMock.close()
  })

  const init = await postJson(baseUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, auth)
  const sessionHeaders = { ...auth, 'Mcp-Session-Id': init.headers.get('mcp-session-id') }

  // 手机工具和插件自带工具同时出现在 tools/list
  const list = await postJson(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionHeaders)
  const names = list.json.result.tools.map((tool) => tool.name)
  assert.ok(names.includes('screen'), '手机工具仍在')
  assert.ok(names.includes('ask_dsh'), '插件自带工具应在表里')

  // 调用插件自带工具：不经过 PhoneBridge
  const call = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_dsh', arguments: { message: '你好' } } },
    sessionHeaders,
  )
  assert.equal(call.status, 200)
  assert.equal(call.json.result.isError, false)
  assert.ok(call.json.result.content[0].text.includes('收到：你好'))
  assert.deepEqual(localCalls, ['你好'])
  assert.equal(bridgeMock.toolCalls.length, 0, 'ask_dsh 不应打到手机 PhoneBridge')

  // 关掉 tools.chat 后：不再列出，直接调用也被拒
  chatEnabled = false
  const list2 = await postJson(baseUrl, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, sessionHeaders)
  assert.ok(!list2.json.result.tools.map((tool) => tool.name).includes('ask_dsh'))

  const denied = await postJson(
    baseUrl,
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_dsh', arguments: { message: '再问' } } },
    sessionHeaders,
  )
  assert.equal(denied.json.error.code, -32602)
  assert.deepEqual(localCalls, ['你好'])
})
