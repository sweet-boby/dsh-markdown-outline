# dsh-markdown-outline

English | [中文](README.zh.md)

A Feishu-style Markdown outline for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): every Markdown heading an AI reply contains becomes a collapsible table of contents in an independent split column on the left of the conversation page, and a built-in search reaches both the headings and the reply body — including turns that are not paged into the browser yet.

## Features

- **Whole-session outline.** Headings come from a Host session projection folding the complete Session log, so replies scrolled out of the loaded window still appear in the outline. Clicking one pages history in on demand.
- **Independent split column.** The outline pushes the conversation area right instead of floating above it; it can be collapsed to a slim trigger and widened by dragging (180–420 px), and both choices are remembered per browser.
- **Heading search.** Matching headings stay in place with their ancestor headings kept as dimmed breadcrumbs, so a hit keeps its section context.
- **Reply-body search.** Paragraphs, list items, blockquotes, tables and code fences match with a highlighted snippet; reasoning blocks are skipped. Loaded turns are searched in the browser instantly, and earlier unloaded turns are searched on the Host through an authenticated route.
- **Paragraph-level jump.** A result scrolls to the matching block, not just its section, revealing collapsed ancestors and paging unloaded turns first. The target flashes briefly.
- **Multi-select references.** Turn on selection, tick any headings, then press **Attach**. The confirmed sections become a card above the composer and are written into the draft as one compact citation block, so the message you send carries them — the draft is where a message picks up content, and a record kept elsewhere is read after the turn has already claimed its messages. Ticking more headings afterwards changes nothing until you attach again. Clicking the card opens a sidebar with each section's full text, where you can drop an entry or remove the reference.
- **Hidden turns.** Select the turns you no longer want the model to see and hide them. Hidden turns disappear from the conversation and from later requests, stay listed under the outline, and can be restored at any time.
- **Theme-native.** Only `--dsw-alias-*` tokens are used, so the outline follows the light and dark theme without its own palette.

## Install

The package is a profile bundle. Install it into the profile you use, then reload the page:

```sh
dsh plugin --profile web add dsh-markdown-outline
```

Or install from this repository directly:

```sh
dsh plugin --profile web add git+https://github.com/sweet-boby/dsh-markdown-outline.git
```

The bundle inserts one row, `md-outline`, into the profile patch. Removing the package removes the row with it.

## Requirements

- DSH 0.2 or newer, Web or Desktop surface.
- The Host half registers the `mdOutline` session projection, the `GET /md-outline/search` route, and the `POST /md-outline/hide` and `POST /md-outline/restore` routes. Without the projection registry the panel stays empty; without the search route only body search over already-loaded turns is available; without the hide routes the selection and reference features still work.

## How it works

| File | Role |
|---|---|
| [`index.js`](index.js) | Host half: the `mdOutline` projection unit folding `turn/start`, `user/message` and `assistant/message` into a per-turn heading outline, the authenticated whole-log reply-body search route, the hidden-turn prompt context, and the hide/restore routes |
| [`client.js`](client.js) | Client half: the header bridge, the split-column outline panel, search, selection, the reference card and sidebar, the hidden-turn list, and the jump machinery |
| [`cordis.patch.yml`](cordis.patch.yml) | The profile patch row that mounts the bundle |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin title and description shown by the plugin manager |

The Client half mounts three slots: a session-scoped bridge in `conversation.session.header.actions` that reads the projection, the loaded turns and the paging API; a root-scoped host in `conversation.header.leading` that renders the column and shifts `[data-conversation-content]` by the panel width; and a session-scoped entry in `conversation.input.dock` that renders the reference card, its detail sidebar, and the hide confirmation and owns the composer write.

### Hiding a turn

Ticking a turn hides that turn whole: its prompt and its replies leave the model-visible surface together, and turns you did not tick stay exactly as they were. The tick box on a turn header writes every heading of that turn at once, so one action covers a complete exchange.

A hide appends one `user/message` carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` over the selected turns' surface nodes, so the model-visible surface stops carrying them while the event log keeps every original event. One `replace` shadows exactly one contiguous range, so a gap between two selected turns starts a new range rather than widening the span — that is what keeps unselected turns out of the replacement. The replacement names the hidden turns and tells the model not to reference them. Two ignorable plugin records, `plugin:dsh-markdown-outline/hidden-turn` and `plugin:dsh-markdown-outline/hidden-turn-restored`, form the durable ledger; a runtime prompt context reads that ledger from the live session log on every request, so the model also knows which turns are absent. Restoring writes a ledger entry that drops the turns and appends a short message marking them visible again — the original messages are not replayed into the surface, because DSH cannot reintroduce shadowed events.

## Testing

```sh
npm test
```

The suite runs on Node's built-in test runner with no dependencies. [`tests/hidden-turns.test.mjs`](tests/hidden-turns.test.mjs) covers the Host rules — which surface nodes belong to a turn, how selected turns split into contiguous replacement runs, and how the ledger and projection fold hides and restores. [`tests/client.test.mjs`](tests/client.test.mjs) mounts the client half under a fake DOM and asserts that a hidden turn leaves the outline and that the transcript rule names exactly the hidden turns.

`tests/fixtures.mjs` writes event logs in the order the agent loop actually appends them (`turn/start`, `step/start`, runtime context, prompt, reply, `step/end`, `turn/end`), because the turn and surface rules depend on that ordering.

## Limitations

- Headings are recognized in ATX (`#`) and Setext (`===`, `---`) form inside non-reasoning assistant text; headings the model emits inside nested blockquotes or list continuations inherit the reduced heading level the renderer applies, and a heading inside a collapsed details block is not extracted.
- Body search caps its response at 80 hits per query and reports truncation, so a very common word may leave later matches unreported.
- The outline column is a fixed split at the left edge; it does not dock into the right sidebar.
- A reference is inserted as plain text in `<md-outline-reference>` tags; it consumes the draft's insertion point rather than attaching as a structured chip.
- Hiding needs a live session, so a session must be open in the current page. Restoring marks the turns visible again but cannot replay their messages into the model's history.

## License

[MIT](LICENSE)
