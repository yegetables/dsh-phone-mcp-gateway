// Minimal fallback stub for @deepseek-ai/schemastery when no local DSH installation is present.
function makeNode(type, extra = {}) {
  const node = {
    type,
    meta: {},
    ...extra,
    default(v) { this.meta.default = v; return this },
    description(d) { this.meta.description = d; return this },
    volatile() { this.meta.volatile = true; return this },
    collapse() { this.meta.collapse = true; return this },
    role(r) { this.meta.role = r; return this },
    min(v) { this.meta.min = v; return this },
    max(v) { this.meta.max = v; return this },
    step(v) { this.meta.step = v; return this },
    pattern(p) { this.meta.pattern = p; return this },
    toJSON() {
      const refs = {}
      let uid = 0
      const encode = (cur) => {
        const id = ++uid
        const out = { type: cur.type, meta: { ...cur.meta } }
        if (cur.value !== undefined) out.value = cur.value
        if (cur.dict) {
          out.dict = {}
          for (const [k, v] of Object.entries(cur.dict)) out.dict[k] = encode(v)
        }
        if (cur.inner) out.inner = encode(cur.inner)
        refs[id] = out
        return id
      }
      const root = encode(this)
      return { uid: root, refs }
    },
  }
  return node
}

const z = {
  object: (dict) => makeNode('object', { dict }),
  array: (inner) => makeNode('array', { inner }),
  string: () => makeNode('string'),
  number: () => makeNode('number'),
  boolean: () => makeNode('boolean'),
  const: (value) => makeNode('const', { value }),
  any: () => makeNode('any'),
  transform: (inner, callback) => {
    const node = makeNode('transform', { inner, callback })
    return Object.assign((v) => callback(v), node)
  },
}

export default z
