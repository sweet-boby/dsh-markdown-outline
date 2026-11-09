/**
 * A minimal harness that loads the client half the way the browser module
 * loader does: `window.__ModuleLoader__.load({ id, factory })`, a `require`
 * that resolves only `react`, and a React stub that renders eagerly so a
 * reference error inside a component fails the test rather than the page.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/**
 * Create the recording React stub used by every client test.
 * @returns {{ React: object, rendered: string[], nodes: object[] }} the stub and its records.
 */
function createReactStub() {
  const rendered = []
  const nodes = []

  const record = (type, props, children) => {
    const name = typeof type === 'string' ? type : (type?.name ?? String(type))
    rendered.push(name)
    const node = { type: name, props: props ?? {}, children }
    nodes.push(node)
    if (typeof type === 'function') {
      // Render nested components eagerly; hook misuse is the only error a stub
      // cannot satisfy, so it is swallowed rather than reported as a failure.
      try {
        type(props ?? {})
      } catch (error) {
        if (!/hook|Invalid hook call/i.test(error.message)) throw error
      }
    }
    return node
  }

  // Refs must survive across renders of the same component instance the way
  // React's do, or an effect that keys off a ref would look stateless here and
  // pass while failing in the browser.
  let refs = []
  let refCursor = 0

  const React = {
    createElement: record,
    createPortal: (node) => node,
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      try {
        fn()
      } catch (error) {
        if (!/hook/i.test(error.message)) throw error
      }
    },
    useMemo: (fn) => fn(),
    useRef: (value) => {
      // The cursor walks the mount's slots in call order, so the second render
      // of one component sees the same object the first render created.
      if (refCursor < refs.length) {
        refCursor += 1
        return refs[refCursor - 1]
      }
      const created = { current: value }
      refs.push(created)
      refCursor += 1
      return created
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    Fragment: 'Fragment',
    /** Reset the hook slots for a new mount. */
    __mount: () => {
      refs = []
      refCursor = 0
    },
    /** Start another render of the same mounted tree. */
    __render: () => {
      refCursor = 0
    },
  }

  return { React, rendered, nodes }
}

/**
 * Load the client plugin under a fake DOM.
 * @returns {{ plugin: object, registered: Map<string, Function>, head: object[], rendered: string[] }}
 *   the plugin, its slot registrations, the style elements it appended, and the
 *   component names it rendered.
 */
export function loadClient() {
  const { React, rendered, nodes } = createReactStub()
  const head = []
  const registered = new Map()
  const injected = new Map()

  const document = {
    createElement: (tag) => {
      const element = {
        tag,
        attributes: {},
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          const index = head.indexOf(this)
          if (index !== -1) head.splice(index, 1)
        },
      }
      return element
    },
    head: {
      appendChild(element) {
        head.push(element)
      },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        loadedPlugin = factory((name) => {
          if (name !== 'react') throw new Error(`unexpected module request: ${name}`)
          return React
        })
      },
    },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }

  let loadedPlugin = null
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // The plugin's Host calls go through this indirection so a test can record
  // them without reaching into module scope.
  let fetchImpl = async () => ({ ok: true, json: async () => ({}) })
  const fetch = (url, init) => fetchImpl(url, init)

  const run = new Function('window', 'document', 'localStorage', 'fetch', source)
  run(window, document, { getItem: () => null, setItem() {} }, fetch)

  if (loadedPlugin === null) throw new Error('client factory did not produce a plugin')

  const bailed = []
  const serviceInjects = []
  let bindingImpl = () => undefined

  const ctx = {
    inject: (deps, callback) => {
      serviceInjects.push({ deps, callback })
      return () => {}
    },
    effect: (fn) => {
      try {
        fn()
      } catch (error) {
        if (!/hook/i.test(error.message)) throw error
      }
      return () => {}
    },
    locale: { register: () => () => {} },
    sessions: {
      binding: (id) => bindingImpl(id),
    },
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        const key = options.id ?? options.name
        registered.set(key, component)
        // Slots receive their hook sources from `inject()`; keeping the
        // resolved props lets a test read the very observable the component
        // subscribes to instead of a look-alike.
        if (typeof options.inject === 'function') {
          try {
            injected.set(key, options.inject(...injectArgs()))
          } catch {
            // A slot whose inject contract needs runtime arguments keeps no entry.
          }
        }
        return () => {}
      },
    },
  }
  loadedPlugin.apply(ctx)

  return {
    plugin: loadedPlugin,
    internals: loadedPlugin.internals,
    registered,
    injected,
    head,
    rendered,
    nodes,
    setFetch: (impl) => {
      fetchImpl = impl
    },
    setBinding: (impl) => {
      bindingImpl = impl
    },
    provideLateService: (name, service) => {
      ctx[name] = service
      for (const entry of serviceInjects) {
        if (entry.deps.includes(name)) {
          entry.callback(ctx)
        }
      }
    },
    bailed,
    /** Begin another render of the same mounted tree, reusing its refs. */
    __render: () => React.__render(),
  }
}

/**
 * Supply the positional arguments one slot's inject factory expects.
 * @returns {unknown[]} the session id; every slot this plugin contributes is session-scoped.
 */
function injectArgs() {
  return ['session-1']
}

/**
 * Build a projection snapshot with outline turns and an optional hidden set.
 * @param {object} options - shape options.
 * @returns {object} an `mdOutline` projection value.
 */
export function makeProjection({ turns = [], hiddenTurns = [] } = {}) {
  return { turns, hiddenTurns }
}

/**
 * Build one outline turn with a heading per entry.
 * @param {number} turn - turn number.
 * @param {ReadonlyArray<string>} headings - heading texts.
 * @returns {object} a projected turn.
 */
export function makeTurn(turn, headings) {
  return {
    turn,
    seq: turn * 100,
    prompt: `prompt ${turn}`,
    steps: [{
      step: 1,
      seq: turn * 100 + 1,
      headings: headings.map((text, index) => ({ depth: 1 + index, text })),
    }],
  }
}
