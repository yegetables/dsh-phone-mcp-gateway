import os from 'node:os'
import { compileCidrs, isIpAllowed } from './cidr.js'
import { ALL_KNOWN_TOOLS, isToolAllowed } from './tools-policy.js'

const TAILSCALE_RULES = compileCidrs(['100.64.0.0/10', 'fd7a:115c:a1e0::/48']).rules
const LAN_RULES = compileCidrs(['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']).rules

/**
 * Enumerate local network interfaces and classify reachable addresses for LAN, Tailscale, and loopback.
 *
 * @param {() => ReturnType<typeof os.networkInterfaces>} [getInterfaces]
 */
export function listReachableAddresses(getInterfaces = os.networkInterfaces) {
  const interfaces = getInterfaces() || {}
  const tailscale = []
  const lan = []
  const other = []

  for (const [iface, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || entry.internal || !entry.address) continue
      const addr = entry.address
      if (isIpAllowed(addr, TAILSCALE_RULES)) {
        tailscale.push({ iface, address: addr, family: entry.family })
      } else if (isIpAllowed(addr, LAN_RULES)) {
        lan.push({ iface, address: addr, family: entry.family })
      } else if (entry.family === 'IPv4' || entry.family === 4) {
        other.push({ iface, address: addr, family: entry.family })
      }
    }
  }

  return { tailscale, lan, other }
}

/**
 * Format an HTTP endpoint URL, bracketing IPv6 addresses.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} endpointPath
 */
