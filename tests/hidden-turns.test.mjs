/**
 * Host-layer unit tests: hidden-turn folding, surface selection, run splitting,
 * and the outline projection that carries the hidden set to the client.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { internals } from '../index.js'
import {
  appendHideRecord,
  appendRestoreRecord,
  buildSessionLog,
  surfaceText,
} from './fixtures.mjs'

const {
  foldHiddenTurns,
  hiddenTurnNumbers,
  foldLiveSurface,
  surfaceSeqsOfTurns,
  splitIntoContiguousRuns,
  mdOutlineProjectionDefinition,
  renderHiddenContext,
  buildHideMessage,
  buildRestoreMessage,
  HIDE_RECORD,
  RESTORE_RECORD,
} = internals

const TURNS = [
  { turn: 1, prompt: 'question 1', reply: '# Answer one\n\nbody 1' },
  { turn: 2, prompt: 'question 2', reply: '# Answer two\n\nbody 2' },
  { turn: 3, prompt: 'question 3', reply: '# Answer three\n\nbody 3' },
  { turn: 4, prompt: 'question 4', reply: '# Answer four\n\nbody 4' },
]

/**
 * Fold one selection through the same steps the hide route uses.
 * @param {object[]} log - session log.
 * @param {number[]} picks - turn numbers to hide.
 * @returns {{ runs: Array<{ seqs: number[], turns: number[] }>, byTurn: object[] }} the plan.
 */
function planHide(log, picks) {
  // The route folds the log first and hands the live surface to the planner.
  const live = internals.foldLiveSurface(log)
  const picked = surfaceSeqsOfTurns(log, new Set(picks), live)
  return { runs: splitIntoContiguousRuns(picked.byTurn, picked.order), byTurn: picked.byTurn }
}

test('a turn owns its prompt, its runtime context, and its reply', () => {
  const log = buildSessionLog(TURNS)
  const live = internals.foldLiveSurface(log)
  const picked = surfaceSeqsOfTurns(log, new Set([2]), live)

  assert.deepEqual(picked.turns, [2])
  assert.equal(picked.byTurn.length, 1)
  const texts = picked.byTurn[0].seqs.map((seq) => surfaceText(log[seq]))
  assert.deepEqual(texts, ['<runtime-context/>', 'question 2', '# Answer two\n\nbody 2'])
})

test('unselected turns between two selected ones are never captured', () => {
  const log = buildSessionLog(TURNS)

  for (const picks of [[2], [1, 3], [2, 4], [1, 3, 4]]) {
    const { runs, byTurn } = planHide(log, picks)
    const captured = new Set(byTurn.map((entry) => entry.turn))
    assert.deepEqual([...captured].sort((a, b) => a - b), [...picks].sort((a, b) => a - b),
      `picking ${picks.join(',')} must capture exactly those turns`)

    // One `replace` shadows one surface range, so a run must be a stretch of
    // neighbouring surface positions.
    const positions = new Map(
      internals.foldLiveSurfaceOrder(log).map((seq, index) => [seq, index]),
    )
    for (const run of runs) {
      for (let i = 1; i < run.seqs.length; i++) {
        assert.equal(
          positions.get(run.seqs[i]),
          positions.get(run.seqs[i - 1]) + 1,
          'a run must be contiguous on the surface',
        )
      }
    }

    // No replaced seq may belong to an unselected turn.
    const replaced = new Set(runs.flatMap((run) => run.seqs))
    for (const seq of replaced) {
      const owner = byTurn.find((entry) => entry.seqs.includes(seq))
      assert.ok(owner !== undefined && picks.includes(owner.turn), 'replacement stayed inside the selection')
    }
  }
})

test('a gap starts a new run instead of widening the span', () => {
  const log = buildSessionLog(TURNS)

  const single = planHide(log, [2])
  assert.equal(single.runs.length, 1)

  const gapped = planHide(log, [1, 3])
  assert.equal(gapped.runs.length, 2, 'turn 2 sits between the picks and must not be swallowed')
  assert.deepEqual(gapped.runs.map((run) => run.turns), [[1], [3]])

  // With every turn selected there is no unselected node left to break the
  // surface, so one replacement covers the whole span.
  const all = planHide(log, [1, 2, 3, 4])
  assert.equal(all.runs.length, 1, 'adjacent selected turns share one range')
  assert.deepEqual(all.runs[0].turns, [1, 2, 3, 4])
})

