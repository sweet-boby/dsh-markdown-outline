/**
 * Host half of dsh-markdown-outline.
 * Registers the optional `mdOutline` session-projection unit so the Client
 * receives Markdown headings across the entire Session log, including turns
 * outside the currently paged browser event window.
 */

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

const viewSchema = {
  parse(val) {
    if (!Array.isArray(val)) throw new Error('mdOutline view must be an array');
    for (const item of val) assertValidTurnEntry(item);
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
    return val;
  },
};

const EMPTY_TURNS = Object.freeze([]);
const EMPTY_STATE = Object.freeze({
  allTurns: EMPTY_TURNS,
  visibleTurns: EMPTY_TURNS,
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
          allTurns: [
            ...state.allTurns,
            { turn: turnNum, seq: event.seq, prompt: '', steps: [] },
          ],
          visibleTurns: state.visibleTurns,
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
          return { allTurns: nextAll, visibleTurns: state.visibleTurns };
        }
        const nextVisible = state.visibleTurns.map((t) =>
          t.turn === updatedTurn.turn ? updatedTurn : t,
        );
        return { allTurns: nextAll, visibleTurns: nextVisible };
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
          return { allTurns: nextAll, visibleTurns: state.visibleTurns };
        }
        return { allTurns: nextAll, visibleTurns: nextVisible };
      }
      default:
        return state;
    }
  },
  wire: {
    viewSchema,
    view: (state) => state.visibleTurns,
  },
};

const SEARCH_ROUTE_PATH = '/md-outline/search';
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

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Mount the Host-side session projection unit and whole-session body search route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    scope.sessionProjections.register(mdOutlineProjectionDefinition);
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
