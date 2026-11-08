/**
 * Host half of dsh-markdown-outline.
 *
 * Registers the optional `mdOutline` session-projection unit so the Client
 * receives Markdown headings across the entire Session log, including turns
 * outside the currently paged browser event window. It also owns the routes
 * that change what the model sees: hiding whole turns from the model-visible
 * surface, and restoring them.
 *
 * A hide is an append-only surface replacement, never a log edit: the selected
 * turns are shadowed by one user message recording what was removed, so the
 * transcript stays replayable and the same range can be unhidden later. The
 * durable ledger of hides is this plugin's own ignorable records, read back on
 * every observation and carried into each request as one prompt context.
 */

import { appendPluginRecord } from '@deepseek-ai/dsh-session';

const PROMPT_PREVIEW_LIMIT = 60;
const HEADING_TEXT_LIMIT = 140;
const MAX_HEADINGS_PER_SESSION = 600;

/**
 * Strip inline Markdown formatting to produce plain outline label text.
 * @param {string} raw
 * @returns {string}
 */
function cleanHeadingText(raw) {
  let s = raw.trim();
  if (s === '') return '';
  // Code spans first (preserve inner text, strip backticks)
  s = s.replace(/(`+)([\s\S]*?)\1/g, '$2');
  // Images ![alt](url) -> alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline links [label](url) and reference links [label][ref] -> label
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  // Autolinks <https://...>
  s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
  // Strong / emphasis / strikethrough markers
  s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
  // Escaped ASCII punctuation
  s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > HEADING_TEXT_LIMIT) {
    return `${s.slice(0, HEADING_TEXT_LIMIT - 1).trimEnd()}…`;
  }
  return s;
}

/**
 * Check whether a line cannot start a plain paragraph for Setext heading detection.
 * @param {string} line
 * @returns {boolean}
 */
function isNonParagraphLine(line) {
  return (
    /^\s*$/.test(line) ||
    /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(line) ||
    /^ {0,3}(?:[-*_][ \t]*){3,}$/.test(line) ||
    /^ {0,3}(?:`{3,}|~{3,})/.test(line)
  );
}

/**
 * Extract ordered CommonMark/GFM headings from one Markdown text block.
 * @param {string} markdown
 * @param {number} maxRemaining
 * @returns {Array<{ depth: number, text: string }>}
 */
function extractBlockHeadings(markdown, maxRemaining) {
  if (!markdown || maxRemaining <= 0) return [];
  const lines = markdown.split(/\r?\n/);
  const result = [];
  let fenceChar = '';
  let fenceLen = 0;
  let paragraphLines = [];

  for (let i = 0; i < lines.length; i++) {
    if (result.length >= maxRemaining) break;
    const line = lines[i] ?? '';

    if (fenceChar !== '') {
      const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closeMatch !== null &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLen
      ) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      openFence !== null &&
      !(openFence[1][0] === '`' && openFence[2].includes('`'))
    ) {
      fenceChar = openFence[1][0];
      fenceLen = openFence[1].length;
      paragraphLines = [];
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx !== null) {
      const body = atx[2] ?? '';
      // Bare `#hashtag` without space after `#` is not an ATX heading
      const afterHashes = line.replace(/^ {0,3}#{1,6}/, '');
      if (afterHashes === '' || /^[ \t]/.test(afterHashes)) {
        paragraphLines = [];
        const rawBody = body.replace(/^#+[ \t]*$/, '');
        const text = cleanHeadingText(rawBody);
        if (text !== '') {
          result.push({ depth: atx[1].length, text });
        }
        continue;
      }
    }

    if (paragraphLines.length > 0) {
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (setext !== null) {
        const depth = setext[1][0] === '=' ? 1 : 2;
        const text = cleanHeadingText(paragraphLines.join(' '));
        paragraphLines = [];
        if (text !== '') {
          result.push({ depth, text });
        }
        continue;
      }
    }

    if (isNonParagraphLine(line)) {
      paragraphLines = [];
    } else {
      paragraphLines.push(line.trim());
    }
  }

  return result;
}

/**
 * Extract bounded prompt preview from user message content blocks.
 * @param {ReadonlyArray<{ type: string, text?: string }>} content
 * @returns {string}
 */
function previewPrompt(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  let unread = false;
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (text.length >= PROMPT_PREVIEW_LIMIT * 2) {
      unread = true;
      break;
    }
    const clipped = block.text.length > PROMPT_PREVIEW_LIMIT * 2;
    const chunk = clipped ? block.text.slice(0, PROMPT_PREVIEW_LIMIT * 2) : block.text;
    text += text === '' ? chunk : ` ${chunk}`;
    if (clipped) {
      unread = true;
      break;
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length > PROMPT_PREVIEW_LIMIT - 1) {
    return `${normalized.slice(0, PROMPT_PREVIEW_LIMIT - 1).trimEnd()}…`;
  }
  return unread && normalized !== '' ? `${normalized}…` : normalized;
}

/**
 * Validate one projected turn outline entry.
 * @param {unknown} turnEntry
 */
function assertValidTurnEntry(turnEntry) {
  if (typeof turnEntry !== 'object' || turnEntry === null) {
    throw new Error('mdOutline entry must be an object');
  }
  if (
    typeof turnEntry.turn !== 'number' ||
    !Number.isInteger(turnEntry.turn) ||
    turnEntry.turn < 0 ||
    typeof turnEntry.seq !== 'number' ||
    !Number.isInteger(turnEntry.seq) ||
    turnEntry.seq < 0 ||
    typeof turnEntry.prompt !== 'string' ||
    !Array.isArray(turnEntry.steps)
  ) {
    throw new Error('mdOutline entry has invalid fields');
  }
  for (const step of turnEntry.steps) {
    if (
      typeof step !== 'object' ||
      step === null ||
      typeof step.step !== 'number' ||
      !Number.isInteger(step.step) ||
      typeof step.seq !== 'number' ||
      !Array.isArray(step.headings)
    ) {
      throw new Error('mdOutline step has invalid fields');
    }
    for (const h of step.headings) {
      if (
        typeof h !== 'object' ||
        h === null ||
        typeof h.depth !== 'number' ||
        h.depth < 1 ||
        h.depth > 6 ||
        typeof h.text !== 'string'
      ) {
        throw new Error('mdOutline heading has invalid fields');
      }
    }
  }
}

/** Turn numbers the user hid; the client filters these out of both the outline and the transcript. */
function assertValidHiddenTurns(list) {
  if (!Array.isArray(list)) throw new Error('mdOutline hiddenTurns must be an array');
  for (const turn of list) {
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
      throw new Error('mdOutline hiddenTurns must hold non-negative integers');
    }
  }
}