test('the hide ledger folds hides and restores per turn', () => {
  const log = buildSessionLog(TURNS)
  appendHideRecord(log, [{ turn: 2, seqs: [9, 10, 11] }], HIDE_RECORD)

  let ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()], [2])

  appendHideRecord(log, [{ turn: 1, seqs: [2, 3] }, { turn: 3, seqs: [16, 17] }], HIDE_RECORD)
  ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()].sort((a, b) => a - b), [1, 2, 3])

  // Restoring shows the turn again but cannot return its content to the model
  // context, so the ledger keeps it and only its visibility changes.
  appendRestoreRecord(log, [2, 3], RESTORE_RECORD)
  ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()].sort((a, b) => a - b), [1, 2, 3], 'a restored turn stays in the ledger')
  assert.equal(ledger.turns.get(2).visible, true, 'the restored turn is marked visible')
  assert.equal(ledger.turns.get(1).visible, false, 'the untouched turn stays hidden')
  assert.equal(ledger.bySeq.size, 7, 'shadowed seqs stay recorded for a later hide')

  // Only currently-hidden turns are published to the outline and transcript.
  assert.deepEqual(hiddenTurnNumbers(log), [1])

  // Hiding the restored turn again returns it to the hidden set without
  // touching the context.
  appendHideRecord(log, [{ turn: 2, seqs: [9, 10, 11] }], HIDE_RECORD)
  assert.deepEqual(hiddenTurnNumbers(log), [1, 2])
})

test('the ledger ignores records without an ignorable marker', () => {
  const log = buildSessionLog(TURNS)
  log.push({
    type: HIDE_RECORD,
    seq: log.length,
    time: 0,
    data: { turns: [{ turn: 2, seqs: [9] }] },
  })

  assert.equal(foldHiddenTurns(log).turns.size, 0)
})

