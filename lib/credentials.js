/**
 * 把 `ctx.credentials.resolve()` 的返回值统一成 token 字符串（未配置时返回 null）。
 *
 * DSH 的凭据服务签名是 `resolve(ref): Promise<{ value, source } | undefined>`；
 * 早期版本/其他 provider 可能直接给字符串。这里两种都接受，避免把配置正确的密钥
 * 误判成未配置（进而让网关一直返回 503）。
 *
 * @param {unknown} resolved
 * @returns {string | null}
 */
export function credentialValue(resolved) {
  if (typeof resolved === 'string') {
    return resolved.length > 0 ? resolved : null
  }
  if (resolved && typeof resolved === 'object' && 'value' in resolved) {
    const value = /** @type {{ value?: unknown }} */ (resolved).value
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  return null
}