const viewSchema = {
  parse(val) {
    if (typeof val !== 'object' || val === null) throw new Error('mdOutline view must be an object');
    if (!Array.isArray(val.turns)) throw new Error('mdOutline view requires a turns array');
    for (const item of val.turns) assertValidTurnEntry(item);
    assertValidHiddenTurns(val.hiddenTurns ?? []);
    return val;
  },
};

const stateSchema = {
  parse(val) {
    if (typeof val !== 'object' || val === null) {
      throw new Error('mdOutline state must be an object');
    }
    if (!Array.isArray(val.allTurns) || !Array.isArray(val.visibleTurns)) {
      throw new Error('mdOutline state requires allTurns and visibleTurns arrays');
    }
    for (const item of val.allTurns) assertValidTurnEntry(item);
    for (const item of val.visibleTurns) assertValidTurnEntry(item);
    assertValidHiddenTurns(val.hiddenTurns ?? []);
    return val;
  },
};

/** This plugin's own durable record types, under its package name. */
const HIDE_RECORD = 'plugin:dsh-markdown-outline/hidden-turn';
const RESTORE_RECORD = 'plugin:dsh-markdown-outline/hidden-turn-restored';

/**
 * The record names the projection folds, so hiding takes effect in the UI the
 * same way it takes effect for the model.
 */

const EMPTY_TURNS = Object.freeze([]);
const EMPTY_STATE = Object.freeze({
  allTurns: EMPTY_TURNS,
  visibleTurns: EMPTY_TURNS,
  hiddenTurns: EMPTY_TURNS,
});

function countTotalHeadings(turns) {
  let count = 0;
  for (const t of turns) {
    for (const s of t.steps) count += s.headings.length;
  }
  return count;
}

