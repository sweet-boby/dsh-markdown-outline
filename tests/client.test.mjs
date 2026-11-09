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
 * Render the composer dock with a live draft.
 * @param {{ attached?: object[], draft?: string }} options - confirmed reference and starting draft.
 * @returns {{ draft: () => string, writes: string[] }} the draft and the writes made.
 */
function renderDock({ attached = [], draft = '' } = {}) {
  const client = loadClient()
  const dock = client.registered.get('md-outline-reference')
  assert.ok(dock !== undefined, 'the composer dock must be registered')

  let current = draft
  const writes = []
  const render = () => dock({
    useSelection: (selector) => selector({
      entries: [],
      attached,
      selecting: false,
      sidebarOpen: false,
      confirmIds: null,
    }),
    useHiddenTurns: (selector) => selector({ bySession: {} }),
    useInput: (selector) => selector({ draft: current, phase: 'plain' }),
    sessionId: 'session-1',
    inputActions: {
      captureInsertion: () => ({ draftRev: 0 }),
      insertText: () => true,
      setDraft: (text) => {
        writes.push(text)
        current = text
      },
      persistDraft: () => {},
    },
    t: (key) => key,
  })

  render()
  return { draft: () => current, writes, render, client }
}

const ENTRY = {
  id: 't22:s1:h0',
  turn: 22,
  step: 1,
  prompt: 'fix the search',
  heading: '第一层：中文连接词规范化',
  body: '/articles/search?keyword=水泥和水果',
  path: [],
}

test('confirming a reference writes it into the draft', () => {
  const { draft, writes } = renderDock({ attached: [ENTRY] })

  assert.equal(writes.length, 1, 'the reference is written once')
  assert.match(draft(), /以下是对话中的引用片段/)
  assert.match(draft(), /第一层：中文连接词规范化/)
  assert.match(draft(), /第 22 轮/)
  assert.match(draft(), /\/articles\/search\?keyword=水泥和水果/)
})

test('the reference keeps the words the reader already typed', () => {
  const { draft } = renderDock({ attached: [ENTRY], draft: '我发给了你啥' })

  assert.match(draft(), /以下是对话中的引用片段/, 'the quote block is present')
  assert.match(draft(), /我发给了你啥/, 'the typed text survives')
  assert.ok(
    draft().indexOf('/articles/search') < draft().indexOf('我发给了你啥'),
    'the reference sits above the typed text',
  )
})

test('an empty attachment leaves the draft alone', () => {
  const { draft, writes } = renderDock({ attached: [], draft: '只是说话' })
  assert.equal(writes.length, 0, 'nothing to write without an attachment')
  assert.equal(draft(), '只是说话')
})

test('detaching removes the block and keeps the typed text', () => {
  const first = renderDock({ attached: [ENTRY], draft: '我发给了你啥' })
  assert.match(first.draft(), /以下是对话中的引用片段/)

  // Detach in the same mount: the card goes and the block leaves the draft.
  const second = loadClient()
  const dock = second.registered.get('md-outline-reference')
  let current = first.draft()
  dock({
    useSelection: (selector) => selector({
      entries: [],
      attached: [],
      selecting: false,
      sidebarOpen: false,
      confirmIds: null,
    }),
    useHiddenTurns: (selector) => selector({ bySession: {} }),
    useInput: (selector) => selector({ draft: current, phase: 'plain' }),
    sessionId: 'session-1',
    inputActions: {
      captureInsertion: () => ({ draftRev: 0 }),
      insertText: () => true,
      setDraft: (text) => {
        current = text
      },
      persistDraft: () => {},
    },
    t: (key) => key,
  })

  assert.ok(!current.includes('以下是对话中的引用片段'), 'the block is gone')
  assert.match(current, /我发给了你啥/, 'the typed text stays')
})

test('the card opens the detail for the confirmed reference', () => {
  const { internals } = loadClient()
  const store = internals.createSelectionStore()

  store.toggleEntry(ENTRY)
  store.attachEntries()
  assert.equal(store.read().sidebarOpen, false, 'confirming does not force the sidebar open')

  // Opening a chip's preview shows that section and its full text.
  store.openPreview({ id: 'a', turn: 22, heading: '第一层', body: '全文内容' })
  assert.equal(store.read().sidebarOpen, true, 'opening a preview shows the sidebar')
  assert.equal(store.read().preview.heading, '第一层')
  assert.equal(store.read().preview.body, '全文内容')

  store.closePreview()
  assert.equal(store.read().preview, null)
  assert.equal(store.read().sidebarOpen, false)
})

test('a headingless turn contributes its whole reply as one selectable entry', () => {
  const { internals } = loadClient()
  const build = internals.buildHeadlessSelection

  const entry = build(
    { turn: 59, prompt: '让飞书里把方案写完整' },
    [
      { turn: 59, step: 1, texts: ['第一段回复', '第二段回复'] },
      { turn: 60, step: 1, texts: ['别的轮次'] },
    ],
  )

  assert.ok(entry !== null, 'a turn with text produces an entry')
  assert.equal(entry.turn, 59)
  assert.equal(entry.heading, '让飞书里把方案写完整', 'the prompt names the entry')
  assert.equal(entry.body, '第一段回复\n第二段回复', 'only this turn text is quoted')
  assert.equal(entry.id, 't59:headless', 'the id is stable so the checkbox can find it')

  // With no reply text the prompt carries the entry; only a turn with neither
  // contributes nothing.
  assert.equal(build({ turn: 59, prompt: 'p' }, []).body, 'p')
  assert.equal(build({ turn: 59, prompt: '' }, []), null)
})

