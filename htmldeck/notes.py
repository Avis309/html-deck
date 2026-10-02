"""List (or resolve) review notes pinned in the HTML editor, for an agent to act on.

Notes live beside the document in ``.htmldeck_notes/<name>.json``. Each carries the CSS
selector of the element, the source line at the time it was pinned, and a text snippet;
this runner re-locates the line in the current file so it stays useful after edits.

Run (in the workspace, or with --root):
  htmldeck-notes --file output/deck.html
  htmldeck-notes --file output/deck.html --done <id>
  (or python -m htmldeck.notes ...)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from htmldeck.server import EditorError, apply_note_ops, display_path, notes_path, read_notes


def current_line(source: str, note: dict) -> int | None:
    """Line of the note's snippet nearest to where it was pinned, else the pinned line."""
    snippet = " ".join(note.get("text", "").split())[:40]
    pinned = note.get("line")
    lines = []
    idx = source.find(snippet) if snippet else -1
    while idx >= 0:
        lines.append(source.count("\n", 0, idx) + 1)
        idx = source.find(snippet, idx + 1)
    if not lines:
        return pinned
    return min(lines, key=lambda n: abs(n - pinned)) if pinned else lines[0]


def format_notes(target: Path, notes: list[dict], show_all: bool, root: Path | None = None) -> str:
    root = root or Path.cwd()
    source = target.read_text(encoding="utf-8") if target.is_file() else ""
    shown = [n for n in notes if show_all or n.get("status") == "open"]
    if not shown:
        return f"Không có ghi chú {'nào' if show_all else 'đang mở'} cho {display_path(target, root)}."
    lines = [f"# Ghi chú cần sửa — {display_path(target, root)} ({len(shown)})", ""]
    for i, n in enumerate(shown, 1):
        where = [f"dòng {current_line(source, n) or '?'}"]
        if n.get("slide") is not None:
            where.append(f"slide {n['slide'] + 1}")
        lines.append(f"{i}. [{n['status']}] id={n['id']} · {' · '.join(where)} · <{n.get('tag', '?')}>")
        lines.append(f"   selector: {n.get('selector', '')}")
        if n.get("text"):
            lines.append(f"   đoạn chữ: \"{n['text'][:160]}\"")
        lines.append(f"   → {n['note']}")
        lines.append("")
    return "\n".join(lines).rstrip()


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="List review notes left in the HTML editor")
    parser.add_argument("--root", default=".", help="Workspace folder (default: the current folder)")
    parser.add_argument("--file", required=True, help="HTML document the notes belong to")
    parser.add_argument("--all", action="store_true", help="Include notes already marked done")
    parser.add_argument("--done", metavar="ID", action="append", default=[], help="Mark a note as done (repeatable)")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    target = Path(args.file).expanduser()
    target = (target if target.is_absolute() else root / target).resolve()
    notes = read_notes(target)
    if args.done:
        known = {n["id"] for n in notes}
        missing = [i for i in args.done if i not in known]
        if missing:
            print(f"Không tìm thấy ghi chú: {', '.join(missing)}", file=sys.stderr)
            sys.exit(1)
        try:
            apply_note_ops(target, [{"op": "update", "id": i, "patch": {"status": "done"}} for i in args.done], root)
        except EditorError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            sys.exit(1)
        print(f"Đã đánh dấu xong {len(args.done)} ghi chú → {display_path(notes_path(target), root)}")
        return
    print(format_notes(target, notes, args.all, root))


if __name__ == "__main__":
    main()