const mdOutlineProjectionDefinition = {
  key: 'mdOutline',
  stateVersion: 1,
  stateSchema,
  init: () => EMPTY_STATE,
  apply(state, event) {
    switch (event.type) {
      case 'turn/start': {
        const turnNum = event.data?.turn;
        if (typeof turnNum !== 'number') return state;
        const last = state.allTurns.at(-1);
        if (last !== undefined && turnNum <= last.turn) return state;
        return {
          ...state,
          allTurns: [
            ...state.allTurns,
            { turn: turnNum, seq: event.seq, prompt: '', steps: [] },
          ],
        };
      }
      case 'user/message': {
        if (event.data?.source?.kind !== 'user') return state;
        const last = state.allTurns.at(-1);
        if (last === undefined || last.prompt !== '') return state;
        const prompt = previewPrompt(event.data.content);
        if (prompt === '') return state;
        const updatedTurn = { ...last, prompt };
        const nextAll = [...state.allTurns.slice(0, -1), updatedTurn];
        if (last.steps.length === 0) {
          return { ...state, allTurns: nextAll };
        }
        const nextVisible = state.visibleTurns.map((t) =>
          t.turn === updatedTurn.turn ? updatedTurn : t,
        );
        return { ...state, allTurns: nextAll, visibleTurns: nextVisible };
      }
      case 'assistant/message': {
        const turnNum = event.data?.turn;
        const stepNum = event.data?.step;
        const content = event.data?.message?.content;
        if (
          typeof turnNum !== 'number' ||
          typeof stepNum !== 'number' ||
          !Array.isArray(content)
        ) {
          return state;
        }
        const turnIdx = state.allTurns.findIndex((t) => t.turn === turnNum);
        const currentTotal = countTotalHeadings(state.visibleTurns);
        const existingTurn = turnIdx >= 0 ? state.allTurns[turnIdx] : undefined;
        const existingStep = existingTurn?.steps.find((s) => s.step === stepNum);
        const budget =
          MAX_HEADINGS_PER_SESSION -
          currentTotal +
          (existingStep ? existingStep.headings.length : 0);
        if (budget <= 0 && existingStep === undefined) return state;

        const headings = [];
        for (const block of content) {
          if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
          const rem = budget - headings.length;
          if (rem <= 0) break;
          const parsed = extractBlockHeadings(block.text, rem);
          for (const h of parsed) headings.push(h);
        }

        if (headings.length === 0 && existingStep === undefined) return state;

        let nextAll;
        if (existingTurn === undefined) {
          if (headings.length === 0) return state;
          const newTurn = {
            turn: turnNum,
            seq: event.seq,
            prompt: '',
            steps: [{ step: stepNum, seq: event.seq, headings }],
          };
          nextAll = [...state.allTurns, newTurn].sort((a, b) => a.turn - b.turn);
        } else {
          const otherSteps = existingTurn.steps.filter((s) => s.step !== stepNum);
          const nextSteps =
            headings.length === 0
              ? otherSteps
              : [...otherSteps, { step: stepNum, seq: event.seq, headings }].sort(
                  (a, b) => a.step - b.step,
                );
          const updatedTurn = { ...existingTurn, steps: nextSteps };
          nextAll = state.allTurns.map((t, idx) =>
            idx === turnIdx ? updatedTurn : t,
          );
        }

        const nextVisible = nextAll.filter((t) => t.steps.length > 0);
        if (nextVisible.length === 0 && state.visibleTurns.length === 0) {
          return { ...state, allTurns: nextAll };
        }
        return { ...state, allTurns: nextAll, visibleTurns: nextVisible };
      }
      case HIDE_RECORD: {
        const items = Array.isArray(event.data?.turns) ? event.data.turns : [];
        const added = items
          .map((item) => item?.turn)
          .filter((turn) => typeof turn === 'number' && Number.isInteger(turn));
        if (added.length === 0) return state;
        const next = new Set(state.hiddenTurns);
        for (const turn of added) next.add(turn);
        return { ...state, hiddenTurns: [...next].sort((a, b) => a - b) };
      }
      case RESTORE_RECORD: {
        const turns = Array.isArray(event.data?.turns) ? event.data.turns : [];
        if (turns.length === 0) return state;
        const next = new Set(state.hiddenTurns);
        for (const turn of turns) next.delete(turn);
        return { ...state, hiddenTurns: [...next].sort((a, b) => a - b) };
      }
      default:
        return state;
    }
  },
  wire: {
    viewSchema,
    view: (state) => ({ turns: state.visibleTurns, hiddenTurns: state.hiddenTurns }),
  },
};

const SEARCH_ROUTE_PATH = '/md-outline/search';
const HIDE_ROUTE_PATH = '/md-outline/hide';
const RESTORE_ROUTE_PATH = '/md-outline/restore';

const MAX_BODY_HITS = 80;
const SNIPPET_RADIUS = 36;

/**
 * Strip inline Markdown syntax while keeping readable prose for snippet previews.
 * @param {string} raw
 * @returns {string}
 */
