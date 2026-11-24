import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialValue } from '../lib/credentials.js'

test('credentialValue 兼容 DSH 的 { value, source } 与纯字符串两种返回', () => {
  // 当前 DSH：resolve() 解析成 { value, source }
  assert.equal(credentialValue({ value: 'secret-1', source: 'file' }), 'secret-1')
  // 早期/其他 provider 可能直接给字符串
  assert.equal(credentialValue('secret-2'), 'secret-2')
  // 未配置
  assert.equal(credentialValue(undefined), null)
  assert.equal(credentialValue(null), null)
  assert.equal(credentialValue({}), null)
  assert.equal(credentialValue({ value: '' }), null)
  assert.equal(credentialValue({ value: 123 }), null)
  assert.equal(credentialValue(''), null)
})
