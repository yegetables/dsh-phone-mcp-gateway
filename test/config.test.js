import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, CREDENTIAL_REF, readRuntimeConfig } from '../lib/config.js'

test('Config schema satisfies dsh-Go plugin-config credential-ref + secret pairing contract', () => {
  const graph = Config.toJSON()
  assert.ok(graph && graph.refs && graph.refs[graph.uid])

  const root = graph.refs[graph.uid]
  assert.equal(root.type, 'object')

  // Verify volatile flags on hot-reloaded fields
  assert.equal(graph.refs[root.dict.enabled].meta.volatile, true)
  assert.equal(graph.refs[root.dict.auth].meta.volatile, true)
  assert.equal(graph.refs[root.dict.allowedCidrs].meta.volatile, true)
  assert.equal(graph.refs[root.dict.tools].meta.volatile, true)
  assert.equal(graph.refs[root.dict.session].meta.volatile, true)

  // Verify non-volatile network fields
  assert.notEqual(graph.refs[root.dict.bindHost].meta.volatile, true)
  assert.notEqual(graph.refs[root.dict.port].meta.volatile, true)

  // Verify auth object has exactly one role('credential-ref') and one role('secret')
  const authNode = graph.refs[root.dict.auth]
  assert.equal(authNode.type, 'object')
  const credRefNode = graph.refs[authNode.dict.credentialRef]
  const tokenNode = graph.refs[authNode.dict.token]
  assert.equal(credRefNode.meta.role, 'credential-ref')
  assert.equal(credRefNode.meta.default, CREDENTIAL_REF)
  assert.equal(tokenNode.meta.role, 'secret')

  // Attempting to store a plaintext secret into config directly must be rejected by SecretSentinel
  if (typeof Config === 'function') {
    assert.throws(() => Config({ auth: { token: 'leaked-plaintext' } }), /凭据服务/)
    const valid = Config({})
    // Volatile fields are exposed as Cordis handles with `.get()`.
    const auth = typeof valid.auth?.get === 'function' ? valid.auth.get() : valid.auth
    assert.equal(auth.credentialRef, CREDENTIAL_REF)
    assert.equal(auth.token, '')
  }
})

test('readRuntimeConfig unwraps Cordis volatile handles and normalizes values', () => {
  const volatile = (value) => ({ get: () => value })
  const snapshot = readRuntimeConfig({
    enabled: volatile(false),
    bindHost: '127.0.0.1',
    port: 4000,
    endpointPath: 'custom/mcp/',
    auth: volatile({ credentialRef: CREDENTIAL_REF, token: '' }),
    allowedCidrs: volatile(['127.0.0.1/32', '100.64.0.0/10']),
    tools: volatile({
      screen: true,
      apps: false,
      notify: true,
      clipboard: false,
      calendar: true,
      androidShell: true,
      diagnostics: false,
      allowUnknownTools: false,
      disabledTools: ['tap_xy'],
    }),
    session: volatile({
      idleTimeoutSec: 120,
      maxSessions: 8,
      heartbeatIntervalSec: 10,
    }),
    bridgeConfigPath: '/tmp/custom-bridge.json',
  })

  assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.bindHost, '127.0.0.1')
  assert.equal(snapshot.port, 4000)
  assert.equal(snapshot.endpointPath, '/custom/mcp')
  assert.equal(snapshot.credentialRef, CREDENTIAL_REF)
  assert.equal(snapshot.cidrRules.length, 2)
  assert.equal(snapshot.tools.apps, false)
  assert.equal(snapshot.tools.clipboard, false)
  assert.equal(snapshot.tools.androidShell, true)
  assert.deepEqual(snapshot.tools.disabledTools, ['tap_xy'])
  assert.equal(snapshot.session.idleTimeoutMs, 120_000)
  assert.equal(snapshot.session.maxSessions, 8)
  assert.equal(snapshot.session.heartbeatIntervalMs, 10_000)
  assert.equal(snapshot.bridgeConfigPath, '/tmp/custom-bridge.json')
})
