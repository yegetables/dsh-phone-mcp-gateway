import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeUnavailableError, PhoneBridgeClient, resolveBridgeConfigPath } from '../lib/bridge-client.js'
import { startMockPhoneBridge } from './helpers/mock-phone-bridge.mjs'

test('PhoneBridgeClient connects via abstract unix socket on Linux and multiplexes calls', async (t) => {
  const bridgeMock = await startMockPhoneBridge({ useAbstract: true, useTcp: true })
  const client = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  t.after(async () => {
    client.close()
    await bridgeMock.close()
  })

  const { tools } = await client.listTools()
  assert.ok(tools.some((item) => item.name === 'screen'))
  assert.ok(client.transport?.startsWith('unix:@'))

  const [res1, res2] = await Promise.all([
    client.callTool({
      name: 'screen',
      arguments: { image: false },
      caller: { sessionId: 'opencode@100.64.0.2', runId: 'run-1', callId: 'call-1', runLifecycle: 1 },
    }),
    client.callTool({
      name: 'apps',
      arguments: { query: 'wechat' },
      caller: { sessionId: 'opencode@100.64.0.2', runId: 'run-1', callId: 'call-2', runLifecycle: 1 },
    }),
  ])

  assert.equal(res1.content[0].text, 'ok:screen')
  assert.equal(res2.content[0].text, 'ok:apps')
  assert.equal(bridgeMock.toolCalls.length, 2)
  assert.equal(bridgeMock.toolCalls[0].caller.runLifecycle, 1)

  const ack = await client.endRun({ sessionId: 'opencode@100.64.0.2', runId: 'run-1', completion: 'completed' })
  assert.equal(ack, true)
  assert.deepEqual(bridgeMock.runEnds, [
    { sessionId: 'opencode@100.64.0.2', runId: 'run-1', completion: 'completed' },
  ])
})

test('PhoneBridgeClient falls back to loopback TCP when abstract socket is unreachable', async (t) => {
  const bridgeMock = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  bridgeMock.writeConfig({ abstract: 'dsh-app.phone.nonexistent.socket', tcpPort: bridgeMock.tcpPort })
  const client = new PhoneBridgeClient({ configPath: bridgeMock.configPath })
  t.after(async () => {
    client.close()
    await bridgeMock.close()
  })

  const { tools } = await client.listTools()
  assert.ok(tools.length > 0)
  assert.equal(client.transport, `tcp:127.0.0.1:${bridgeMock.tcpPort}`)
})

test('PhoneBridgeClient rejects on wrong hello token', async (t) => {
  const bridgeMock = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  bridgeMock.writeConfig({ token: 'wrong-token-value' })
  const client = new PhoneBridgeClient({ configPath: bridgeMock.configPath, connectTimeoutMs: 500 })
  t.after(async () => {
    client.close()
    await bridgeMock.close()
  })

  await assert.rejects(() => client.listTools(), (err) => {
    assert.ok(err instanceof BridgeUnavailableError)
    return true
  })
})

test('PhoneBridgeClient detects bridge.json rotation and reconnects seamlessly', async (t) => {
  const mockA = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  const mockB = await startMockPhoneBridge({ useAbstract: false, useTcp: true })
  const client = new PhoneBridgeClient({ configPath: mockA.configPath })
  t.after(async () => {
    client.close()
    await mockA.close()
    await mockB.close()
  })

  await client.listTools()
  assert.equal(client.transport, `tcp:127.0.0.1:${mockA.tcpPort}`)

  // Simulate Android restarting PhoneBridge with a new port + token written to the same bridge.json
  mockA.writeConfig({ abstract: null, tcpPort: mockB.tcpPort, token: mockB.token })

  await client.callTool({
    name: 'screen',
    arguments: {},
    caller: { sessionId: 'test@127.0.0.1', runId: 'run-b', callId: 'call-b', runLifecycle: 1 },
  })
  assert.equal(client.transport, `tcp:127.0.0.1:${mockB.tcpPort}`)
  assert.equal(mockB.toolCalls.length, 1)
})

test('resolveBridgeConfigPath honors direct launch preload hook', (t) => {
  const sym = Symbol.for('dsh.go.direct')
  const prev = globalThis[sym]
  globalThis[sym] = { toHost: (p) => `/data/user/0/app/rootfs${p}` }
  t.after(() => {
    if (prev === undefined) delete globalThis[sym]
    else globalThis[sym] = prev
  })

  assert.equal(
    resolveBridgeConfigPath('/var/lib/dsh-app/phone/bridge.json'),
    '/data/user/0/app/rootfs/var/lib/dsh-app/phone/bridge.json',
  )
})
