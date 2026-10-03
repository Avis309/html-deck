<div align="center">

# HTML Deck

**A visual editor for the HTML files in your workspace: slide decks, reports, and pages written by
you or by an AI agent.**

Click text to edit it, restyle it, move blocks, add effects and present. The file is patched
**only where you changed it**, so a save with no edits is byte-identical.

[![CI](https://github.com/avis309/html-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/avis309/html-deck/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/htmldeck)](https://pypi.org/project/htmldeck/)
[![npm](https://img.shields.io/npm/v/@avis309/htmldeck)](https://www.npmjs.com/package/@avis309/htmldeck)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

<img src="https://raw.githubusercontent.com/avis309/html-deck/main/.github/assets/edit.png" alt="Editing a slide title in HTML Deck" width="900">

</div>

## Why

- **Edits stay minimal.** HTML Deck patches the source text where you made a change and leaves
  everything else as it was, including formatting, comments and the agent's own markup. That keeps
  diffs small and reviewable.
- **Works with your agent.** Pin a note on any element ("make this shorter"), or drag across a slide
  to sweep several blocks and leave one note for the area, then ask Claude Code or Codex to apply
  your HTML Deck notes. The agent reads them, edits the HTML and marks them done.
- **Presents the real thing.** Presentation runs the deck's own scripts and animations in a
  separate frame, so presenting never touches the document you are editing.
- **Local and dependency-free.** One Python 3.11+ standard-library server on `127.0.0.1`. Nothing
  leaves your machine.

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/avis309/html-deck/main/.github/assets/feedback.png" alt="AI Feedback panel with a pinned note"></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/avis309/html-deck/main/.github/assets/present.png" alt="Presenting a deck"></td>
  </tr>
  <tr>
    <td align="center"><b>AI Feedback</b>: pin notes for your agent</td>
    <td align="center"><b>Present</b> with the deck's own animations</td>
  </tr>
</table>

## Install

| Where | Command |
|---|---|
| Claude Code | `/plugin marketplace add avis309/html-deck` then `/plugin install htmldeck@htmldeck` |
| Codex | `codex plugin marketplace add avis309/html-deck` then `codex plugin add htmldeck@htmldeck` |
| uv | `uvx htmldeck` (one-off) · `uv tool install htmldeck` |
| pipx / pip | `pipx install htmldeck` · `pip install htmldeck` |
| npm | `npx @avis309/htmldeck` (one-off) · `npm i -g @avis309/htmldeck` |

HTML Deck needs Python 3.11+ and nothing else. The npm package and the plugins find Python and run
it for you. It works on Linux, macOS and Windows.

## Use it with an agent

In Claude Code or Codex:

1. Ask the agent to *"open q3.html in HTML Deck"*. Claude Code also has `/htmldeck [file]`.
2. Edit in the browser, and pin **AI Feedback** notes where you want the agent to change something.
3. Ask the agent to *"apply my HTML Deck notes"*.

## Run it yourself

```bash
cd ~/my-workspace
htmldeck                 # workspace = current folder
htmldeck --file q3.html  # open a document first
htmldeck --root ~/my-workspace --port 6789 --no-browser
```

To try it on the sample deck from the screenshots (20 slides with anime.js scenes) in a clone of
this repo, run `htmldeck --root samples --file ai-foundation-deck.html`.

The workspace is the folder HTML Deck runs in, or the folder given with `--root`. Every path is
relative to it, and nothing outside it is served or written, except the file passed with `--file`.
Each save keeps a timestamped backup in `.htmldeck_bak/` next to the document.

Review notes live beside each document in `.htmldeck_notes/<name>.json`. Scripts and agents read
and resolve them with:

```bash
htmldeck-notes --file q3.html            # list open notes
htmldeck-notes --file q3.html --prompt   # the same, as a request ready to paste to an agent
htmldeck-notes --file q3.html --done ID  # mark one done
```

A region note (drag from the slide background to select several blocks, then **AI Feedback** on
the group's toolbar) also records the area in CSS pixels of its slide or section and the elements
in it. Versions before 0.1.1 read it as a
note on the whole slide, and drop the region if they rewrite the notes file.

## What it supports

- **Formats:** plain HTML pages and reports; decks of `.slide` blocks; hand-written Reveal.js
  decks, including vertical stacks, fragments, notes and backgrounds. Reveal's Markdown slides
  are read-only.
- **Safe editing:** content that the page's own scripts create or change is locked, and the editor
  shows why. Animations are frozen while editing. You also get undo/redo and draft recovery.
- **Effects:** set `data-fx` entrance effects (fade, zoom, slide, count-up) from the toolbar.
  HTML Deck also manages *scenes*, the document's own animation code. "Enable FX in the file" adds a
  small inline runtime, so effects still run when the file is opened on its own.
- **Isolation:** presentations run on a second origin that has no access to the editor's API. The
  edit view blocks remote scripts (from a CDN, for example) unless you trust the file. Workspace
  files opened directly on the editor origin are sandboxed.

<details>
<summary><b>Develop</b></summary>

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
npm install
npm run check        # eslint (editor modules) + pytest (server) + browser spec
```

- `htmldeck/server.py`: HTTP server, workspace guards, save/backup/notes API, preview origin.
- `htmldeck/web/`: the editor, as native ES modules with no bundler. `js/core` holds the model,
  serializer and history; `js/runtime` holds provenance and motion freeze; also `js/policy`,
  `js/formats` (Reveal), `js/present` and `js/fx` (the effects runtime, which is also inlined
  into documents).
- `tests/spec/characterization.spec.mjs`: black-box Playwright spec over fixtures in a temporary
  workspace. To run it on another workspace's files too:
  `HTMLDECK_REAL_ROOT=… HTMLDECK_REAL_FILES="a.html,b.html" npm run spec`.
- `tools/align-report.mjs`: `npm run align -- <workspace>` reports what share of a workspace's
  HTML files save as an in-place patch. The rest still save correctly, through a full rewrite that
  the editor asks you to confirm.
- Plugin: `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/` (marketplaces),
  `skills/htmldeck/`, `commands/`, and `scripts/htmldeck-run[.cmd]`, which runs this copy with any
  Python 3.11+.
- npm wrapper: `packaging/npm/` bundles `htmldeck/` at pack time and runs it with the user's
  Python.
- Release: run `python tools/bump_version.py X.Y.Z`, commit, then tag `vX.Y.Z` and push the tag.
  `.github/workflows/release.yml` publishes to PyPI, then npm, then creates the GitHub Release.

</details>

## License

[MIT](LICENSE) © Avis
