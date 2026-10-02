# HtmlDeck

Local editor for the HTML documents of a workspace — slide decks, reports, pages written by
people or AI agents. Click text to edit it, restyle, move blocks, add effects, present — and
the file is patched **only where you changed it** (an unedited save is byte-identical).

Author: Avis ([email removed]).

## Run

```bash
pip install -e ~/htmldeck            # or: python -m htmldeck from this repo
cd ~/my-workspace
htmldeck                             # workspace = current folder
htmldeck --file decks/q3.html        # open a document first
htmldeck --root ~/my-workspace --port 8765 --no-browser
```

The workspace is the folder HtmlDeck runs in (or `--root`): every path is relative to it and
nothing outside it is served or written (except the file passed with `--file`). The editor UI
ships with the package and is served under `/__htmldeck/`.

Review notes pinned in the editor ("AI Feedback") live beside each document in
`.htmldeck_notes/<name>.json`; an agent reads and resolves them with:

```bash
htmldeck-notes --file decks/q3.html            # list open notes
htmldeck-notes --file decks/q3.html --done ID  # mark one done
```

Saves keep a timestamped backup in `.htmldeck_bak/` next to the document.

## What it supports

- **Formats:** plain HTML pages and reports; decks of `.slide` blocks; Reveal.js decks written
  by hand (vertical stacks, fragments, notes, backgrounds; Markdown slides read-only).
- **Safe editing:** content created or changed by the page's own scripts is locked with the
  reason shown; animations are frozen in the edit view; undo/redo; draft recovery.
- **Present:** in a separate frame running the deck's own scripts (and Reveal's own runtime),
  so presenting never touches the edited document or its undo history.
- **Effects:** `data-fx` entrance effects (fade, zoom, slide, count-up) set from the toolbar,
  and *scenes* — the document's own animation code — whose lifecycle HtmlDeck manages.
  "Enable FX in the file" adds a small inline runtime so effects also run when the file is
  opened on its own.
- **Isolation:** presenting runs on a second origin with no API; the edit view blocks remote
  scripts (CDN…) by CSP unless you trust the file; workspace files opened directly on the
  editor origin are sandboxed. Scripts inline or inside the workspace are trusted as the
  author's own.

## Sample

`samples/ai-foundation-deck.html` — a 29-slide deck with anime.js scenes and the FX runtime
embedded. `htmldeck --root samples --file ai-foundation-deck.html`.

## Develop

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
npm install
npm run check        # eslint (editor modules) + pytest (server) + browser spec
```

- `htmldeck/server.py` — HTTP server, workspace guards, save/backup/notes API, preview origin.
- `htmldeck/web/` — the editor (native ES modules, no bundler): `js/core` model, serializer,
  history; `js/runtime` provenance, motion freeze; `js/policy`; `js/formats` (Reveal);
  `js/present`; `js/fx` (effects runtime, also inlined into documents).
- `tests/spec/characterization.spec.mjs` — black-box Playwright spec (fixtures in a temp
  workspace, plus the sample deck; needs network for its CDN script). Run it on another
  workspace's files with `HTMLDECK_REAL_ROOT=… HTMLDECK_REAL_FILES="a.html,b.html" npm run spec`.
- `tools/align-report.mjs` — `npm run align -- <workspace>`: share of a workspace's HTML files
  that saves patch in place (the rest still save correctly, by a full rewrite the editor asks
  for). The source tokenizer follows the HTML parser's common repairs (implied html/head/body/
  tbody, stray `</p>` and `</br>`); if this share drops on real decks, a spec-complete
  tokenizer (parse5 with source locations) is the next step.
- `docs/plans/` — design plans of each phase (written while the tool lived in another repo:
  paths like `output/htmldeck/` there are `htmldeck/web/` here).

## Roadmap

Next: package as a plugin for Claude Code and Codex, working on the user's workspace.
Optional extras from the plans: token swatches, Marp, single-file export, Slidev.
