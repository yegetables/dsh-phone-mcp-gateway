import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_KNOWN_TOOLS, TOOL_GROUPS, filterTools, isToolAllowed } from '../lib/tools-policy.js'

const NATIVE_PHONE_TOOLS = ALL_KNOWN_TOOLS.filter((name) => name !== 'ask_dsh')

const DEFAULT_POLICY = {
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
}

test('catalog contains all 16 native Android phone tools plus the plugin-local chat tool', () => {
  assert.equal(NATIVE_PHONE_TOOLS.length, 16)
  assert.deepEqual(TOOL_GROUPS.chat, ['ask_dsh'])
  for (const name of [
    'screen', 'collect', 'tap', 'type', 'scroll', 'key', 'tap_xy', 'handoff',
    'apps', 'open', 'intent', 'notify', 'clipboard', 'calendar_list',
    'android_shell', 'diagnostics', 'ask_dsh',
  ]) {
    assert.ok(ALL_KNOWN_TOOLS.includes(name), `missing tool ${name}`)
  }
})

test('default policy enables 14 phone tools plus ask_dsh, and blocks android_shell & diagnostics', () => {
  const mockUpstream = ALL_KNOWN_TOOLS.map((name) => ({ name }))
  const allowed = filterTools(mockUpstream, DEFAULT_POLICY).map((t) => t.name)

  assert.equal(allowed.length, 15)
  assert.equal(NATIVE_PHONE_TOOLS.filter((name) => isToolAllowed(name, DEFAULT_POLICY)).length, 14)
  assert.equal(isToolAllowed('ask_dsh', DEFAULT_POLICY), true)
  assert.equal(isToolAllowed('ask_dsh', { ...DEFAULT_POLICY, chat: false }), false)
  assert.equal(isToolAllowed('android_shell', DEFAULT_POLICY), false)
  assert.equal(isToolAllowed('diagnostics', DEFAULT_POLICY), false)
  assert.equal(isToolAllowed('screen', DEFAULT_POLICY), true)
  assert.equal(isToolAllowed('clipboard', DEFAULT_POLICY), true)
  assert.equal(isToolAllowed('calendar_list', DEFAULT_POLICY), true)
})

test('individual toggles and disabledTools override group settings', () => {
  const policy = {
    ...DEFAULT_POLICY,
    clipboard: false,
    calendar: false,
    androidShell: true,
    disabledTools: ['tap_xy', 'intent'],
  }

  assert.equal(isToolAllowed('clipboard', policy), false)
  assert.equal(isToolAllowed('calendar_list', policy), false)
  assert.equal(isToolAllowed('android_shell', policy), true)
  assert.equal(isToolAllowed('tap_xy', policy), false)
  assert.equal(isToolAllowed('intent', policy), false)
  assert.equal(isToolAllowed('tap', policy), true)
})

test('unknown tools are denied by default and allowed when allowUnknownTools is true', () => {
  assert.equal(isToolAllowed('future_tool', DEFAULT_POLICY), false)
  assert.equal(isToolAllowed('future_tool', { ...DEFAULT_POLICY, allowUnknownTools: true }), true)
  assert.equal(
    isToolAllowed('future_tool', { ...DEFAULT_POLICY, allowUnknownTools: true, disabledTools: ['future_tool'] }),
    false,
  )
})