export function formatEndpointUrl(host, port, endpointPath) {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}${endpointPath}`
}

/**
 * Build ready-to-copy MCP client JSON snippets (never containing raw secret tokens).
 *
 * @param {string} url
 */
export function buildClientConfigSnippet(url) {
  return JSON.stringify(
    {
      mcpServers: {
        'dsh-phone': {
          type: 'streamable-http',
          url,
          headers: {
            Authorization: 'Bearer <YOUR_DSH_PHONE_MCP_TOKEN>',
          },
        },
      },
    },
    null,
    2,
  )
}

/**
 * Render the `/phone-mcp` slash command text output.
 * Never includes any plaintext secret value.
 *
 * @param {{
 *   subcommand?: string,
 *   runtimeConfig: ReturnType<import('./config.js').readRuntimeConfig>,
 *   listening: boolean,
 *   listenAddress: { host: string, port: number } | null,
 *   listenError: string | null,
 *   credentialInfo: { configured: boolean, masked?: string, source?: string },
 *   bridgeProbe: { available: boolean, connected: boolean, transport: string | null, error?: string },
 *   sessions: Array<{ id: string, callerSessionId: string, clientName: string, remoteIp: string, inFlightCount: number, hasCalledPhone: boolean, lastActivityAt: number }>,
 *   getInterfaces?: () => ReturnType<typeof os.networkInterfaces>,
 * }} state
 */
export function formatSlashCommandOutput(state) {
  const mode = (state.subcommand || '').trim().toLowerCase()
  const cfg = state.runtimeConfig
  const port = state.listenAddress?.port ?? cfg.port
  const addrs = listReachableAddresses(state.getInterfaces)

  const primaryHost = cfg.bindHost === '127.0.0.1' || cfg.bindHost === '::1'
    ? cfg.bindHost
    : (addrs.tailscale[0]?.address || addrs.lan[0]?.address || '127.0.0.1')
  const primaryUrl = formatEndpointUrl(primaryHost, port, cfg.endpointPath)

  if (mode === 'sessions') {
    if (state.sessions.length === 0) {
      return '当前没有活跃的外部 MCP 会话。'
    }
    const lines = [`当前活跃外部 MCP 会话（${state.sessions.length} / ${cfg.session.maxSessions}）：`]
    for (const s of state.sessions) {
      const idleSec = Math.max(0, Math.round((Date.now() - s.lastActivityAt) / 1000))
      lines.push(
        `- ${s.callerSessionId} | 来源 IP: ${s.remoteIp} | 在途调用: ${s.inFlightCount} | 空闲: ${idleSec}s | 会话: ${s.id.slice(0, 8)}…`,
      )
    }
    return lines.join('\n')
  }

  if (mode === 'config') {
    const lines = [
      '外部 MCP 客户端配置示例（请将 <YOUR_DSH_PHONE_MCP_TOKEN> 替换为你设置的密钥）：',
      '```json',
      buildClientConfigSnippet(primaryUrl),
      '```',
      '',
      `如果走 USB adb forward：`,
      `adb forward tcp:${port} tcp:${port}`,
      `端点：${formatEndpointUrl('127.0.0.1', port, cfg.endpointPath)}`,
    ]
    return lines.join('\n')
  }

  const enabledTools = ALL_KNOWN_TOOLS.filter((name) => isToolAllowed(name, cfg.tools))
  const disabledTools = ALL_KNOWN_TOOLS.filter((name) => !isToolAllowed(name, cfg.tools))

  const lines = ['### 手机 MCP 外部网关（dsh-phone-mcp-gateway）']

  // Service status
  if (!cfg.enabled) {
    lines.push('- 服务状态：已关闭（可在「设置 › 引擎参数 › 插件」打开 enabled）')
  } else if (state.listenError) {
    lines.push(`- 服务状态：启动失败（${state.listenError}）`)
  } else if (state.listening) {
    lines.push(`- 服务状态：运行中（监听 ${cfg.bindHost}:${port}${cfg.endpointPath}）`)
  } else {
    lines.push('- 服务状态：未监听')
  }

  // Auth status
  if (state.credentialInfo.configured) {
    const masked = state.credentialInfo.masked ? `（${state.credentialInfo.masked}）` : ''
    lines.push(`- 访问密钥：已配置 ${cfg.credentialRef}${masked}`)
  } else {
    lines.push(`- 访问密钥：未配置 ${cfg.credentialRef}（当前拒绝所有外部请求，请先在「设置 › 引擎参数 › 插件」填写）`)
  }

  // PhoneBridge status
  if (state.bridgeProbe.connected) {
    lines.push(`- Android PhoneBridge：已连接（${state.bridgeProbe.transport}）`)
  } else if (state.bridgeProbe.available) {
    lines.push('- Android PhoneBridge：配置文件就绪（待首次调用时建立连接）')
  } else {
    lines.push(`- Android PhoneBridge：暂不可用（${state.bridgeProbe.error || '未检测到手机操控桥接'}）`)
  }

  // Allowed CIDRs & Tools & Sessions
  lines.push(`- 允许网段（${cfg.cidrRules.length} 条）：${cfg.allowedCidrs.join(', ') || '无（全部拒绝）'}`)
  if (cfg.invalidCidrs.length > 0) {
    lines.push(`- 忽略的无效网段：${cfg.invalidCidrs.join(', ')}`)
  }
  lines.push(`- 已启用工具（${enabledTools.length}/${ALL_KNOWN_TOOLS.length}）：${enabledTools.join(', ') || '无'}`)
  if (disabledTools.length > 0) {
    lines.push(`- 已关闭工具：${disabledTools.join(', ')}`)
  }
  lines.push(`- 活跃外部会话：${state.sessions.length} / ${cfg.session.maxSessions}`)

  // Reachable endpoints
  lines.push('')
  lines.push('可用连接地址：')
  if (cfg.bindHost === '127.0.0.1' || cfg.bindHost === '::1') {
    lines.push(`- 本机回环（adb forward）：${formatEndpointUrl(cfg.bindHost, port, cfg.endpointPath)}`)
  } else {
    for (const item of addrs.tailscale) {
      lines.push(`- Tailscale (${item.iface})：${formatEndpointUrl(item.address, port, cfg.endpointPath)}`)
    }
    for (const item of addrs.lan) {
      lines.push(`- 局域网 (${item.iface})：${formatEndpointUrl(item.address, port, cfg.endpointPath)}`)
    }
    lines.push(`- USB adb forward：先运行 \`adb forward tcp:${port} tcp:${port}\`，再连 ${formatEndpointUrl('127.0.0.1', port, cfg.endpointPath)}`)
  }

  lines.push('')
  lines.push('MCP 客户端配置示例（密钥请填你在插件设置里保存的值）：')
  lines.push('```json')
  lines.push(buildClientConfigSnippet(primaryUrl))
  lines.push('```')
  lines.push('提示：可用 `/phone-mcp sessions` 查看当前已连接设备，`/phone-mcp config` 仅输出配置模板。')

  return lines.join('\n')
}
