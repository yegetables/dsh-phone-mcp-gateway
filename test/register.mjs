import * as nodeModule from 'node:module'

if (typeof nodeModule.registerHooks === 'function') {
  const { resolve } = await import('./loader.mjs')
  nodeModule.registerHooks({ resolve })
} else {
  nodeModule.register(new URL('./loader.mjs', import.meta.url))
}
