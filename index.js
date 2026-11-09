/**
 * Host half of dsh-markdown-outline.
 *
 * Registers:
 * 1. `mdOutline` session-projection unit so the Client receives Markdown
 *    headings across the entire Session log (including unloaded history) and
 *    the current hidden-turn ledger.
 * 2. `agent/pre-step` waterfall interceptor that expands structured
 *    `@[label](dsh-outline:<payload>)` chip mentions into a dedicated recall
 *    context message right after the citing user message, keeping the user
 *    bubble clean while delivering full section Markdown to the model.
 * 3. `systemPrompt` context provider informing the model about hidden turns.
 * 4. Authenticated HTTP routes:
 *    - `GET  /md-outline/search`   full-log body keyword search
 *    - `GET  /md-outline/section`  full-log section or turn Markdown lookup
 *    - `POST /md-outline/hide`     hide selected turns from UI & model context
 *    - `POST /md-outline/restore`  restore hidden turns back to UI & context
 */

import { appendPluginRecord } from '@deepseek-ai/dsh-session';

const PROMPT_PREVIEW_LIMIT = 60;
const HEADING_TEXT_LIMIT = 140;
const MAX_HEADINGS_PER_SESSION = 600;

/** URI scheme used inside `@[label](dsh-outline:<base64url>)` mentions. */
export const OUTLINE_REFERENCE_SCHEME = 'dsh-outline:';

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
 * @param {number} [maxRemaining]
 * @returns {Array<{ depth: number, text: string }>}
 */
