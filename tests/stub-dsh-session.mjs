/**
 * Stand-in for `@deepseek-ai/dsh-session`.
 *
 * The unit tests exercise the pure rules in `index.js`; the record writer is
 * only reached by the HTTP routes, which these tests do not drive. Recording
 * the calls keeps the seam observable if a test ever wants to assert on it.
 */

/** Every record appended through this stub, in call order. */
export const appended = []

/**
 * Record one append request.
 * @param {object} session - the target session.
 * @param {string} type - plugin record type.
 * @param {object} data - JSON payload.
 * @returns {number} the next sequence number.
 */
export function appendPluginRecord(session, type, data) {
  appended.push({ session, type, data })
  return appended.length - 1
}

export function SessionSeq(n) {
  return n
}

export function SessionLogOffset(n) {
  return n
}

export function openTurnClosers(events, cause = { kind: 'forked' }) {
  let openTurn = null
  let openStep = null
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      openTurn = ev.data?.turn ?? null
      openStep = null
    } else if (ev.type === 'turn/end') {
      openTurn = null
      openStep = null
    } else if (ev.type === 'step/start') {
      openStep = ev.data?.step ?? null
    } else if (ev.type === 'step/end') {
      openStep = null
    }
  }
  const last = events.at(-1)
  if (openTurn === null || !last) return []
  const closers = []
  let seq = last.seq + 1
  const time = last.time ?? 0
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}
