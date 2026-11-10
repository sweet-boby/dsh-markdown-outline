# dsh-markdown-outline

English | [中文](README.zh.md)

A Feishu-style Markdown outline for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): every Markdown heading an AI reply contains becomes a collapsible table of contents in an independent split column on the left of the conversation page, with built-in heading and reply-body search across the entire session log, native `@` reference chips for multi-selected sections, and reversible turn hiding.

## Features

- **Whole-session outline.** Headings come from a Host session projection folding the complete Session log, so replies scrolled out of the loaded window still appear in the outline. Clicking one pages history in on demand.
- **Independent split column.** The outline pushes the conversation area right instead of floating above it; it can be collapsed to a slim trigger and widened by dragging (180–420 px), and both choices are remembered per browser.
- **Heading search.** Matching headings stay in place with their ancestor headings kept as dimmed breadcrumbs, so a hit keeps its section context.
- **Reply-body search.** Paragraphs, list items, blockquotes, tables and code fences match with a highlighted snippet; reasoning blocks are skipped. Loaded turns are searched in the browser instantly, and earlier unloaded turns are searched on the Host through an authenticated route.
- **Paragraph-level jump.** A result scrolls to the matching block, not just its section, revealing collapsed ancestors and paging unloaded turns first. The target flashes briefly.
- **Multi-select references & native `@` chips.** Turn on selection, tick any headings or headless turns, then press **Attach** (or type `@` in the composer to pick an outline section directly):
  - Inserts native atomic `ReferenceChipNode` pills into the composer via `slash/input-insert-reference` and displays a summary card above the composer that automatically clears upon send;
  - Sent messages render `@[label](dsh-outline:...)` mentions as interactive inline chips via `uiConversation.userText`; clicking a chip in either the composer or a sent message bubble opens the section detail drawer (fetching unloaded history from the Host on demand);
  - On the Host, an `agent/pre-step` waterfall listener expands every `dsh-outline:` mention into a structured `recall` context message carrying the full Markdown section body.
- **Reversible hidden turns.** Select turns you want to hide from the conversation and model context. Hidden turns are recorded in an ignorable plugin ledger and can be restored cleanly at any time without polluting the transcript.
- **Create new session from selected turns.** Tick any combination of turns (even non-contiguous ones) and click **New session** to branch a brand-new Session in the same Workspace containing only the complete conversation history of those selected turns.
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

## Testing

```sh
npm test
```

## License

[MIT](LICENSE)