test('the projection carries the hidden set and survives later events', () => {
  const definition = mdOutlineProjectionDefinition
  let state = definition.init()

  for (const event of buildSessionLog(TURNS)) state = definition.apply(state, event)
  assert.deepEqual(state.hiddenTurns, [])

  state = definition.apply(state, {
    type: HIDE_RECORD,
    seq: 999,
    ignorable: true,
    data: { turns: [{ turn: 2, seqs: [9] }] },
  })
  assert.deepEqual(state.hiddenTurns, [2])

  // Every later event must carry the field forward, not just turn boundaries:
  // the assistant branch and the prompt branch both rebuild the state object.
  state = definition.apply(state, { type: 'turn/start', seq: 1000, data: { turn: 5 } })
  assert.deepEqual(state.hiddenTurns, [2], 'turn/start keeps the hidden set')

  state = definition.apply(state, {
    type: 'user/message',
    seq: 1001,
    data: { id: 'p5', role: 'user', content: [{ type: 'text', text: 'question 5' }], source: { kind: 'user' } },
  })
  assert.deepEqual(state.hiddenTurns, [2], 'user/message keeps the hidden set')

  state = definition.apply(state, {
    type: 'assistant/message',
    seq: 1002,
    data: {
      turn: 5,
      step: 1,
      message: {
        id: 'r5',
        role: 'assistant',
        content: [{ type: 'text', text: '# Answer five' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    },
  })
  assert.deepEqual(state.hiddenTurns, [2], 'assistant/message keeps the hidden set')

  state = definition.apply(state, {
    type: RESTORE_RECORD,
    seq: 1001,
    ignorable: true,
    data: { turns: [2] },
  })
  assert.deepEqual(state.hiddenTurns, [])

  const view = definition.wire.view(state)
  assert.ok(Array.isArray(view.turns), 'the wire view still carries the outline')
  assert.ok(Array.isArray(view.hiddenTurns))
})

test('the wire view exposes every heading of a turn', () => {
  const definition = mdOutlineProjectionDefinition
  let state = definition.init()
  for (const event of buildSessionLog([TURNS[0]])) state = definition.apply(state, event)

  const view = definition.wire.view(state)
  assert.equal(view.turns.length, 1)
  assert.equal(view.turns[0].turn, 1)
  assert.equal(view.turns[0].prompt, 'question 1')
  const headings = view.turns[0].steps.flatMap((step) => step.headings.map((h) => h.text))
  assert.deepEqual(headings, ['Answer one'])
})

test('the hidden context names the turns and stays empty without hides', () => {
  assert.equal(renderHiddenContext(foldHiddenTurns(buildSessionLog(TURNS))), '')

  const log = buildSessionLog(TURNS)
  appendHideRecord(log, [{ turn: 2, seqs: [9, 10, 11] }, { turn: 4, seqs: [23, 24, 25] }], HIDE_RECORD)
  const text = renderHiddenContext(foldHiddenTurns(log))

  assert.match(text, /Hidden conversation turns/)
  assert.match(text, /2, 4/)
})

test('hide and restore messages describe whole turns', () => {
  const single = buildHideMessage([2], 3).content[0].text
  assert.match(single, /turn 2/)
  assert.match(single, /prompt and the assistant's reply are both gone/)

  const plural = buildHideMessage([1, 3], 6).content[0].text
  assert.match(plural, /turns 1, 3/)
  assert.match(plural, /prompts and the assistant's replies/)

  const restore = buildRestoreMessage([2, 3]).content[0].text
  assert.match(restore, /restored turns 2, 3/)
})

test('hiding twice never offers a seq the first hide already shadowed', () => {
  const log = buildSessionLog(TURNS)

  // First hide: turn 2.
  const firstLive = internals.foldLiveSurface(log)
  const first = surfaceSeqsOfTurns(log, new Set([2]), firstLive)
  assert.ok(first.seqs.length > 0, 'the first hide finds nodes')

  // Apply the replacement the route would append.
  const run = splitIntoContiguousRuns(first.byTurn, first.order)[0]
  log.push({
    type: 'user/message',
    seq: log.length,
    time: 0,
    data: { id: 'hide1', role: 'user', content: [{ type: 'text', text: '<hidden>' }], source: { kind: 'hidden-turns' } },
    surfaceOp: { op: 'replace', startSeq: run.seqs[0], endSeq: run.seqs[run.seqs.length - 1] },
    sourceEventSeqs: run.seqs,
  })

  // Second hide of the same turn: its nodes are gone, so nothing is offered.
  const secondLive = internals.foldLiveSurface(log)
  const second = surfaceSeqsOfTurns(log, new Set([2]), secondLive)
  assert.deepEqual(second.seqs, [], 'an already hidden turn has nothing left to shadow')

  // Every seq it would offer for another turn is still on the surface.
  const third = surfaceSeqsOfTurns(log, new Set([1, 3]), secondLive)
  for (const seq of third.seqs) {
    assert.ok(secondLive.has(seq), 'offered seqs are on the live surface')
  }
  assert.ok(third.seqs.length > 0, 'unhidden turns stay hideable')
})

test('the live surface drops the replacement range and keeps its replacement', () => {
  const log = buildSessionLog([TURNS[0]])
  const before = internals.foldLiveSurface(log)
  assert.ok(before.size >= 2, 'the turn is on the surface')

  const seqs = [...before]
  log.push({
    type: 'user/message',
    seq: log.length,
    time: 0,
    data: { id: 'h', role: 'user', content: [{ type: 'text', text: '<hidden>' }], source: { kind: 'hidden-turns' } },
    surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs[seqs.length - 1] },
    sourceEventSeqs: seqs,
  })

  const after = internals.foldLiveSurface(log)
  for (const seq of seqs) assert.ok(!after.has(seq), 'shadowed nodes leave the surface')
  assert.ok(after.has(log.length - 1), 'the replacement itself is on the surface')
})

test('a turn hidden after being restored stays hidden without its context', () => {
  const log = buildSessionLog(TURNS)
  const live = internals.foldLiveSurface(log)

  // First hide takes turn 2 out of the model context.
  const picked = surfaceSeqsOfTurns(log, new Set([2]), live)
  const run = splitIntoContiguousRuns(picked.byTurn, picked.order)[0]
  log.push({
    type: 'user/message',
    seq: log.length,
    time: 0,
    data: { id: 'hide1', role: 'user', content: [{ type: 'text', text: '<hidden>' }], source: { kind: 'hidden-turns' } },
    surfaceOp: { op: 'replace', startSeq: run.seqs[0], endSeq: run.seqs[run.seqs.length - 1] },
    sourceEventSeqs: run.seqs,
  })
  appendHideRecord(log, picked.byTurn, HIDE_RECORD)
  assert.deepEqual(hiddenTurnNumbers(log), [2])

  // Restoring shows it again; the content stays out of the model context.
  appendRestoreRecord(log, [2], RESTORE_RECORD)
  assert.deepEqual(hiddenTurnNumbers(log), [], 'a restored turn is visible')
  assert.equal(foldHiddenTurns(log).turns.get(2).seqs.length > 0, true, 'its shadowed seqs are remembered')

  // Hiding it again is a UI-only change: nothing is left on the surface to
  // replace, and the ledger says the context work is already done.
  const afterRestore = internals.foldLiveSurface(log)
  const second = surfaceSeqsOfTurns(log, new Set([2]), afterRestore)
  assert.deepEqual(second.seqs, [], 'no surface work remains')

  appendHideRecord(log, [{ turn: 2, seqs: [] }], HIDE_RECORD)
  assert.deepEqual(hiddenTurnNumbers(log), [2], 'the turn is hidden again')
})

test('a reply with no headings still becomes a turn in the outline', () => {
  const definition = mdOutlineProjectionDefinition
  let state = definition.init()

  state = definition.apply(state, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  state = definition.apply(state, {
    type: 'user/message',
    seq: 2,
    data: { id: 'p1', role: 'user', content: [{ type: 'text', text: 'just talk to me' }], source: { kind: 'user' } },
  })
  state = definition.apply(state, {
    type: 'assistant/message',
    seq: 3,
    data: {
      id: 'a1',
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '好的，已经完成，没有使用任何标题。' }] },
    },
  })

  assert.equal(state.visibleTurns.length, 1, 'the turn is listed')
  assert.equal(state.visibleTurns[0].turn, 1)
  assert.deepEqual(state.visibleTurns[0].steps, [], 'it contributes no heading steps')

  // A later reply with headings keeps the headless turn listed alongside it.
  state = definition.apply(state, { type: 'turn/start', seq: 4, data: { turn: 2 } })
  state = definition.apply(state, {
    type: 'user/message',
    seq: 5,
    data: { id: 'p2', role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } },
  })
  state = definition.apply(state, {
    type: 'assistant/message',
    seq: 6,
    data: {
      id: 'a2',
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '## 有标题的一轮\n\n正文' }] },
    },
  })

  assert.deepEqual(state.visibleTurns.map((t) => t.turn), [1, 2])
  assert.equal(state.visibleTurns[1].steps[0].headings.length, 1)
})

