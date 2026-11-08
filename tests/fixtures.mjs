/**
 * Fixtures shared by the unit tests.
 *
 * The event logs here mirror what `@deepseek-ai/dsh-agent-loop` actually
 * appends — `turn/start`, `step/start`, the runtime-context prompt, the user
 * prompt, the assistant reply, `step/end`, `turn/end` — because the turn and
 * surface rules depend on that ordering, not on an idealized shape.
 */

/**
 * Build one assistant text block.
 * @param {string} text - Markdown body.
 * @returns {object} a content block.
 */
export function textBlock(text) {
  return { type: 'text', text };
}

/**
 * Append one event to a log, advancing the sequence number.
 * @param {object[]} log - destination log.
 * @param {string} type - event type.
 * @param {object} data - event payload.
 * @param {boolean} [surface] - whether the event joins the model-visible surface.
 * @returns {object} the appended event.
 */
function append(log, type, data, surface = false) {
  const event = { type, seq: log.length, time: 1_700_000_000_000 + log.length, data };
  if (surface) event.surfaceOp = 'append';
  log.push(event);
  return event;
}

/**
 * Build a session log of complete turns.
 *
 * Each turn carries a runtime-context message, the user prompt, and one
 * assistant reply, so a test can prove that hiding a turn removes the whole
 * exchange rather than just one message.
 * @param {ReadonlyArray<{ turn: number, prompt: string, reply: string, headings?: string }>} turns
 *   the turns to write, in order.
 * @returns {object[]} the event log.
 */
export function buildSessionLog(turns) {
  const log = [];
  for (const turn of turns) {
    append(log, 'turn/start', { turn: turn.turn });
    append(log, 'step/start', { turn: turn.turn, step: 1 });
    append(log, 'user/message', {
      id: `ctx-${turn.turn}`,
      role: 'user',
      content: [textBlock('<runtime-context/>')],
      source: { kind: 'runtime-context' },
    }, true);
    append(log, 'user/message', {
      id: `prompt-${turn.turn}`,
      role: 'user',
      content: [textBlock(turn.prompt)],
      source: { kind: 'user' },
    }, true);
    append(log, 'assistant/message', {
      turn: turn.turn,
      step: 1,
      message: {
        id: `reply-${turn.turn}`,
        role: 'assistant',
        content: [textBlock(turn.reply)],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      stream: [],
    }, true);
    append(log, 'step/end', { turn: turn.turn, step: 1 });
    append(log, 'turn/end', { turn: turn.turn, reason: { kind: 'completed' } });
  }
  return log;
}

/**
 * Append this plugin's hide record the way the hide route writes it.
 * @param {object[]} log - log to extend.
 * @param {ReadonlyArray<{ turn: number, seqs: number[] }>} turns - hidden turns with their seqs.
 * @param {string} HIDE_RECORD - the record type name.
 * @returns {object[]} the same log.
 */
export function appendHideRecord(log, turns, HIDE_RECORD) {
  log.push({
    type: HIDE_RECORD,
    seq: log.length,
    time: 1_700_000_000_000 + log.length,
    ignorable: true,
    data: { turns, hiddenAt: 1_700_000_000_001 },
  });
  return log;
}

/**
 * Append this plugin's restore record.
 * @param {object[]} log - log to extend.
 * @param {number[]} turns - restored turn numbers.
 * @param {string} RESTORE_RECORD - the record type name.
 * @returns {object[]} the same log.
 */
export function appendRestoreRecord(log, turns, RESTORE_RECORD) {
  log.push({
    type: RESTORE_RECORD,
    seq: log.length,
    time: 1_700_000_000_000 + log.length,
    ignorable: true,
    data: { turns, restoredAt: 1_700_000_000_002 },
  });
  return log;
}

/**
 * Read the text a surface node carries, for readable assertions.
 * @param {object | undefined} event - a surface event.
 * @returns {string} its first text block, or the event type.
 */
export function surfaceText(event) {
  if (event === undefined) return 'missing';
  const content = event.data?.content ?? event.data?.message?.content ?? [];
  const first = content[0];
  return first?.text ?? event.type;
}
