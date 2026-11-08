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

test('no transcript rule is installed when nothing is hidden', () => {
  const { head } = renderOutline({ hiddenTurns: [] })
  const rule = head.find((element) => String(element.textContent).includes('data-chat-turn'))
  assert.equal(rule, undefined)
})
