# dsh-markdown-outline

English | [中文](README.zh.md)

A Feishu-style Markdown outline for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): every Markdown heading an AI reply contains becomes a collapsible table of contents in an independent split column on the left of the conversation page, and a built-in search reaches both the headings and the reply body — including turns that are not paged into the browser yet.

## Features

- **Whole-session outline.** Headings come from a Host session projection folding the complete Session log, so replies scrolled out of the loaded window still appear in the outline. Clicking one pages history in on demand.
- **Independent split column.** The outline pushes the conversation area right instead of floating above it; it can be collapsed to a slim trigger and widened by dragging (180–420 px), and both choices are remembered per browser.
- **Heading search.** Matching headings stay in place with their ancestor headings kept as dimmed breadcrumbs, so a hit keeps its section context.
- **Reply-body search.** Paragraphs, list items, blockquotes, tables and code fences match with a highlighted snippet; reasoning blocks are skipped. Loaded turns are searched in the browser instantly, and earlier unloaded turns are searched on the Host through an authenticated route.
- **Paragraph-level jump.** A result scrolls to the matching block, not just its section, revealing collapsed ancestors and paging unloaded turns first. The target flashes briefly.
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
- The Host half registers the `mdOutline` session projection and the `GET /md-outline/search` route. Without the projection registry the panel stays empty; without the route only body search over already-loaded turns is available.

## How it works

| File | Role |
|---|---|
| [`index.js`](index.js) | Host half: the `mdOutline` projection unit folding `turn/start`, `user/message` and `assistant/message` into a per-turn heading outline, plus the authenticated whole-log reply-body search route |
| [`client.js`](client.js) | Client half: the header bridge that publishes session state, the split-column outline panel, search, and the jump machinery |
| [`cordis.patch.yml`](cordis.patch.yml) | The profile patch row that mounts the bundle |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin title and description shown by the plugin manager |

The Client half mounts two slots: a session-scoped bridge in `conversation.session.header.actions` that reads the projection, the loaded turns and the paging API, and a root-scoped host in `conversation.header.leading` that renders the column and shifts `[data-conversation-content]` by the panel width.

## Limitations

- Headings are recognized in ATX (`#`) and Setext (`===`, `---`) form inside non-reasoning assistant text; headings the model emits inside nested blockquotes or list continuations inherit the reduced heading level the renderer applies, and a heading inside a collapsed details block is not extracted.
- Body search caps its response at 80 hits per query and reports truncation, so a very common word may leave later matches unreported.
- The outline column is a fixed split at the left edge; it does not dock into the right sidebar.

## License

[MIT](LICENSE)