function stripInlineMarkdown(raw) {
  let s = raw.trim();
  if (s === '') return '';
  s = s.replace(/(`+)([\s\S]*?)\1/g, '$2');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
  s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
  s = s.replace(/^ {0,3}(?:>\s*)+/, '');
  s = s.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Build a compact snippet centered around the first case-insensitive keyword match.
 * @param {string} text
 * @param {string} needleLower
 * @returns {{ snippet: string, matchStart: number, matchLength: number, needleText: string } | null}
 */
function buildMatchSnippet(text, needleLower) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(needleLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + needleLower.length + SNIPPET_RADIUS + 18);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const slice = text.slice(start, end);
  return {
    snippet: `${prefix}${slice}${suffix}`,
    matchStart: prefix.length + (idx - start),
    matchLength: needleLower.length,
    needleText: text.slice(idx, idx + needleLower.length),
  };
}

/**
 * Extract body (non-heading) keyword hits from one Markdown text block,
 * tracking the nearest preceding heading index in the step (`sectionIndex`).
 * @param {string} markdown
 * @param {string} needleLower
 * @param {number} initialHeadingCount
 * @param {number} maxHits
 * @returns {{ headingCount: number, hits: Array<{ sectionIndex: number, snippet: string, matchStart: number, matchLength: number, needleText: string, anchorPhrase: string }> }}
 */
function searchBlockBody(markdown, needleLower, initialHeadingCount, maxHits) {
  if (!markdown || maxHits <= 0) {
    return { headingCount: initialHeadingCount, hits: [] };
  }
  const lines = markdown.split(/\r?\n/);
  const hits = [];
  let headingCount = initialHeadingCount;
  let fenceChar = '';
  let fenceLen = 0;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const joined = stripInlineMarkdown(paragraphLines.join(' '));
    paragraphLines = [];
    if (joined === '' || hits.length >= maxHits) return;
    const match = buildMatchSnippet(joined, needleLower);
    if (match) {
      hits.push({
        sectionIndex: headingCount - 1,
        ...match,
        anchorPhrase: joined.slice(
          Math.max(0, joined.toLowerCase().indexOf(needleLower) - 10),
          Math.min(joined.length, joined.toLowerCase().indexOf(needleLower) + needleLower.length + 18),
        ),
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (fenceChar !== '') {
      const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closeMatch !== null &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLen
      ) {
        fenceChar = '';
        fenceLen = 0;
      } else if (hits.length < maxHits) {
        const trimmedCode = line.trim();
        if (trimmedCode !== '') {
          const match = buildMatchSnippet(trimmedCode, needleLower);
          if (match) {
            hits.push({
              sectionIndex: headingCount - 1,
              ...match,
              anchorPhrase: trimmedCode.slice(0, 48),
            });
          }
        }
      }
      continue;
    }

    const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (
      openFence !== null &&
      !(openFence[1][0] === '`' && openFence[2].includes('`'))
    ) {
      flushParagraph();
      fenceChar = openFence[1][0];
      fenceLen = openFence[1].length;
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx !== null) {
      const afterHashes = line.replace(/^ {0,3}#{1,6}/, '');
      if (afterHashes === '' || /^[ \t]/.test(afterHashes)) {
        flushParagraph();
        const rawBody = (atx[2] ?? '').replace(/^#+[ \t]*$/, '');
        const text = cleanHeadingText(rawBody);
        if (text !== '') headingCount += 1;
        continue;
      }
    }

    if (paragraphLines.length > 0) {
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (setext !== null) {
        const text = cleanHeadingText(paragraphLines.join(' '));
        paragraphLines = [];
        if (text !== '') headingCount += 1;
        continue;
      }
    }

    // List items, blockquotes, and table rows flush per line so snippets stay localized
    if (/^\s*$/.test(line) || /^ {0,3}(?:[-*_][ \t]*){3,}$/.test(line)) {
      flushParagraph();
    } else if (
      /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line) ||
      /^ {0,3}>/.test(line) ||
      line.includes('|')
    ) {
      flushParagraph();
      if (hits.length < maxHits) {
        const cleaned = stripInlineMarkdown(line.replace(/^\|+|\|+$/g, ' '));
        if (cleaned !== '' && !/^[-:\s|]+$/.test(cleaned)) {
          const match = buildMatchSnippet(cleaned, needleLower);
          if (match) {
            const pos = cleaned.toLowerCase().indexOf(needleLower);
            hits.push({
              sectionIndex: headingCount - 1,
              ...match,
              anchorPhrase: cleaned.slice(
                Math.max(0, pos - 10),
                Math.min(cleaned.length, pos + needleLower.length + 18),
              ),
            });
          }
        }
      }
    } else {
      paragraphLines.push(line.trim());
    }
  }
  flushParagraph();

  return { headingCount, hits };
}

/**
 * Search all non-reasoning assistant replies across one complete Session event log.
 * @param {ReadonlyArray<any>} events
 * @param {string} rawQuery
 */
function searchSessionAssistantEvents(events, rawQuery) {
  const query = rawQuery.trim();
  if (query === '') return { hits: [], truncated: false };
  const needleLower = query.toLowerCase();

  const turnMeta = new Map();
  const stepMap = new Map();

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'turn/start') {
      const turnNum = event.data?.turn;
      if (typeof turnNum === 'number' && !turnMeta.has(turnNum)) {
        turnMeta.set(turnNum, { turn: turnNum, seq: event.seq, prompt: '' });
      }
    } else if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue;
      let latestMeta = null;
      for (const m of turnMeta.values()) latestMeta = m;
      if (latestMeta && latestMeta.prompt === '') {
        latestMeta.prompt = previewPrompt(event.data.content);
      }
    } else if (event.type === 'assistant/message') {
      const turnNum = event.data?.turn;
      const stepNum = event.data?.step;
      const content = event.data?.message?.content;
      if (typeof turnNum !== 'number' || typeof stepNum !== 'number' || !Array.isArray(content)) {
        continue;
      }
      if (!turnMeta.has(turnNum)) {
        turnMeta.set(turnNum, { turn: turnNum, seq: event.seq, prompt: '' });
      }
      // Latest settled assistant message for (turn, step) wins over earlier retries
      stepMap.set(`${turnNum}:${stepNum}`, {
        turn: turnNum,
        step: stepNum,
        seq: event.seq,
        content,
      });
    }
  }

  const hits = [];
  let truncated = false;
  const orderedSteps = [...stepMap.values()].sort(
    (a, b) => a.turn - b.turn || a.step - b.step,
  );

  for (const entry of orderedSteps) {
    if (hits.length >= MAX_BODY_HITS) {
      truncated = true;
      break;
    }
    let headingCount = 0;
    let hitOrdinalInStep = 0;
    const meta = turnMeta.get(entry.turn);
    for (const block of entry.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const remaining = MAX_BODY_HITS - hits.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const res = searchBlockBody(block.text, needleLower, headingCount, remaining);
      headingCount = res.headingCount;
      for (const h of res.hits) {
        hits.push({
          id: `body:t${entry.turn}:s${entry.step}:m${hitOrdinalInStep++}`,
          turn: entry.turn,
          step: entry.step,
          turnStartSeq: meta?.seq ?? entry.seq,
          prompt: meta?.prompt ?? '',
          sectionIndex: h.sectionIndex,
          snippet: h.snippet,
          matchStart: h.matchStart,
          matchLength: h.matchLength,
          needleText: h.needleText,
          anchorPhrase: h.anchorPhrase,
        });
      }
    }
  }

  return { hits, truncated };
}

// ---------------------------------------------------------------------------
// Turn hiding.
//
// A hide replaces the surface range covering selected turns with one user
// message that records what went out, so the request stops carrying them. The
// log itself is untouched, which is what lets the same range be restored.
// ---------------------------------------------------------------------------

/** This plugin's own durable record types, under its package name. */

/** Prompt-context name and placement for the running hidden-turn ledger. */
const HIDDEN_CONTEXT_NAME = 'md-outline:hidden-turns';
const HIDDEN_CONTEXT_ORDER = 115.5;

/** Body ceiling for the two mutating routes; both take small JSON objects. */
const MAX_BODY_BYTES = 64 * 1024;

/** Longest reference body accepted in one request, in characters. */
const MAX_REFERENCE_CHARS = 120_000;

/**
 * Read a bounded request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>} the body, or null past {@link MAX_BODY_BYTES}.
 */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Parse a request body as a JSON object.
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    // A non-JSON body is exactly the null case; nothing else can be reported.
    void error;
    return null;
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null;
}

/**
 * Read this plugin's hide ledger from one event log.
 *
 * Each hide adds its turn numbers and the surface seqs it shadowed; a restore
 * removes them again. The result therefore describes the current model-visible
 * hiding exactly, including after a reload.
 * @param {ReadonlyArray<any>} events
 * @returns {{ turns: Map<number, { turn: number, hideSeq: number, seqs: number[] }>, bySeq: Map<number, number>, seq: number }}
 *   hidden turns by number, the turn that owns each shadowed seq, and the last ledger seq.
 */
function foldHiddenTurns(events) {
  const turns = new Map();
  const bySeq = new Map();
  let lastSeq = -1;

  const unlink = (turn) => {
    const entry = turns.get(turn);
    if (entry === undefined) return;
    for (const seq of entry.seqs) bySeq.delete(seq);
    turns.delete(turn);
  };

  for (const event of events) {
    if (event?.type !== HIDE_RECORD && event?.type !== RESTORE_RECORD) continue;
    if (event.ignorable !== true) continue;
    const data = event.data;
    if (typeof data !== 'object' || data === null) continue;
    if (!Array.isArray(data.turns)) continue;
    lastSeq = Math.max(lastSeq, event.seq);
    if (event.type === HIDE_RECORD) {
      for (const item of data.turns) {
        if (typeof item?.turn !== 'number' || !Array.isArray(item.seqs)) continue;
        unlink(item.turn);
        const seqs = item.seqs.filter((seq) => typeof seq === 'number');
        for (const seq of seqs) bySeq.set(seq, item.turn);
        turns.set(item.turn, { turn: item.turn, hideSeq: event.seq, seqs });
      }
    } else {
      for (const turn of data.turns) {
        if (typeof turn === 'number') unlink(turn);
      }
    }
  }

  return { turns, bySeq, seq: lastSeq };
}

/**
 * Collect the surface seqs belonging to selected turns.
 *
 * A turn owns every surface node at or after its `turn/start` and before the
 * next turn boundary, so the caller can shadow a contiguous range without
 * slicing a turn in half.
 * @param {ReadonlyArray<any>} events
 * @param {ReadonlySet<number>} selectedTurns
 * @returns {{ seqs: number[], turns: number[], byTurn: Array<{ turn: number, seqs: number[] }> }}
 *   shadowable seqs in log order, the turn numbers actually covered, and the seqs each owns.
 */
function surfaceSeqsOfTurns(events, selectedTurns) {
  const surfaceTypes = new Set([
    'system/message',
    'developer/message',
    'user/message',
    'assistant/message',
    'tool/result',
  ]);
  let currentTurn = null;
  const seqs = [];
  const owned = new Map();

  for (const event of events) {
    if (event?.type === 'turn/start') {
      const turn = event.data?.turn;
      currentTurn = typeof turn === 'number' ? turn : null;
      continue;
    }
    if (currentTurn === null || !selectedTurns.has(currentTurn)) continue;
    if (!surfaceTypes.has(event.type) || event.surfaceOp === undefined) continue;
    seqs.push(event.seq);
    const list = owned.get(currentTurn);
    if (list === undefined) owned.set(currentTurn, [event.seq]);
    else list.push(event.seq);
  }

  const turns = [...owned.keys()].sort((a, b) => a - b);
  return { seqs, turns, byTurn: turns.map((turn) => ({ turn, seqs: owned.get(turn) })) };
}

/**
 * Group owned seqs into the contiguous runs one `replace` operation can shadow.
 *
 * `surfaceOp: { op: 'replace' }` shadows exactly one inclusive range of current
 * surface nodes, so an unselected turn sitting between two selected turns would
 * be swallowed by a single span. Splitting on gaps keeps every unselected turn
 * out of the replacement, which is what "hide only the ticked turns" means.
 * @param {ReadonlyArray<{ turn: number, seqs: readonly number[] }>} byTurn
 *   selected turns with the seqs each owns, in log order.
 * @returns {Array<{ seqs: number[], turns: number[] }>} one run per contiguous span.
 */
function splitIntoContiguousRuns(byTurn) {
  const runs = [];
  let current = null;
  for (const entry of byTurn) {
    const first = entry.seqs[0];
    const last = entry.seqs[entry.seqs.length - 1];
    if (first === undefined || last === undefined) continue;
    if (current !== null && first === current.last + 1) {
      current.seqs.push(...entry.seqs);
      current.turns.push(entry.turn);
      current.last = last;
      continue;
    }
    current = { seqs: [...entry.seqs], turns: [entry.turn], last };
    runs.push(current);
  }
  return runs.map((run) => ({ seqs: run.seqs, turns: run.turns }));
}

/**
 * Render the hidden-turn ledger as the runtime context the model reads.
 * @param {ReturnType<typeof foldHiddenTurns>} ledger
 * @returns {string} the context text, or '' when nothing is hidden.
 */
function renderHiddenContext(ledger) {
  if (ledger.turns.size === 0) return '';
  const turns = [...ledger.turns.keys()].sort((a, b) => a - b);
  return [
    '## Hidden conversation turns',
    '',
    'The user hid the following turns from this conversation. Their messages are absent from the history above, and the model cannot read them.',
    `Hidden turn numbers: ${turns.join(', ')}.`,
    'Do not claim to remember them, and do not ask the user to repeat them unless the current request depends on what they contained.',
  ].join('\n');
}

/**
 * Build the user message that replaces a hidden range.
 * @param {readonly number[]} turns - hidden turn numbers.
 * @param {number} shadowedCount - how many surface nodes the replacement shadows.
 * @returns {object} a user message for `session.append`.
 */
function buildHideMessage(turns, shadowedCount) {
  const plural = turns.length === 1 ? '' : 's';
  return {
    id: `md-outline-hidden-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{
      type: 'text',
      text: [
        `<hidden-turns count="${turns.length}" shadowed="${shadowedCount}">`,
        `The user hid turn${plural} ${turns.join(', ')} from this conversation.`,
        `Turn${plural} ${turns.join(', ')}: the user's prompt${plural} and the assistant's repl${turns.length === 1 ? 'y' : 'ies'} are both gone from the history.`,
        'Do not reference, quote, summarize, or claim to remember them.',
        '</hidden-turns>',
      ].join('\n'),
    }],
    source: { kind: 'hidden-turns', plugin: 'dsh-markdown-outline', turns: [...turns] },
  };
}

