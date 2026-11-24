import { existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MANAGED_PACKAGES = new Map([
  ['@deepseek-ai/schemastery', 'lib/index.mjs'],
  ['@deepseek-ai/dsh-credentials', 'lib/index.js'],
])

function findDshNodeModules() {
  if (process.env.DSH_NODE_MODULES && existsSync(process.env.DSH_NODE_MODULES)) {
    return process.env.DSH_NODE_MODULES
  }
  try {
    const dshBin = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!dshBin) return null
    const resolvedBin = realpathSync(dshBin)
    // Walk upwards from the resolved binary to locate `@deepseek-ai/dsh/node_modules`.
    let dir = path.dirname(resolvedBin)
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules')
      if (existsSync(path.join(candidate, '@deepseek-ai', 'schemastery'))) {
        return candidate
      }
      const nested = path.join(dir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
      if (existsSync(path.join(nested, '@deepseek-ai', 'schemastery'))) {
        return nested
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Fall back to test stubs when `dsh` is not installed.
  }
  return null
}

const dshNodeModules = findDshNodeModules()

const STUB_URLS = new Map([
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-credentials', new URL('./stubs/dsh-credentials.mjs', import.meta.url).href],
])

export function resolve(specifier, context, nextResolve) {
  if (MANAGED_PACKAGES.has(specifier)) {
    const stub = { shortCircuit: true, url: STUB_URLS.get(specifier) }
    if (dshNodeModules) {
      const pkgDir = path.join(dshNodeModules, ...specifier.split('/'))
      if (existsSync(pkgDir)) {
        try {
          const result = nextResolve(specifier, {
            ...context,
            parentURL: pathToFileURL(path.join(dshNodeModules, '_anchor.mjs')).href,
          })
          // Async hooks (module.register) return a promise; sync hooks (registerHooks) return a value.
          return typeof result?.then === 'function' ? result.catch(() => stub) : result
        } catch {
          // Fall through to stub.
        }
      }
    }
    return stub
  }
  return nextResolve(specifier, context)
}
