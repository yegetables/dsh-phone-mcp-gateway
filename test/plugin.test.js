import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply, inject, name, start } from '../lib/index.js'
import { CREDENTIAL_REF } from '../lib/config.js'
import { startMockPhoneBridge } from './helpers/mock-phone-bridge.mjs'

function createMockContext(initialToken) {
  const emitter = new EventEmitter()
  let storedToken = initialToken
  const registeredCommands = new Map()
  const disposers = []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    credentials: {
      async resolve(ref) {
        return String(ref) === CREDENTIAL_REF ? storedToken : undefined
      },
      async describe(ref) {
        if (String(ref) !== CREDENTIAL_REF || !storedToken) {
          return { configured: false, writable: true }
        }
        return { configured: true, writable: true, masked: `${storedToken.slice(0, 3)}***` }
      },
    },
    commands: {
      register(def) {
        registeredCommands.set(def.name, def)
        return () => registeredCommands.delete(def.name)
      },
    },
    on(event, listener) {
      emitter.on(event, listener)
      return () => emitter.off(event, listener)
    },
    inject(deps, cb) {
      if (deps.includes('commands')) cb(ctx)
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    // Test helpers
    setToken(next) {
      storedToken = next
      emitter.emit('credentials/reference-updated', CREDENTIAL_REF)
    },
    emitVolatileUpdate(paths) {
      emitter.emit('loader/volatile-update', paths)
    },
    registeredCommands,
    async disposeAll() {
      for (const fn of disposers) await fn()
    },
  }
  return ctx
}

test('plugin exports standard Cordis metadata and handles volatile toggle, token rotation, and /phone-mcp command', async (t) => {
  assert.equal(name, 'phone-mcp-gateway')
  assert.deepEqual(inject, ['credentials'])

  const bridgeMock = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  const ctx = createMockContext('initial-secret-xyz')

  let enabledFlag = true
  let toolsPolicy = {
    screen: true,
    apps: true,
    notify: true,
    clipboard: true,
    calendar: true,
    androidShell: false,
    diagnostics: false,
    allowUnknownTools: false,
    disabledTools: [],
  }

  const config = {
    enabled: { get: () => enabledFlag },
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    auth: { get: () => ({ credentialRef: CREDENTIAL_REF, token: '' }) },
    allowedCidrs: { get: () => ['127.0.0.1/32', '::1/128'] },
    tools: { get: () => toolsPolicy },
    session: { get: () => ({ idleTimeoutSec: 300, maxSessions: 4, heartbeatIntervalSec: 15 }) },
    bridgeConfigPath: bridgeMock.configPath,
  }

  const instance = await start(ctx, config)
  t.after(async () => {
    await ctx.disposeAll()
    await bridgeMock.close()
  })

  assert.equal(instance.gateway.listening, true)
  const port = instance.gateway.listenAddress.port
  const url = `http://127.0.0.1:${port}/mcp`

  // 1. Slash command /phone-mcp is registered and never leaks plaintext secret
  const cmd = ctx.registeredCommands.get('phone-mcp')
  assert.ok(cmd)
  const statusRes = await cmd.handler({ rawInput: '' })
  assert.equal(statusRes.kind, 'success')
  assert.ok(statusRes.text.includes('运行中'))
  assert.ok(statusRes.text.includes('DSH_PHONE_MCP_TOKEN'))
  assert.ok(statusRes.text.includes('ini***'))
  assert.ok(!statusRes.text.includes('initial-secret-xyz'))

  const configSnippetRes = await cmd.handler({ rawInput: 'config' })
  assert.equal(configSnippetRes.kind, 'success')
  assert.ok(configSnippetRes.text.includes('<YOUR_DSH_PHONE_MCP_TOKEN>'))
  assert.ok(!configSnippetRes.text.includes('initial-secret-xyz'))

  // 2. Credential rotation takes effect immediately via credentials/reference-updated
  ctx.setToken('rotated-secret-999')
  await new Promise((r) => setTimeout(r, 20))

  const oldTokenRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer initial-secret-xyz' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(oldTokenRes.status, 401)

  const newTokenRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rotated-secret-999' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'opencode' } } }),
  })
  assert.equal(newTokenRes.status, 200)
  const sessionId = newTokenRes.headers.get('mcp-session-id')

  const sessionsRes = await cmd.handler({ rawInput: 'sessions' })
  assert.equal(sessionsRes.kind, 'success')
  assert.ok(sessionsRes.text.includes('opencode@127.0.0.1'))

  // 3. Hot-toggle `enabled` to false stops HTTP listener immediately
  enabledFlag = false
  ctx.emitVolatileUpdate([['enabled']])
  await instance.syncListenerState()
  assert.equal(instance.gateway.listening, false)

  // Hot-toggle `enabled` back to true restarts listener
  enabledFlag = true
  ctx.emitVolatileUpdate([['enabled']])
  await instance.syncListenerState()
  assert.equal(instance.gateway.listening, true)
  assert.ok(sessionId)
})

test('apply 遵守 Cordis 契约：async 回调必须 resolve 成 void（返回对象会触发 TypeError: Invalid effect）', async (t) => {
  const ctx = createMockContext('tok')
  const config = {
    enabled: { get: () => false },
    bindHost: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    auth: { get: () => ({ credentialRef: CREDENTIAL_REF, token: '' }) },
    allowedCidrs: { get: () => ['127.0.0.1/32'] },
    tools: { get: () => ({ screen: true, apps: true, notify: true, clipboard: true, calendar: true, androidShell: false, diagnostics: false, disableTools: [], disabledTools: [] }) },
    session: { get: () => ({ idleTimeoutSec: 300, maxSessions: 4, heartbeatIntervalSec: 15 }) },
    bridgeConfigPath: '/nonexistent/bridge.json',
  }
  t.after(() => ctx.disposeAll())

  const returned = await apply(ctx, config)
  assert.equal(returned, undefined, 'apply 不能返回运行句柄：Cordis 会把它当非法 effect')
})
