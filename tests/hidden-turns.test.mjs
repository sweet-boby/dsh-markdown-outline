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
  const picked = surfaceSeqsOfTurns(log, new Set(picks))
  return { runs: splitIntoContiguousRuns(picked.byTurn), byTurn: picked.byTurn }
}

test('a turn owns its prompt, its runtime context, and its reply', () => {
  const log = buildSessionLog(TURNS)
  const picked = surfaceSeqsOfTurns(log, new Set([2]))

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

    // Every run must be contiguous in seq space: one `replace` shadows one range.
    for (const run of runs) {
      for (let i = 1; i < run.seqs.length; i++) {
        assert.equal(run.seqs[i], run.seqs[i - 1] + 1, 'a run must be contiguous')
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

  const all = planHide(log, [1, 2, 3, 4])
  assert.equal(all.runs.length, 4, 'boundary events between turns break seq contiguity')
})

test('the hide ledger folds hides and restores per turn', () => {
  const log = buildSessionLog(TURNS)
  appendHideRecord(log, [{ turn: 2, seqs: [9, 10, 11] }], HIDE_RECORD)

  let ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()], [2])

  appendHideRecord(log, [{ turn: 1, seqs: [2, 3] }, { turn: 3, seqs: [16, 17] }], HIDE_RECORD)
  ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()].sort((a, b) => a - b), [1, 2, 3])

  appendRestoreRecord(log, [2, 3], RESTORE_RECORD)
  ledger = foldHiddenTurns(log)
  assert.deepEqual([...ledger.turns.keys()], [1])
  assert.equal(ledger.bySeq.size, 2, 'restored turns drop their seqs from the shadow map')
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

test('only the newest reference attachment is pending', () => {
  const log = buildSessionLog(TURNS)
  assert.equal(internals.foldPendingReference(log), undefined, 'nothing pending without a record')

  const push = (text) => {
    log.push({
      type: internals.REFERENCE_RECORD,
      seq: log.length,
      time: 0,
      ignorable: true,
      data: { text, at: 0 },
    })
  }

  push('<md-outline-reference>A</md-outline-reference>')
  assert.equal(internals.foldPendingReference(log).text, '<md-outline-reference>A</md-outline-reference>')

  push('<md-outline-reference>B</md-outline-reference>')
  assert.match(internals.foldPendingReference(log).text, /B/, 'the newest attachment wins')

  push('   ')
  assert.equal(internals.foldPendingReference(log), undefined, 'a blank body detaches the reference')
})

test('a reference without the ignorable marker is ignored', () => {
  const log = buildSessionLog(TURNS)
  log.push({
    type: internals.REFERENCE_RECORD,
    seq: log.length,
    time: 0,
    data: { text: 'forged' },
  })
  assert.equal(internals.foldPendingReference(log), undefined)
})
