import { isIP } from 'node:net'

/**
 * Normalize an IP address string from Node sockets or headers.
 * Strips IPv6 zone IDs (e.g. `%eth0`) and unwraps IPv4-mapped IPv6 (`::ffff:192.168.1.10`).
 *
 * @param {string | undefined | null} raw
 * @returns {string | null}
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (!value) return null

  // Strip surrounding brackets if present (e.g. `[::1]`).
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1)
  }

  // Strip IPv6 scope / zone index (e.g. `fe80::1%wlan0`).
  const zoneIdx = value.indexOf('%')
  if (zoneIdx !== -1) {
    value = value.slice(0, zoneIdx)
  }

  const lower = value.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7)
    if (isIP(tail) === 4) {
      return tail
    }
    // Dotted form not used; check hex form `::ffff:c0a8:0101`
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1], 16)
      const lo = Number.parseInt(hexMatch[2], 16)
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    }
  }

  const version = isIP(value)
  if (version === 4) return value
  if (version === 6) return lower
  return null
}

/**
 * Parse an IPv4 address string into a 32-bit BigInt.
 *
 * @param {string} ip
 * @returns {bigint | null}
 */
function parseIPv4(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let result = 0n
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet < 0 || octet > 255) return null
    result = (result << 8n) | BigInt(octet)
  }
  return result
}

/**
 * Parse an IPv6 address string (including compressed `::` and embedded IPv4) into a 128-bit BigInt.
 *
 * @param {string} ip
 * @returns {bigint | null}
 */
function parseIPv6(ip) {
  if (isIP(ip) !== 6) return null
  let work = ip.toLowerCase()

  // Handle embedded IPv4 at the end (e.g. `::ffff:192.0.2.128` or `64:ff9b::192.0.2.33`).
  const lastColon = work.lastIndexOf(':')
  if (lastColon !== -1 && work.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(work.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16)
    const lo = Number(v4 & 0xffffn).toString(16)
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = work.split('::')
  if (halves.length > 2) return null

  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []

  let groups
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length)
    if (missing < 1) return null
    groups = [...left, ...Array(missing).fill('0'), ...right]
  } else {
    if (left.length !== 8) return null
    groups = left
  }

  let result = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    result = (result << 16n) | BigInt(Number.parseInt(group, 16))
  }
  return result
}

/**
 * Parse a CIDR string or single IP address into a structured matcher.
 * Single IP without `/prefix` is treated as `/32` (IPv4) or `/128` (IPv6).
 *
 * @param {string} raw
 * @returns {{ raw: string, family: 4 | 6, network: bigint, mask: bigint, prefix: number } | null}
 */
export function parseCidr(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  const slashIdx = trimmed.indexOf('/')
  const ipPart = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx)
  const prefixPart = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1)

  const normalized = normalizeIp(ipPart)
  if (!normalized) return null

  const family = isIP(normalized)
  if (family !== 4 && family !== 6) return null

  const bits = family === 4 ? 32 : 128
  let prefix = bits
  if (prefixPart !== null) {
    if (!/^(0|[1-9]\d{0,2})$/.test(prefixPart)) return null
    prefix = Number(prefixPart)
    if (prefix < 0 || prefix > bits) return null
  }

  const addr = family === 4 ? parseIPv4(normalized) : parseIPv6(normalized)
  if (addr === null) return null

  const allOnes = (1n << BigInt(bits)) - 1n
  const mask = prefix === 0 ? 0n : (allOnes << BigInt(bits - prefix)) & allOnes
  return {
    raw: trimmed,
    family,
    network: addr & mask,
    mask,
    prefix,
  }
}

/**
 * Compile a list of CIDR strings, separating valid rules from invalid entries.
 *
 * @param {readonly string[]} cidrs
 * @returns {{ rules: Array<NonNullable<ReturnType<typeof parseCidr>>>, invalid: string[] }}
 */
export function compileCidrs(cidrs) {
  const rules = []
  const invalid = []
  if (!Array.isArray(cidrs)) return { rules, invalid }

  for (const item of cidrs) {
    if (typeof item !== 'string' || !item.trim()) continue
    const parsed = parseCidr(item)
    if (parsed) {
      rules.push(parsed)
    } else {
      invalid.push(item)
    }
  }
  return { rules, invalid }
}

/**
 * Test whether an IP address matches any compiled CIDR rule.
 *
 * @param {string | undefined | null} rawIp
 * @param {readonly NonNullable<ReturnType<typeof parseCidr>>[]} rules
 * @returns {boolean}
 */
export function isIpAllowed(rawIp, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return false
  const normalized = normalizeIp(rawIp)
  if (!normalized) return false

  const family = isIP(normalized)
  if (family !== 4 && family !== 6) return false

  const addr = family === 4 ? parseIPv4(normalized) : parseIPv6(normalized)
  if (addr === null) return false

  for (const rule of rules) {
    if (rule.family !== family) continue
    if ((addr & rule.mask) === rule.network) return true
  }
  return false
}
