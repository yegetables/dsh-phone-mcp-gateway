/**
 * Complete catalog of Android dsh-Go native phone MCP tools grouped by capability.
 * Mirrors PhoneToolCatalog.kt + DiagnosticsTool.kt (16 tools total).
 */
export const TOOL_GROUPS = Object.freeze({
  screen: Object.freeze([
    'screen',
    'collect',
    'tap',
    'type',
    'scroll',
    'key',
    'tap_xy',
    'handoff',
  ]),
  apps: Object.freeze([
    'apps',
    'open',
    'intent',
  ]),
  notify: Object.freeze(['notify']),
  clipboard: Object.freeze(['clipboard']),
  calendar: Object.freeze(['calendar_list']),
  androidShell: Object.freeze(['android_shell']),
  diagnostics: Object.freeze(['diagnostics']),
  /** 插件自己实现的对话工具（与手机上的 dsh 对话，不经过 PhoneBridge）。 */
  chat: Object.freeze(['ask_dsh']),
})

/** @type {ReadonlyMap<string, keyof typeof TOOL_GROUPS>} */
export const TOOL_TO_GROUP = new Map(
  Object.entries(TOOL_GROUPS).flatMap(([group, names]) => names.map((name) => [name, group])),
)

export const ALL_KNOWN_TOOLS = Object.freeze([...TOOL_TO_GROUP.keys()])

/**
 * Check whether a tool name is allowed by the current policy.
 *
 * @param {string} toolName
 * @param {{
 *   screen?: boolean,
 *   apps?: boolean,
 *   notify?: boolean,
 *   clipboard?: boolean,
 *   calendar?: boolean,
 *   androidShell?: boolean,
 *   diagnostics?: boolean,
 *   allowUnknownTools?: boolean,
 *   disabledTools?: readonly string[],
 * }} policy
 * @returns {boolean}
 */
export function isToolAllowed(toolName, policy) {
  if (typeof toolName !== 'string' || !toolName) return false
  const disabled = Array.isArray(policy?.disabledTools) ? policy.disabledTools : []
  for (const item of disabled) {
    if (typeof item === 'string' && item.trim() === toolName) return false
  }

  const group = TOOL_TO_GROUP.get(toolName)
  if (!group) {
    return policy?.allowUnknownTools === true
  }
  return policy?.[group] === true
}

/**
 * Filter an MCP tools/list array according to the active tool policy.
 *
 * @template {{ name?: string }} T
 * @param {readonly T[]} tools
 * @param {Parameters<typeof isToolAllowed>[1]} policy
 * @returns {T[]}
 */
export function filterTools(tools, policy) {
  if (!Array.isArray(tools)) return []
  return tools.filter((tool) => tool && typeof tool.name === 'string' && isToolAllowed(tool.name, policy))
}