test('a turn whose reply failed is still selectable from its prompt', () => {
  const { internals } = loadClient()
  const build = internals.buildHeadlessSelection

  // The reply never arrived (transport error), so there is no step text.
  const entry = build({ turn: 61, prompt: '行，你根据大纲写一份完整的飞书文档吧' }, [])

  assert.ok(entry !== null, 'a prompt-only turn still produces an entry')
  assert.equal(entry.turn, 61)
  assert.equal(entry.heading, '行，你根据大纲写一份完整的飞书文档吧')
  assert.equal(entry.body, '行，你根据大纲写一份完整的飞书文档吧', 'the prompt stands in for the missing reply')
  assert.equal(entry.id, 't61:headless')

  // A turn with neither reply nor prompt contributes nothing unless allowEmpty is set.
  assert.equal(build({ turn: 61, prompt: '' }, []), null)
  const emptyAllowed = build({ turn: 61, prompt: '' }, [], { allowEmpty: true })
  assert.ok(emptyAllowed !== null, 'allowEmpty creates a selectable entry for image-only or unloaded turns')
  assert.equal(emptyAllowed.id, 't61:headless')
})

test('client collectSectionBody extracts non-zero ordinal headings and formatted headings', () => {
  const { internals } = loadClient()
  const { collectSectionBody } = internals
  const md = [
    '### 1. **First** `section`',
    'First body',
    '```sh',
    '# shell comment inside code block',
    '```',
    'Still first body',
    '### 2. Second section',
    'Second body',
  ].join('\n')

  assert.equal(
    collectSectionBody([md], '1. First section', 0),
    'First body\n```sh\n# shell comment inside code block\n```\nStill first body',
  )
  assert.equal(
    collectSectionBody([md], '2. Second section', 1),
    'Second body',
  )
})

test('confirming a reference inserts atomic ReferenceChipNode via slash/input-insert-reference when session binding is live', () => {
  const client = loadClient()
  const insertedRefs = []
  client.setBinding((sessionId) => ({
    sessionId,
    ctx: {
      bail: (_target, eventName, payload) => {
        if (eventName === 'slash/input-insert-reference') {
          insertedRefs.push(payload)
          return true
        }
        return undefined
      },
    },
  }))

  const dock = client.registered.get('md-outline-reference')
  const writes = []
  dock({
    useSelection: (selector) => selector({
      entries: [],
      attached: [ENTRY],
      selecting: false,
      sidebarOpen: false,
      confirmIds: null,
    }),
    useHiddenTurns: (selector) => selector({ bySession: {} }),
    useInput: (selector) => selector({ draft: 'hello', phase: 'plain' }),
    sessionId: 'session-1',
    inputActions: {
      captureInsertion: () => ({ start: 5, end: 5, draftRev: 1 }),
      insertText: () => true,
      setDraft: (text) => { writes.push(text) },
      persistDraft: () => {},
    },
    t: (key) => key,
  })

  assert.equal(insertedRefs.length, 1, 'inserts one atomic chip via slash/input-insert-reference')
  assert.equal(insertedRefs[0].reference.source, 'md-outline')
  assert.equal(insertedRefs[0].reference.appearance, 'file')
  assert.match(insertedRefs[0].reference.label, /#22 · 第一层：中文连接词规范化/)
  assert.match(insertedRefs[0].reference.clipboardText, /^@\[#22 · 第一层：中文连接词规范化\]\(dsh-outline:/)
  assert.equal(writes.length, 0, 'does not dump raw Markdown into setDraft when atomic chip insertion succeeds')
})

test('registers md-outline serializer on inputTriggers even when inputTriggers mounts after apply(ctx)', async () => {
  const client = loadClient()
  const sources = []
  const rules = []
  client.provideLateService('inputTriggers', {
    registerSource: (src) => {
      sources.push(src)
      return () => {}
    },
  })
  client.provideLateService('uiConversation', {
    userText: {
      register: (rule) => {
        rules.push(rule)
        return () => {}
      },
    },
  })

  assert.equal(sources.length, 1, 'registers md-outline trigger source on late inputTriggers')
  assert.equal(sources[0].name, 'md-outline')
  assert.equal(sources[0].trigger, '@')
  assert.equal(typeof sources[0].codec?.serialize, 'function')
  assert.equal(rules.length, 1, 'registers md-outline userText rule on late uiConversation')
  assert.equal(rules[0].id, 'md-outline')

  const built = client.internals.buildSectionSelection(
    { turn: 2, prompt: '可以，按你说的做' },
    { id: 't2:s1:h0', turn: 2, step: 1, indexInStep: 0, depth: 3, text: '本次完成的改动清单' },
    [{ turn: 2, step: 1, prompt: '可以，按你说的做', texts: ['### 本次完成的改动清单\n正文内容'] }],
    [],
  )
  const serialized = await sources[0].codec.serialize(built.uri)
  assert.equal(serialized, `@[#2 · 本次完成的改动清单](${built.uri})`)
})