function extractBlockHeadings(markdown, maxRemaining = MAX_HEADINGS_PER_SESSION) {
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
 * Collect the reply Markdown body under the heading at `targetIndexInStep`
 * across all text blocks of one assistant step, stopping before the next
 * heading at the same or shallower depth. Respects fenced code blocks and both
 * ATX and Setext headings.
 *
 * @param {ReadonlyArray<string>} textBlocks
 * @param {number} targetIndexInStep
 * @returns {{ heading: string, depth: number, body: string } | null}
 */
function extractStepSectionByIndex(textBlocks, targetIndexInStep) {
  if (!Array.isArray(textBlocks) || textBlocks.length === 0) return null;
  if (typeof targetIndexInStep !== 'number' || targetIndexInStep < 0) {
    const body = textBlocks.join('\n\n').trim();
    return { heading: '', depth: 1, body };
  }

  let headingOrdinal = -1;
  let capturing = false;
  let targetHeading = '';
  let targetDepth = 1;
  const capturedLines = [];

  for (const markdown of textBlocks) {
    if (typeof markdown !== 'string' || markdown === '') continue;
    const lines = markdown.split(/\r?\n/);
    let fenceChar = '';
    let fenceLen = 0;
    let paragraphLines = [];
    let paragraphRawLines = [];

    const flushPendingParagraph = () => {
      if (capturing && paragraphRawLines.length > 0) {
        for (const rawLine of paragraphRawLines) capturedLines.push(rawLine);
      }
      paragraphLines = [];
      paragraphRawLines = [];
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
        }
        if (capturing) capturedLines.push(line);
        continue;
      }

      const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (
        openFence !== null &&
        !(openFence[1][0] === '`' && openFence[2].includes('`'))
      ) {
        flushPendingParagraph();
        fenceChar = openFence[1][0];
        fenceLen = openFence[1].length;
        if (capturing) capturedLines.push(line);
        continue;
      }

      const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (atx !== null) {
        const afterHashes = line.replace(/^ {0,3}#{1,6}/, '');
        if (afterHashes === '' || /^[ \t]/.test(afterHashes)) {
          flushPendingParagraph();
          const rawBody = (atx[2] ?? '').replace(/^#+[ \t]*$/, '');
          const text = cleanHeadingText(rawBody);
          if (text !== '') {
            const depth = atx[1].length;
            headingOrdinal += 1;
            if (!capturing) {
              if (headingOrdinal === targetIndexInStep) {
                capturing = true;
                targetHeading = text;
                targetDepth = depth;
              }
            } else if (depth <= targetDepth) {
              return {
                heading: targetHeading,
                depth: targetDepth,
                body: capturedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
              };
            } else {
              capturedLines.push(line);
            }
            continue;
          }
        }
      }

      if (paragraphLines.length > 0) {
        const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
        if (setext !== null) {
          const depth = setext[1][0] === '=' ? 1 : 2;
          const text = cleanHeadingText(paragraphLines.join(' '));
          if (text !== '') {
            paragraphLines = [];
            paragraphRawLines = [];
            headingOrdinal += 1;
            if (!capturing) {
              if (headingOrdinal === targetIndexInStep) {
                capturing = true;
                targetHeading = text;
                targetDepth = depth;
              }
            } else if (depth <= targetDepth) {
              return {
                heading: targetHeading,
                depth: targetDepth,
                body: capturedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
              };
            } else {
              capturedLines.push(line);
            }
            continue;
          }
        }
      }

      if (isNonParagraphLine(line)) {
        flushPendingParagraph();
        if (capturing) capturedLines.push(line);
      } else {
        paragraphLines.push(line.trim());
        paragraphRawLines.push(line);
      }
    }
    flushPendingParagraph();
  }

  if (!capturing) return null;
  return {
    heading: targetHeading,
    depth: targetDepth,
    body: capturedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Extract bounded prompt preview from user message content blocks.
 * Falls back to image/file indicators when a user prompt has no text blocks.
 * @param {ReadonlyArray<{ type: string, text?: string, attachment?: { name?: string } }>} content
 * @returns {string}
 */
function previewPrompt(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  let unread = false;
  let hasImage = false;
  let fileName = '';
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'image') {
      hasImage = true;
      continue;
    }
    if (block.type === 'file') {
      fileName = block.attachment?.name || 'file';
      continue;
    }
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    // Strip our own inline outline reference mentions from the prompt preview
    const cleanedBlock = parseOutlineReferenceText(block.text).text;
    if (text.length >= PROMPT_PREVIEW_LIMIT * 2) {
      unread = true;
      break;
    }
    const clipped = cleanedBlock.length > PROMPT_PREVIEW_LIMIT * 2;
    const chunk = clipped ? cleanedBlock.slice(0, PROMPT_PREVIEW_LIMIT * 2) : cleanedBlock;
    text += text === '' ? chunk : ` ${chunk}`;
    if (clipped) {
      unread = true;
      break;
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') {
    if (hasImage) return '[图片]';
    if (fileName !== '') return `[${fileName}]`;
    return '';
  }
  if (normalized.length > PROMPT_PREVIEW_LIMIT - 1) {
    return `${normalized.slice(0, PROMPT_PREVIEW_LIMIT - 1).trimEnd()}…`;
  }
  return unread && normalized !== '' ? `${normalized}…` : normalized;
}

/**
 * Encode one outline reference descriptor into a canonical `dsh-outline:` URI.
 * @param {{ turn: number, step?: number, indexInStep?: number, heading?: string }} ref
 * @returns {string}
 */
function encodeOutlineReferenceUri(ref) {
  const payload = {
    t: Number(ref.turn) || 0,
    s: typeof ref.step === 'number' ? ref.step : -1,
    i: typeof ref.indexInStep === 'number' ? ref.indexInStep : -1,
    ...(typeof ref.heading === 'string' && ref.heading !== '' ? { h: ref.heading.slice(0, 80) } : {}),
  };
  return `${OUTLINE_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

/**
 * Decode a `dsh-outline:` URI back into its structured coordinates.
 * @param {string} uri
 * @returns {{ turn: number, step: number, indexInStep: number, heading: string } | null}
 */
function decodeOutlineReferenceUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(OUTLINE_REFERENCE_SCHEME)) return null;
  const raw = uri.slice(OUTLINE_REFERENCE_SCHEME.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.t !== 'number') return null;
    return {
      turn: parsed.t,
      step: typeof parsed.s === 'number' ? parsed.s : -1,
      indexInStep: typeof parsed.i === 'number' ? parsed.i : -1,
      heading: typeof parsed.h === 'string' ? parsed.h : '',
    };
  } catch (error) {
    void error;
    return null;
  }
}

/**
 * Format a canonical `@[label](dsh-outline:...)` mention.
 * @param {{ turn: number, step?: number, indexInStep?: number, heading?: string, label?: string }} ref
 * @returns {string}
 */
function formatOutlineReferenceMention(ref) {
  const rawLabel = ref.label || ref.heading || `#${ref.turn}`;
  const escaped = String(rawLabel).replace(/[\\\]]/g, (m) => `\\${m}`);
  return `@[${escaped}](${encodeOutlineReferenceUri(ref)})`;
}

/**
 * Parse all `@[label](dsh-outline:...)` mentions from a user message text block.
 * @param {string} text
 * @returns {{ text: string, references: Array<{ label: string, uri: string, turn: number, step: number, indexInStep: number, heading: string }> }}
 */
function parseOutlineReferenceText(text) {
  if (typeof text !== 'string' || !text.includes(OUTLINE_REFERENCE_SCHEME)) {
    return { text: text ?? '', references: [] };
  }
  const references = [];
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-outline:[A-Za-z0-9_-]+)\)/gu;
  const rendered = text.replace(pattern, (_match, rawLabel, uri) => {
    const decoded = decodeOutlineReferenceUri(uri);
    const label = String(rawLabel ?? '').replace(/\\(.)/gu, '$1');
    if (decoded !== null) {
      references.push({
        label,
        uri,
        turn: decoded.turn,
        step: decoded.step,
        indexInStep: decoded.indexInStep,
        heading: decoded.heading || label,
      });
    }
    return `@${label}`;
  });
  return { text: rendered, references };
}

