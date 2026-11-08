/**
 * Client-layer tests: the plugin mounts, the outline drops hidden turns, and
 * the conversation hides their rows without wrapping the shipped renderers.
 *
 * Each test publishes through the plugin's own bridge component, so the outline
 * subscribes to the very observable the running page uses.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { loadClient, makeTurn } from './client-harness.mjs'

const TURNS = [
  makeTurn(1, ['First heading']),
  makeTurn(2, ['Second heading']),
  makeTurn(3, ['Third heading']),
]

/**
 * Build the selector hook a slot provides for one observable.
 * @param {object} observable - an object exposing `getSnapshot`.
 * @returns {Function} the hook.
 */
const hookOf = (observable) => (selector) => selector(observable.getSnapshot())

/**
 * A observable holding one fixed value.
 * @param {object} value - the snapshot.
 * @returns {object} an observable.
 */
const fixed = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })

/**
 * Mount the client, publish one projection through the bridge, and render the
 * outline against the bridge observable the plugin created.
 * @param {{ hiddenTurns?: number[] }} options - the projection's hidden set.
 * @returns {{ text: string[], head: object[] }} rendered strings and style elements.
 */
function renderOutline({ hiddenTurns = [] } = {}) {
  const client = loadClient()
  const bridge = client.registered.get('md-outline-session-bridge')
  assert.ok(bridge !== undefined, 'the session bridge must be registered')

  bridge({
    sessionId: 'session-1',
    useSession: hookOf(fixed({ running: false, hasMore: false })),
    useChat: hookOf(fixed({ order: [], nodes: { get: () => undefined }, navigation: { items: () => [] } })),
    useProjection: () => ({ turns: TURNS, hiddenTurns }),
    loadThrough: () => undefined,
  })

  const outline = client.registered.get('conversation.header.leading')
  assert.ok(outline !== undefined, 'the outline must be registered')
  const props = client.injected.get('conversation.header.leading')
  assert.ok(props?.hooks?.outlineBridge !== undefined, 'the outline slot must receive the bridge hook')

  outline({
    useOutlineBridge: hookOf(props.hooks.outlineBridge),
    useSelection: hookOf(fixed({ entries: [], selecting: false, sidebarOpen: false, confirmIds: null })),
    useHiddenTurns: hookOf(fixed({ bySession: {} })),
    t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
  })

  const text = []
  collectText(client.nodes, text)
  return { text, head: client.head }
}

/**
 * Collect string children from a rendered stub tree.
 *
 * The harness records every `createElement` call, including calls whose
 * children are a single node rather than a list, so traversal accepts both.
 * @param {unknown} node - a stub node, a list, or a primitive child.
 * @param {string[]} out - accumulator.
 */
function collectText(node, out) {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return
  }
  if (typeof node !== 'object') return
  collectText(node.children ?? node.c, out)
}

test('the client registers the outline, the bridge, and the composer dock', () => {
  const { registered } = loadClient()
  assert.deepEqual([...registered.keys()].sort(), [
    'conversation.header.leading',
    'md-outline-reference',
    'md-outline-session-bridge',
  ])
})

test('a hidden turn leaves the outline and the turns around it stay', () => {
  const visible = renderOutline({ hiddenTurns: [] })
  assert.ok(visible.text.includes('Second heading'), 'turn 2 renders when nothing is hidden')

  const hidden = renderOutline({ hiddenTurns: [2] })
  assert.ok(!hidden.text.includes('Second heading'), 'a hidden turn drops out of the outline')
  assert.ok(hidden.text.includes('First heading'), 'turn 1 stays')
  assert.ok(hidden.text.includes('Third heading'), 'turn 3 stays')
})

test('a hidden turn is listed under the hidden-turns section', () => {
  const { text } = renderOutline({ hiddenTurns: [2] })
  const label = text.find((entry) => entry.startsWith('hiddenTitle'))
  assert.ok(label !== undefined, 'the hidden section renders its heading with a count')
  assert.match(label, /"count":1/)
})

test('the conversation hides hidden turns by rule without wrapping renderers', () => {
  const { head } = renderOutline({ hiddenTurns: [2, 5] })
  const rule = head
    .map((element) => element.textContent)
    .find((css) => typeof css === 'string' && css.includes('data-chat-turn'))

  assert.ok(rule !== undefined, 'a transcript rule must be installed while turns are hidden')
  assert.match(rule, /\[data-chat-turn="2"\]/)
  assert.match(rule, /\[data-chat-turn="5"\]/)
  assert.match(rule, /display: none !important/)
})

test('an empty hidden set leaves the transcript sheet blank', () => {
  const { head } = renderOutline({ hiddenTurns: [] })
  const sheet = head.find((element) =>
    element.attributes['data-dsh-plugin'] === 'dsh-markdown-outline-transcript')
  assert.ok(sheet !== undefined, 'the plugin still installs its sheet')
  assert.equal(String(sheet.textContent), '', 'nothing is hidden, so the sheet carries no rule')
})

