import test from 'node:test'
import assert from 'node:assert/strict'
import { compileCidrs, isIpAllowed, normalizeIp, parseCidr } from '../lib/cidr.js'

test('normalizeIp unwraps IPv4-mapped IPv6, brackets, and zone ids', () => {
  assert.equal(normalizeIp('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('::ffff:192.168.1.42'), '192.168.1.42')
  assert.equal(normalizeIp('::FFFF:100.64.0.9'), '100.64.0.9')
  assert.equal(normalizeIp('::ffff:c0a8:0105'), '192.168.1.5')
  assert.equal(normalizeIp('[::1]'), '::1')
  assert.equal(normalizeIp('fe80::1%wlan0'), 'fe80::1')
  assert.equal(normalizeIp('not-an-ip'), null)
  assert.equal(normalizeIp(''), null)
})

test('parseCidr parses IPv4, IPv6, and bare host IPs', () => {
  const v4 = parseCidr('192.168.1.10/24')
  assert.ok(v4)
  assert.equal(v4.family, 4)
  assert.equal(v4.prefix, 24)

  const hostV4 = parseCidr('100.80.1.2')
  assert.ok(hostV4)
  assert.equal(hostV4.prefix, 32)

  const v6 = parseCidr('fd7a:115c:a1e0::/48')
  assert.ok(v6)
  assert.equal(v6.family, 6)
  assert.equal(v6.prefix, 48)

  assert.equal(parseCidr('192.168.1.0/33'), null)
  assert.equal(parseCidr('::1/129'), null)
  assert.equal(parseCidr('999.0.0.1/24'), null)
  assert.equal(parseCidr('10.0.0.0/-1'), null)
})

test('isIpAllowed matches LAN, Tailscale, loopback, and rejects public IPs', () => {
  const { rules, invalid } = compileCidrs([
    '127.0.0.1/32',
    '::1/128',
    '100.64.0.0/10',
    'fd7a:115c:a1e0::/48',
    '192.168.0.0/16',
    'bad/cidr',
  ])
  assert.deepEqual(invalid, ['bad/cidr'])

  assert.equal(isIpAllowed('127.0.0.1', rules), true)
  assert.equal(isIpAllowed('::ffff:127.0.0.1', rules), true)
  assert.equal(isIpAllowed('::1', rules), true)
  assert.equal(isIpAllowed('100.64.0.1', rules), true)
  assert.equal(isIpAllowed('100.127.255.254', rules), true)
  assert.equal(isIpAllowed('::ffff:100.100.5.8', rules), true)
  assert.equal(isIpAllowed('fd7a:115c:a1e0::1234', rules), true)
  assert.equal(isIpAllowed('192.168.6.49', rules), true)

  // Public or out-of-range IPs must be rejected
  assert.equal(isIpAllowed('100.128.0.1', rules), false)
  assert.equal(isIpAllowed('8.8.8.8', rules), false)
  assert.equal(isIpAllowed('::ffff:1.1.1.1', rules), false)
  assert.equal(isIpAllowed('2606:4700:4700::1111', rules), false)
  assert.equal(isIpAllowed('127.0.0.2', rules), false)
  assert.equal(isIpAllowed('192.168.1.1', []), false)
})