/**
 * Resolve one section or whole-turn reference against a Session event log.
 * Works for both loaded and unloaded historical turns.
 * @param {ReadonlyArray<any>} events
 * @param {{ turn: number, step?: number, indexInStep?: number, heading?: string }} target
 * @returns {{ turn: number, step: number, indexInStep: number, prompt: string, heading: string, body: string } | null}
 */
function resolveSectionFromEvents(events, target) {
  if (!Array.isArray(events) || typeof target?.turn !== 'number') return null;
  const targetTurn = target.turn;
  const targetStep = typeof target.step === 'number' ? target.step : -1;
  const targetIndex = typeof target.indexInStep === 'number' ? target.indexInStep : -1;

  let curTurn = null;
  let prompt = '';
  const stepMap = new Map();

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'turn/start') {
      curTurn = event.data?.turn ?? null;
      continue;
    }
    if (event.type === 'user/message' && curTurn === targetTurn && event.data?.source?.kind === 'user') {
      if (prompt === '') prompt = previewPrompt(event.data.content);
      continue;
    }
    if (event.type === 'assistant/message' && event.data?.turn === targetTurn) {
      const stepNum = typeof event.data?.step === 'number' ? event.data.step : 0;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      const textBlocks = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (textBlocks.length > 0) {
        stepMap.set(stepNum, textBlocks);
      }
    }
  }

  const orderedSteps = [...stepMap.entries()].sort((a, b) => a[0] - b[0]);
  if (orderedSteps.length === 0) {
    if (prompt === '') return null;
    return {
      turn: targetTurn,
      step: 0,
      indexInStep: -1,
      prompt,
      heading: target.heading || prompt || `第 ${targetTurn} 轮`,
      body: prompt,
    };
  }

  // Headless / whole-turn reference
  if (targetStep < 0 || targetIndex < 0) {
    const allTexts = orderedSteps.flatMap(([, texts]) => texts);
    return {
      turn: targetTurn,
      step: orderedSteps[0][0],
      indexInStep: -1,
      prompt,
      heading: target.heading || prompt || `第 ${targetTurn} 轮`,
      body: allTexts.join('\n\n').trim(),
    };
  }

  const stepTexts = stepMap.get(targetStep) ?? orderedSteps[0][1];
  const extracted = extractStepSectionByIndex(stepTexts, targetIndex);
  if (extracted !== null) {
    return {
      turn: targetTurn,
      step: targetStep,
      indexInStep: targetIndex,
      prompt,
      heading: extracted.heading || target.heading || prompt || `第 ${targetTurn} 轮`,
      body: extracted.body,
    };
  }

  // Fallback by matching heading text if step/index shifted
  if (target.heading) {
    for (const [sNum, texts] of orderedSteps) {
      const headings = texts.flatMap((t) => extractBlockHeadings(t));
      const idx = headings.findIndex((h) => h.text === target.heading);
      if (idx >= 0) {
        const sec = extractStepSectionByIndex(texts, idx);
        if (sec !== null) {
          return {
            turn: targetTurn,
            step: sNum,
            indexInStep: idx,
            prompt,
            heading: sec.heading,
            body: sec.body,
          };
        }
      }
    }
  }

  const fallbackBody = stepTexts.join('\n\n').trim();
  return {
    turn: targetTurn,
    step: targetStep,
    indexInStep: targetIndex,
    prompt,
    heading: target.heading || prompt || `第 ${targetTurn} 轮`,
    body: fallbackBody,
  };
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
        const listed = state.visibleTurns.some((t) => t.turn === updatedTurn.turn);
        const nextVisible = listed
          ? state.visibleTurns.map((t) => (t.turn === updatedTurn.turn ? updatedTurn : t))
          : [...state.visibleTurns, updatedTurn].sort((a, b) => a.turn - b.turn);
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

        let nextAll;
        if (existingTurn === undefined) {
          const newTurn = {
            turn: turnNum,
            seq: event.seq,
            prompt: '',
            steps: headings.length === 0 ? [] : [{ step: stepNum, seq: event.seq, headings }],
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

        return { ...state, allTurns: nextAll, visibleTurns: nextAll };
      }
      case HIDE_RECORD: {
        const items = Array.isArray(event.data?.turns) ? event.data.turns : [];
        const added = items
          .map((item) => (typeof item === 'number' ? item : item?.turn))
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
const SECTION_ROUTE_PATH = '/md-outline/section';
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
// Turn hiding & Reference injection.
// ---------------------------------------------------------------------------

/** Prompt-context name and placement for the running hidden-turn ledger. */
const HIDDEN_CONTEXT_NAME = 'md-outline:hidden-turns';
const HIDDEN_CONTEXT_ORDER = 115.5;

/** Body ceiling for the mutating routes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Longest reference body accepted in one request, in characters. */
const MAX_REFERENCE_CHARS = 120_000;

/**
 * Read a bounded request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>}
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
    void error;
    return null;
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null;
}

/**
 * Read this plugin's hide ledger from one event log.
 * @param {ReadonlyArray<any>} events
 * @returns {{ turns: Map<number, { turn: number, hideSeq: number, seqs: number[], visible: boolean }>, bySeq: Map<number, number>, seq: number }}
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
        const turnNum = typeof item === 'number' ? item : item?.turn;
        if (typeof turnNum !== 'number') continue;
        const prevSeqs = turns.get(turnNum)?.seqs ?? [];
        const rawSeqs = Array.isArray(item?.seqs) ? item.seqs : prevSeqs;
        unlink(turnNum);
        const seqs = rawSeqs.filter((seq) => typeof seq === 'number');
        for (const seq of seqs) bySeq.set(seq, turnNum);
        turns.set(turnNum, { turn: turnNum, hideSeq: event.seq, seqs, visible: false });
      }
    } else {
      for (const turn of data.turns) {
        if (typeof turn !== 'number') continue;
        const entry = turns.get(turn);
        if (entry === undefined) continue;
        turns.set(turn, { ...entry, visible: true });
      }
    }
  }

  return { turns, bySeq, seq: lastSeq };
}

/**
 * Turns the outline and transcript should currently show as hidden.
 * @param {ReadonlyArray<any>} events
 * @returns {number[]} hidden turn numbers, ascending.
 */
function hiddenTurnNumbers(events) {
  const { turns } = foldHiddenTurns(events);
  return [...turns.values()]
    .filter((entry) => entry.visible !== true)
    .map((entry) => entry.turn)
    .sort((a, b) => a - b);
}

/**
 * Replay a session log into its current model-visible surface.
 * @param {ReadonlyArray<any>} events
 * @returns {Set<number>}
 */
function foldLiveSurface(events) {
  return new Set(foldLiveSurfaceOrder(events));
}

/**
 * Replay a session log into its surface node order.
 * @param {ReadonlyArray<any>} events
 * @returns {number[]}
 */
function foldLiveSurfaceOrder(events) {
  const nodes = [];
  for (const event of events) {
    const op = event?.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push(event.seq);
      continue;
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue;
    const startIdx = nodes.indexOf(op.startSeq);
    const endIdx = nodes.indexOf(op.endSeq);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue;
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
  }
  return nodes;
}

/**
 * Collect the surface seqs belonging to selected turns.
 * @param {ReadonlyArray<any>} events
 * @param {ReadonlySet<number>} selectedTurns
 * @param {ReadonlySet<number>} liveSeqs
 * @returns {{ seqs: number[], turns: number[], order: Array<{ turn: number | null, seq?: number }>, byTurn: Array<{ turn: number, seqs: number[] }> }}
 */
function surfaceSeqsOfTurns(events, selectedTurns, liveSeqs) {
  const surfaceTypes = new Set([
    'system/message',
    'developer/message',
    'user/message',
    'assistant/message',
    'tool/result',
  ]);
  const unshadowable = new Set(['system/message', 'developer/message']);
  const eventsBySeq = new Map();
  for (const event of events) eventsBySeq.set(event.seq, event);

  let currentTurn = null;
  const turnOfSeq = new Map();
  for (const event of events) {
    if (event?.type === 'turn/start') {
      const turn = event.data?.turn;
      currentTurn = typeof turn === 'number' ? turn : null;
      continue;
    }
    if (currentTurn !== null) turnOfSeq.set(event.seq, currentTurn);
  }

  const seqs = [];
  const owned = new Map();
  const ordered = [];
  for (const seq of foldLiveSurfaceOrder(events)) {
    if (!liveSeqs.has(seq)) continue;
    const event = eventsBySeq.get(seq);
    const turn = turnOfSeq.get(seq);
    if (event === undefined || turn === undefined) continue;
    if (!surfaceTypes.has(event.type) || event.surfaceOp === undefined) continue;
    if (unshadowable.has(event.type)) {
      ordered.push({ turn: null });
      continue;
    }
    if (!selectedTurns.has(turn)) {
      ordered.push({ turn: null });
      continue;
    }
    seqs.push(seq);
    ordered.push({ turn, seq });
    const list = owned.get(turn);
    if (list === undefined) owned.set(turn, [seq]);
    else list.push(seq);
  }

  const turns = [...owned.keys()].sort((a, b) => a - b);
  return {
    seqs,
    turns,
    order: ordered,
    byTurn: turns.map((turn) => ({ turn, seqs: owned.get(turn) })),
  };
}

/**
 * Group owned seqs into the contiguous runs one `replace` operation can shadow.
 * @param {ReadonlyArray<{ turn: number, seqs: readonly number[] }>} byTurn
 * @param {ReadonlyArray<{ turn: number | null, seq?: number }>} order
 * @returns {Array<{ seqs: number[], turns: number[] }>}
 */
function splitIntoContiguousRuns(byTurn, order) {
  if (!Array.isArray(order)) {
    throw new TypeError('splitIntoContiguousRuns needs the surface order');
  }
  const runs = [];
  let current = null;
  for (const step of order) {
    if (step.turn === null) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { seqs: [], turns: [] };
      runs.push(current);
    }
    current.seqs.push(step.seq);
    if (!current.turns.includes(step.turn)) current.turns.push(step.turn);
  }
  return runs
    .map((run) => ({ seqs: run.seqs, turns: run.turns.sort((a, b) => a - b) }))
    .filter((run) => run.seqs.length > 0);
}

/**
 * Render the hidden-turn ledger as the runtime context the model reads.
 * Only currently hidden turns (`visible !== true`) are reported as hidden,
 * so restoring a turn immediately lifts the restriction for subsequent turns.
 * @param {ReturnType<typeof foldHiddenTurns>} ledger
 * @returns {string}
 */
function renderHiddenContext(ledger) {
  if (!ledger || !ledger.turns || ledger.turns.size === 0) return '';
  const turns = [...ledger.turns.values()]
    .filter((entry) => entry.visible !== true)
    .map((entry) => entry.turn)
    .sort((a, b) => a - b);
  if (turns.length === 0) return '';
  return [
    '## Hidden conversation turns',
    '',
    'The user hid the following turns from this conversation. Their messages are absent from or excluded in the history above, and the model should ignore them.',
    `Hidden turn numbers: ${turns.join(', ')}.`,
    'Do not claim to remember them, and do not ask the user to repeat them unless the current request depends on what they contained.',
  ].join('\n');
}

/**
 * Build the user message that replaces a hidden range (kept for test compatibility).
 * @param {readonly number[]} turns
 * @param {number} shadowedCount
 * @returns {object}
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
 * Build the bridge message that marks a restored range as visible again (kept for test compatibility).
 * @param {readonly number[]} turns
 * @returns {object}
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
 * Prepare direct user messages in `agent/pre-step`:
 * when a user message contains `@[label](dsh-outline:...)` mentions, replace
 * the raw URI token in the user message with readable `@label` and append a
 * structured recall context message carrying the resolved Markdown bodies of
 * the referenced outline sections.
 *
 * @param {ReadonlyArray<any>} events - full session event log
 * @param {ReadonlyArray<any>} messages - pre-step claimed messages
 * @returns {Array<any>}
 */
function prepareOutlineReferencedMessages(events, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const out = [];
  for (const message of messages) {
    if (!message || message.source?.kind !== 'user' || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const collectedRefs = [];
    for (const block of message.content) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
      const parsed = parseOutlineReferenceText(block.text);
      if (parsed.references.length > 0) {
        for (const r of parsed.references) collectedRefs.push(r);
      }
    }
    if (collectedRefs.length === 0) {
      out.push(message);
      continue;
    }
    // Deduplicate by URI while preserving mention order
    const seen = new Set();
    const uniqueRefs = [];
    for (const r of collectedRefs) {
      if (seen.has(r.uri)) continue;
      seen.add(r.uri);
      uniqueRefs.push(r);
    }

    const resolvedSections = [];
    for (const r of uniqueRefs) {
      const resolved = resolveSectionFromEvents(events, r);
      if (resolved !== null) {
        resolvedSections.push({ ...resolved, label: r.label });
      }
    }

    out.push(message);

    if (resolvedSections.length > 0) {
      const formattedBlocks = resolvedSections.map((sec) => {
        const meta = [`Turn #${sec.turn}`];
        if (sec.prompt) meta.push(sec.prompt);
        return [
          `### ${sec.heading} (${meta.join(' · ')})`,
          '',
          sec.body || '(empty section)',
        ].join('\n');
      });
      let promptText = [
        '## Referenced outline sections',
        '',
        'The user referenced the following sections from earlier turns in this conversation:',
        '',
        '<referenced-outline-sections>',
        formattedBlocks.join('\n\n---\n\n'),
        '</referenced-outline-sections>',
      ].join('\n');
      if (promptText.length > MAX_REFERENCE_CHARS) {
        promptText = `${promptText.slice(0, MAX_REFERENCE_CHARS)}\n\n…(truncated)
</referenced-outline-sections>`;
      }
      out.push({
        id: `md-outline-ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: resolvedSections.map((sec, idx) => ({
            sessionId: `turn-${sec.turn}`,
            label: sec.label || `#${sec.turn} ${sec.heading}`,
            capturedFormatVersion: 4,
            capturedThroughSeq: 0,
            retainedMessages: 1,
            omittedMessages: 0,
            retainedBytes: Buffer.byteLength(sec.body ?? '', 'utf8'),
            omittedBytes: 0,
            truncated: false,
            inputIndex: idx,
          })),
        },
      });
    }
  }
  return out;
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
 * Mount the Host-side session projection unit, the `agent/pre-step` reference
 * expander, the hidden-turn context provider, and the HTTP routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    scope.sessionProjections.register(mdOutlineProjectionDefinition);
  });

  // Expand @[label](dsh-outline:...) mentions in direct user messages right before
  // they enter the model step, using the same waterfall seam as @session references.
  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      const decision = await next();
      if (!decision || decision.kind === 'reject') return decision;
      if (signal?.aborted) return decision;
      try {
        const events = agent?.session?.snapshotEvents?.() ?? [];
        const expanded = prepareOutlineReferencedMessages(events, decision.messages);
        if (expanded === decision.messages) return decision;
        return { ...decision, messages: expanded };
      } catch (_error) {
        return decision;
      }
    },
    { prepend: true },
  );

  // The hidden-turn ledger is a runtime context. DSH prompt providers are
  // synchronous, so fold the live session log into a small per-session cache
  // and invalidate it when this plugin appends a hide or restore record.
  ctx.inject(['systemPrompt'], (scope) => {
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
      text: ({ agent }) => (agent === undefined ? '' : renderHiddenContext(ledgerOf(agent.session))),
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

    // Reversible, zero-pollution turn hiding:
    // Appends only the ignorable plugin ledger record (never mutating the
    // irreversible surface or injecting stray root-level user messages).
    // If the user explicitly requests hard surface replacement via `hardReplace: true`,
    // it also performs safe surface replacement while skipping system/developer/shared nodes.
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
          const session = scope.sessions.get(parsed.sessionId);
          if (session === undefined) {
            sendJson(res, 409, { code: 'session-not-live', message: 'open the session before hiding turns' });
            return;
          }
          let picked = { byTurn: turns.map((turn) => ({ turn, seqs: [] })), turns };
          try {
            const events = session.snapshotEvents?.() ?? [];
            const live = foldLiveSurface(events);
            const computed = surfaceSeqsOfTurns(events, new Set(turns), live);
            const byTurnMap = new Map(computed.byTurn.map((entry) => [entry.turn, entry.seqs]));
            picked = {
              byTurn: turns.map((turn) => ({ turn, seqs: byTurnMap.get(turn) ?? [] })),
              turns,
            };
          } catch (_err) {
            // Keep fallback empty seqs per turn so hiding never fails on unusual log shapes
          }
          try {
            appendPluginRecord(session, HIDE_RECORD, {
              turns: picked.byTurn,
              hiddenAt: Date.now(),
            });
          } catch (error) {
            sendJson(res, 500, {
              code: 'hide-failed',
              message: error instanceof Error ? error.message : 'hiding failed',
            });
            return;
          }
          sendJson(res, 200, { hidden: turns });
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

    // Full-log section lookup so unloaded historical turns and sent @-chips can
    // always inspect or quote their complete Markdown section body.
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: SECTION_ROUTE_PATH,
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
          const uri = (url.searchParams.get('uri') ?? '').trim();
          const turnParam = Number(url.searchParams.get('turn') ?? '-1');
          const stepParam = Number(url.searchParams.get('step') ?? '-1');
          const indexParam = Number(url.searchParams.get('indexInStep') ?? '-1');
          const headingParam = (url.searchParams.get('heading') ?? '').trim();

          if (sessionId === '') {
            sendJson(res, 400, { code: 'bad-request', message: 'sessionId is required' });
            return;
          }
          const target = uri !== ''
            ? decodeOutlineReferenceUri(uri)
            : Number.isInteger(turnParam) && turnParam >= 0
              ? { turn: turnParam, step: stepParam, indexInStep: indexParam, heading: headingParam }
              : null;
          if (target === null) {
            sendJson(res, 400, { code: 'bad-request', message: 'valid uri or turn is required' });
            return;
          }

          let observation;
          try {
            observation = await scope.sessionQuery.observeSession(sessionId, {
              projectionMode: 'none',
            });
            const section = resolveSectionFromEvents(observation.events, target);
            if (section === null) {
              sendJson(res, 404, { code: 'not-found', message: 'section not found' });
              return;
            }
            sendJson(res, 200, { section });
          } catch (_error) {
            sendJson(res, 404, { code: 'not-found', message: 'section not found' });
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
 * Pure internals exported for unit tests.
 */
export const internals = {
  cleanHeadingText,
  extractBlockHeadings,
  extractStepSectionByIndex,
  previewPrompt,
  encodeOutlineReferenceUri,
  decodeOutlineReferenceUri,
  formatOutlineReferenceMention,
  parseOutlineReferenceText,
  resolveSectionFromEvents,
  prepareOutlineReferencedMessages,
  mdOutlineProjectionDefinition,
  searchBlockBody,
  searchSessionAssistantEvents,
  foldHiddenTurns,
  hiddenTurnNumbers,
  foldLiveSurface,
  foldLiveSurfaceOrder,
  surfaceSeqsOfTurns,
  splitIntoContiguousRuns,
  renderHiddenContext,
  buildHideMessage,
  buildRestoreMessage,
  HIDE_RECORD,
  RESTORE_RECORD,
};
