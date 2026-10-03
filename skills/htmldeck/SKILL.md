---
name: htmldeck
description: Open the HTML documents of the user's workspace (slide decks, Reveal.js decks, reports, pages) in the HTML Deck visual editor to edit text, restyle, move blocks, add effects and present, saving in place; and act on the review notes ("AI Feedback") the user pinned there. Use when the user wants to edit, tweak, present or review an HTML deck/report/page visually, mentions HTML Deck, or asks to apply the feedback or notes left on an HTML document.
---

# HTML Deck

HTML Deck is a local editor for the workspace's HTML files. The user edits in the browser; you start
the editor and act on the notes they leave. A save patches the file only where it changed.

## The launcher

The plugin root is two folders above this file (`<this skill's folder>/../..`); Claude Code also
sets it as `${CLAUDE_PLUGIN_ROOT}`. The launcher runs the plugin's own copy with any Python ≥ 3.11,
nothing to install:

- macOS / Linux: `sh "<plugin root>/scripts/htmldeck-run"`
- Windows: `"<plugin root>/scripts/htmldeck-run.cmd"`

Below, `RUN` stands for that command. Exit code 127 means no Python 3.11+: pass on the install hint
it prints.

## Open the editor

1. The workspace is the project folder the user works in: `--root "<workspace>"`. Add
   `--file <path>` (relative to the workspace) to open one document first.
2. Start it in the background — the server runs until stopped:
   - Claude Code: Bash with `run_in_background: true`: `RUN --root "<workspace>" --file "<doc>"`
   - Other shells (macOS/Linux): `RUN --root "<workspace>" --file "<doc>" > "${TMPDIR:-/tmp}/htmldeck.log" 2>&1 &`
   - PowerShell: `Start-Process -WindowStyle Hidden -FilePath "<plugin root>/scripts/htmldeck-run.cmd" -ArgumentList '--root','"<workspace>"','--file','"<doc>"' -RedirectStandardOutput "$env:TEMP\htmldeck.log" -RedirectStandardError "$env:TEMP\htmldeck.err"` (errors land in `htmldeck.err`)
3. Read its output until the line `HTMLDECK_URL=http://127.0.0.1:<port>` and give the user that URL.
   The browser opens by itself; add `--no-browser` when there is no desktop (SSH, container) or the
   user asked not to.
4. If a server you started earlier in this conversation still runs for the same workspace, give
   that URL again instead of starting another — other documents open from inside the editor.

## Act on review notes

Notes the user pins to elements, or to a region drawn on a slide, live in
`.htmldeck_notes/<name>.json` beside the document.

1. List open notes: `RUN notes --root "<workspace>" --file "<doc>"` — each shows an id, the current
   line, a CSS selector, a text snippet and what the user wants. A region note also
   gives the area in CSS pixels of its slide (or section) and the elements found in it, each with
   a selector and line: the request applies to that whole area. `--prompt` prints the same notes as
   one ready-made request.
2. Edit the HTML source there yourself, keeping the change minimal.
3. Mark each one done: `RUN notes --root "<workspace>" --file "<doc>" --done <id>` (`--done` repeats).
4. If the document is open in the editor, ask the user to reload it: the editor refuses to save over
   a file changed on disk.

## Rules

- Only documents inside the workspace. Never edit `.htmldeck_notes/` or `.htmldeck_bak/` (backups) by hand.