test('the hiding rule survives the outline unmounting', () => {
  // The sheet belongs to the plugin, not to a component: hiding turns keeps
  // working even when the outline column is not mounted (another session, a
  // collapsed surface, or a remount mid-render).
  const { registered, head } = loadClient()
  const bridge = registered.get('md-outline-session-bridge')

  bridge({
    sessionId: 'session-1',
    useSession: hookOf(fixed({ running: false, hasMore: false })),
    useChat: hookOf(fixed({ order: [], nodes: { get: () => undefined }, navigation: { items: () => [] } })),
    useProjection: () => ({ turns: TURNS, hiddenTurns: [22] }),
    loadThrough: () => undefined,
  })

  const sheet = head.find((element) =>
    element.attributes['data-dsh-plugin'] === 'dsh-markdown-outline-transcript')
  assert.ok(sheet !== undefined, 'the plugin installs one transcript sheet at mount')

  const outline = registered.get('conversation.header.leading')
  const props = loadClient().injected.get('conversation.header.leading')
  assert.ok(props !== undefined)

  // Rendering the outline writes into the sheet produced during apply().
  const mounted = loadClient()
  const mountedBridge = mounted.registered.get('md-outline-session-bridge')
  mountedBridge({
    sessionId: 'session-1',
    useSession: hookOf(fixed({ running: false, hasMore: false })),
    useChat: hookOf(fixed({ order: [], nodes: { get: () => undefined }, navigation: { items: () => [] } })),
    useProjection: () => ({ turns: TURNS, hiddenTurns: [22] }),
    loadThrough: () => undefined,
  })
  mounted.registered.get('conversation.header.leading')({
    useOutlineBridge: hookOf(mounted.injected.get('conversation.header.leading').hooks.outlineBridge),
    useSelection: hookOf(fixed({ entries: [], selecting: false, sidebarOpen: false, confirmIds: null })),
    useHiddenTurns: hookOf(fixed({ bySession: {} })),
    t: (key) => key,
  })

  const written = mounted.head.find((element) =>
    element.attributes['data-dsh-plugin'] === 'dsh-markdown-outline-transcript')
  assert.ok(written !== undefined, 'the sheet exists for the whole Client run')
  assert.match(String(written.textContent), /\[data-chat-turn="22"\]/)
  assert.ok(outline !== undefined)
})

/**
 * Render the composer dock with recording Host routes.
 * @param {{ entries?: object[], attached?: object[] }} options - live tick list and confirmed attachment.
 * @returns {{ posts: object[], writes: string[] }} recorded Host calls.
 */
function renderDock({ entries = [], attached = [] }) {
  const client = loadClient()
  const dock = client.registered.get('md-outline-reference')
  assert.ok(dock !== undefined, 'the composer dock must be registered')

  const posts = []
  const writes = []
  client.setFetch(async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ attached: true }) }
  })

  dock({
    useSelection: (selector) => selector({
      entries,
      attached,
      selecting: entries.length > 0,
      sidebarOpen: false,
      confirmIds: null,
    }),
    useHiddenTurns: (selector) => selector({ bySession: {} }),
    sessionId: 'session-1',
    t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
  })

  const attach = posts.filter((post) => post.url.includes('md-outline/reference')).at(-1)
  return { posts, writes, attach }
}

const ENTRY = {
  id: 't22:s1:h0',
  turn: 22,
  step: 1,
  prompt: 'fix the search',
  heading: 'First layer: Chinese tokenization',
  body: 'Merging results goes through the Go service.\n\n```text\n/articles/search?keyword=水泥\n```',
  path: [],
}

test('an unconfirmed selection never reaches the Host', () => {
  const { attach, writes } = renderDock({ entries: [ENTRY] })
  assert.equal(attach, undefined, 'ticking alone must not attach anything')
  assert.equal(writes.length, 0, 'the composer must stay plain text')
})

test('a confirmed attachment travels with the next message', () => {
  const { attach, writes } = renderDock({ attached: [ENTRY] })
  assert.ok(attach !== undefined, 'the confirmed reference is posted')
  assert.equal(attach.body.sessionId, 'session-1')
  assert.match(attach.body.text, /First layer: Chinese tokenization/)
  assert.match(attach.body.text, /Merging results goes through the Go service/)
  assert.match(attach.body.text, /第 22 轮/)
  assert.equal(writes.length, 0, 'the composer must stay plain text')
})

test('detaching posts an empty body so the Host forgets the reference', () => {
  const client = loadClient()
  const dock = client.registered.get('md-outline-reference')
  const posts = []
  client.setFetch(async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({}) }
  })

  // Drive one dock through attach then detach, the way the reader does it.
  let attached = [ENTRY]
  const render = () => dock({
    useSelection: (selector) => selector({
      entries: [],
      attached,
      selecting: false,
      sidebarOpen: false,
      confirmIds: null,
    }),
    useHiddenTurns: (selector) => selector({ bySession: {} }),
    sessionId: 'session-1',
    t: (key) => key,
  })

  render()
  const attachedPosts = posts.filter((post) => post.url.includes('reference'))
  assert.equal(attachedPosts.length, 1, 'the confirmed attachment is posted once')
  assert.match(attachedPosts[0].body.text, /First layer/)

  // Detach within the same mount: the composer card goes away and the Host is
  // told to forget the reference.
  attached = []
  client.__render()
  render()
  const detachPost = posts.filter((post) => post.url.includes('reference')).at(-1)
  assert.equal(detachPost.body.text, '', 'detaching posts an empty body')
})

test('the confirm gate keeps ticking separate from what will be sent', () => {
  const { internals } = loadClient()
  const store = internals.createSelectionStore()

  store.toggleEntry({ id: 'a', turn: 1, heading: 'A', body: '' })
  store.setSelecting(true)
  assert.equal(store.read().attached.length, 0, 'ticking alone attaches nothing')

  store.attachEntries()
  assert.equal(store.read().attached.length, 1, 'confirming attaches the ticked entry')
  assert.equal(store.read().attached[0].id, 'a')
  assert.equal(store.read().selecting, false, 'confirming leaves selection mode')

  store.toggleEntry({ id: 'b', turn: 2, heading: 'B', body: '' })
  assert.equal(store.read().attached.length, 1, 'ticking afterwards leaves the attachment alone')

  store.detach()
  assert.equal(store.read().attached.length, 0, 'detaching clears the attachment')
})