/**
 * Build the bridge message that marks a restored range as visible again.
 * @param {readonly number[]} turns - restored turn numbers.
 * @returns {object} a user message for `session.append`.
 */
function buildRestoreMessage(turns) {
  return {
    id: `md-outline-restored-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{
      type: 'text',
      text: [
        `<restored-turns count="${turns.length}">`,
        `The user restored turn${turns.length === 1 ? '' : 's'} ${turns.join(', ')}.`,
        'Earlier hidden-turn records no longer apply to them.',
        '</restored-turns>',
      ].join('\n'),
    }],
    source: { kind: 'hidden-turns', plugin: 'dsh-markdown-outline', turns: [...turns] },
  };
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Mount the Host-side session projection unit, the whole-session body search
 * route, the hidden-turn context provider, and the two routes that hide and
 * restore turns.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {

  ctx.inject(['sessionProjections'], (scope) => {
    scope.sessionProjections.register(mdOutlineProjectionDefinition);
  });

  // The hidden-turn ledger is a runtime context. DSH prompt providers are
  // synchronous, so fold the live session log into a small per-session cache
  // and invalidate it when this plugin appends a hide or restore record.
  ctx.inject(['systemPrompt'], (scope) => {
    /** Per-session ledger cache; a WeakMap follows the live Session lifetime. */
    const hiddenBySession = new WeakMap();

    const ledgerOf = (session) => {
      const cached = hiddenBySession.get(session);
      if (cached !== undefined && cached.throughSeq >= session.seq - 1) return cached.ledger;
      const ledger = foldHiddenTurns(session.snapshotEvents());
      hiddenBySession.set(session, { throughSeq: session.seq - 1, ledger });
      return ledger;
    };

    scope.on('session/event', (session, event) => {
      if (event.type === HIDE_RECORD || event.type === RESTORE_RECORD) {
        hiddenBySession.delete(session);
      }
    });

    scope.systemPrompt.context({
      name: HIDDEN_CONTEXT_NAME,
      order: HIDDEN_CONTEXT_ORDER,
      interpolate: false,
      text: ({ agent }) => agent === undefined ? '' : renderHiddenContext(ledgerOf(agent.session)),
    });
  });

  ctx.inject(['webServer', 'connection', 'sessions', 'sessionQuery'], (scope) => {
    const reject = (req, res) => {
      const rejection = scope.connection.requestRejection(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    };

    const readBody = async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.end();
        return null;
      }
      const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
        return null;
      }
      let text;
      try {
        text = await readBoundedBody(req);
      } catch (error) {
        // The socket failed mid-body, so there is nothing left to validate.
        void error;
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' });
        return null;
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' });
        return null;
      }
      const body = parseJsonObject(text);
      if (body === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be a JSON object' });
        return null;
      }
      if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
        sendJson(res, 400, { code: 'bad-request', message: 'sessionId is required' });
        return null;
      }
      return { sessionId: body.sessionId.trim(), body };
    };

    const integerList = (value) =>
      Array.isArray(value)
        ? [...new Set(value.filter((item) => typeof item === 'number' && Number.isInteger(item)))]
        : [];

    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: HIDE_ROUTE_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return;
          const parsed = await readBody(req, res);
          if (parsed === null) return;
          const turns = integerList(parsed.body.turns);
          if (turns.length === 0) {
            sendJson(res, 400, { code: 'bad-request', message: 'turns must be a non-empty array of integers' });
            return;
          }
          // Only a live session can append; the client always has the session
          // open when it hides, so a miss is a stale request rather than a state
          // to compensate for.
          const session = scope.sessions.get(parsed.sessionId);
          if (session === undefined) {
            sendJson(res, 409, { code: 'session-not-live', message: 'open the session before hiding turns' });
            return;
          }
          let picked;
          let observation;
          try {
            observation = await scope.sessionQuery.observeSession(parsed.sessionId, {
              projectionMode: 'none',
            });
            picked = surfaceSeqsOfTurns(observation.events, new Set(turns));
          } finally {
            if (observation && typeof observation[Symbol.dispose] === 'function') {
              observation[Symbol.dispose]();
            }
          }
          if (picked.turns.length === 0) {
            sendJson(res, 409, { code: 'nothing-to-hide', message: 'the selected turns carry no model-visible content' });
            return;
          }
          // One replacement shadows one contiguous range, so unselected turns
          // between two selected ones need a run break rather than a wider span.
          const runs = splitIntoContiguousRuns(picked.byTurn);
          try {
            for (const run of runs) {
              session.append('user/message', buildHideMessage(run.turns, run.seqs.length), {
                surfaceOp: { op: 'replace', startSeq: run.seqs[0], endSeq: run.seqs[run.seqs.length - 1] },
                sourceEventSeqs: run.seqs,
              });
            }
            appendPluginRecord(session, HIDE_RECORD, {
              turns: picked.byTurn,
              hiddenAt: Date.now(),
              shadowedStart: picked.seqs[0],
              shadowedEnd: picked.seqs[picked.seqs.length - 1],
            });
          } catch (error) {
            sendJson(res, 500, {
              code: 'hide-failed',
              message: error instanceof Error ? error.message : 'hiding failed',
            });
            return;
          }
          sendJson(res, 200, { hidden: picked.turns });
        },
      }),
    );

    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: RESTORE_ROUTE_PATH,
        handler: async (req, res) => {
          if (reject(req, res)) return;
          const parsed = await readBody(req, res);
          if (parsed === null) return;
          const turns = integerList(parsed.body.turns);
          if (turns.length === 0) {
            sendJson(res, 400, { code: 'bad-request', message: 'turns must be a non-empty array of integers' });
            return;
          }
          const session = scope.sessions.get(parsed.sessionId);
          if (session === undefined) {
            sendJson(res, 409, { code: 'session-not-live', message: 'open the session before restoring turns' });
            return;
          }
          try {
            appendPluginRecord(session, RESTORE_RECORD, { turns, restoredAt: Date.now() });
            session.append('user/message', buildRestoreMessage(turns), {
              surfaceOp: 'append',
            });
          } catch (error) {
            sendJson(res, 500, {
              code: 'restore-failed',
              message: error instanceof Error ? error.message : 'restoring failed',
            });
            return;
          }
          sendJson(res, 200, { restored: turns });
        },
      }),
    );
  });



  ctx.inject(['webServer', 'connection', 'sessionQuery'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: SEARCH_ROUTE_PATH,
        handler: async (req, res) => {
          const rejection = scope.connection.requestRejection(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          const url = new URL(String(req.url), 'http://localhost');
          const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
          const query = (url.searchParams.get('q') ?? '').trim();
          if (sessionId === '' || query === '') {
            sendJson(res, 200, { hits: [], truncated: false });
            return;
          }
          let observation;
          try {
            observation = await scope.sessionQuery.observeSession(sessionId, {
              projectionMode: 'none',
            });
            const result = searchSessionAssistantEvents(observation.events, query);
            sendJson(res, 200, result);
          } catch (_error) {
            sendJson(res, 200, { hits: [], truncated: false });
          } finally {
            if (observation && typeof observation[Symbol.dispose] === 'function') {
              observation[Symbol.dispose]();
            }
          }
        },
      }),
    );
  });
}

/**
 * Pure internals, exported for the unit tests only.
 *
 * The plugin surface is `apply`; these values have no runtime consumer outside
 * this module and exist so the folding, selection and splitting rules can be
 * exercised without booting a Host.
 */
export const internals = {
  cleanHeadingText,
  extractBlockHeadings,
  previewPrompt,
  mdOutlineProjectionDefinition,
  searchBlockBody,
  searchSessionAssistantEvents,
  foldHiddenTurns,
  surfaceSeqsOfTurns,
  splitIntoContiguousRuns,
  renderHiddenContext,
  buildHideMessage,
  buildRestoreMessage,
  HIDE_RECORD,
  RESTORE_RECORD,
};