test('a turn is listed as soon as its prompt arrives', () => {
  const definition = mdOutlineProjectionDefinition
  let state = definition.init()

  state = definition.apply(state, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  assert.deepEqual(state.visibleTurns, [], 'a fresh turn lists nothing yet')

  // The prompt alone must list the turn: its reply may carry no headings, so
  // the assistant branch is not a reliable place for it to appear.
  state = definition.apply(state, {
    type: 'user/message',
    seq: 2,
    data: { id: 'p1', role: 'user', content: [{ type: 'text', text: 'talk to me' }], source: { kind: 'user' } },
  })
  assert.deepEqual(state.visibleTurns.map((t) => t.turn), [1], 'the prompt lists the turn')
  assert.equal(state.visibleTurns[0].prompt, 'talk to me')
  assert.deepEqual(state.visibleTurns[0].steps, [])
})

test('a run follows surface order, not seq order', () => {
  // A real log can place a later turn's node near the front of the surface, so
  // the lowest and highest seqs of a selection do not bound the nodes that
  // belong together. Planning by seq then names a start that sits after its end.
  const order = [40, 41, 42, 9, 10, 11]
  const picked = {
    seqs: [9, 10, 11],
    turns: [2],
    order: [{ turn: null }, { turn: null }, { turn: null }, { turn: 2, seq: 9 }, { turn: 2, seq: 10 }, { turn: 2, seq: 11 }],
    byTurn: [{ turn: 2, seqs: [9, 10, 11] }],
  }

  const runs = splitIntoContiguousRuns(picked.byTurn, picked.order)
  assert.equal(runs.length, 1)

  const positions = new Map(order.map((seq, index) => [seq, index]))
  const start = positions.get(runs[0].seqs[0])
  const end = positions.get(runs[0].seqs[runs[0].seqs.length - 1])
  assert.ok(start < end, `the run spans ${start}..${end} in surface order`)
})

test('a later turn sitting early on the surface does not widen an earlier run', () => {
  // Turn 4 has one node at surface index 0 and the rest at the end. Selecting
  // turn 2 must not produce a range reaching back to index 0.
  const order = [107, 9, 10, 11, 108, 109, 110]
  // The collector marks nodes it did not select as boundaries, so a later
  // turn's node is a `null` entry here.
  const picked = {
    seqs: [9, 10, 11],
    turns: [2],
    order: [
      { turn: null },
      { turn: 2, seq: 9 },
      { turn: 2, seq: 10 },
      { turn: 2, seq: 11 },
      { turn: null },
      { turn: null },
      { turn: null },
    ],
    byTurn: [{ turn: 2, seqs: [9, 10, 11] }],
  }

  const runs = splitIntoContiguousRuns(picked.byTurn, picked.order)
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0].seqs, [9, 10, 11], 'the run holds only the selected turn')

  const positions = new Map(order.map((seq, index) => [seq, index]))
  const start = positions.get(runs[0].seqs[0])
  const end = positions.get(runs[0].seqs[runs[0].seqs.length - 1])
  assert.ok(start < end, `the run spans ${start}..${end} in surface order`)
})

test('an unselected turn between two selected ones breaks the run', () => {
  const log = buildSessionLog(TURNS)

  // Select turns 1 and 3 while turn 2 stays visible: one replacement must not
  // swallow turn 2.
  const live = internals.foldLiveSurface(log)
  const picked = surfaceSeqsOfTurns(log, new Set([1, 3]), live)
  const runs = splitIntoContiguousRuns(picked.byTurn, picked.order)

  assert.ok(runs.length >= 2, 'the gap splits the plan into separate runs')
  assert.deepEqual([...new Set(runs.flatMap((r) => r.turns))].sort((a, b) => a - b), [1, 3])
})
