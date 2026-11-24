// Minimal fallback stub for @deepseek-ai/dsh-credentials when no local DSH installation is present.
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function credentialRef(value) {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value
}
