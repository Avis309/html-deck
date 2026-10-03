"""List (or resolve) review notes pinned in the HTML editor, for an agent to act on.

Notes live beside the document in ``.htmldeck_notes/<name>.json``. Each carries the CSS
selector of the element, the source line at the time it was pinned, and a text snippet;
this runner re-locates the line in the current file so it stays useful after edits.

Run (in the workspace, or with --root):
  htmldeck-notes --file output/deck.html
  htmldeck-notes --file output/deck.html --done <id>
  htmldeck-notes --file output/deck.html --prompt   (a request ready to paste to an agent)
  (or python -m htmldeck.notes ...)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from htmldeck.server import EditorError, apply_note_ops, display_path, notes_path, read_notes, utf8_stdio


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


def _px(v: float) -> int:
    return round(v)


def _note_lines(source: str, n: dict, i: int) -> list[str]:
    where = [f"dòng {current_line(source, n) or '?'}"]
    if n.get("slide") is not None:
        where.append(f"slide {n['slide'] + 1}")
    region = n.get("kind") == "region"
    lines = [f"{i}. [{n['status']}] id={n['id']} · {' · '.join(where)} · <{n.get('tag', '?')}>{' · vùng khoanh' if region else ''}",
             f"   selector: {n.get('selector', '')}"]
    if region:
        # The area is in CSS pixels of the slide (or report section) it was drawn on.
        r, c = n["region"], n["canvas"]
        owner = "slide" if n.get("slide") is not None else "mục"
        lines.append(f"   vùng x={_px(r['x'])} y={_px(r['y'])} rộng {_px(r['width'])} cao {_px(r['height'])}"
                     f" (px trên {owner} {_px(c['width'])}×{_px(c['height'])}, tính từ góc trên trái)")
        if not n.get("targets"):
            lines.append("   phần tử trong vùng: không có phần tử nào (vùng trống hoặc nền) — xem toạ độ vùng")
        else:
            lines.append("   phần tử trong vùng:")
            for k, t in enumerate(n["targets"], 1):
                text = " ".join(t.get("text", "").split())[:80]
                lines.append(f"     {k}) <{t.get('tag', '?')}> {t.get('selector', '')} · dòng {current_line(source, t) or '?'}"
                             + (f' · "{text}"' if text else ""))
    elif n.get("text"):
        lines.append(f"   đoạn chữ: \"{n['text'][:160]}\"")
    lines.append(f"   → {n['note']}")
    lines.append("")
    return lines


def format_notes(target: Path, notes: list[dict], show_all: bool, root: Path | None = None) -> str:
    root = root or Path.cwd()
    source = target.read_text(encoding="utf-8") if target.is_file() else ""
    shown = [n for n in notes if show_all or n.get("status") == "open"]
    if not shown:
        return f"Không có ghi chú {'nào' if show_all else 'đang mở'} cho {display_path(target, root)}."
    lines = [f"# Ghi chú cần sửa — {display_path(target, root)} ({len(shown)})", ""]
    for i, n in enumerate(shown, 1):
        lines += _note_lines(source, n, i)
    return "\n".join(lines).rstrip()


def _shq(value: str) -> str:
    """Single-quoted for a POSIX shell, like the editor's copy button."""
    return "'" + value.replace("'", "'\\''") + "'"


def format_prompt(target: Path, notes: list[dict], root: Path | None = None) -> str:
    """The open notes as one request an agent can act on directly."""
    root = root or Path.cwd()
    name = display_path(target, root)
    source = target.read_text(encoding="utf-8") if target.is_file() else ""
    shown = [n for n in notes if n.get("status") == "open"]
    if not shown:
        return f"Không có ghi chú đang mở cho {name}."
    lines = [
        f"Sửa {name} theo {len(shown)} ghi chú dưới đây (feedback để lại trong HTML Deck).",
        "- Chỉ sửa file này, đúng chỗ được chỉ; giữ nguyên định dạng và phần còn lại của file.",
        "- Selector và số dòng chỉ để tìm chỗ: đọc lại file hiện tại trước khi sửa.",
        "- Ghi chú vùng khoanh: yêu cầu áp cho cả vùng; danh sách phần tử là những gì nằm trong vùng lúc khoanh.",
        "",
    ]
    for i, n in enumerate(shown, 1):
        lines += _note_lines(source, n, i)
    lines += ["Xong ghi chú nào thì đánh dấu đã xong:", f"htmldeck-notes --file {_shq(name)} --done <id>"]
    return "\n".join(lines)


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="List review notes left in the HTML editor")
    parser.add_argument("--root", default=".", help="Workspace folder (default: the current folder)")
    parser.add_argument("--file", required=True, help="HTML document the notes belong to")
    parser.add_argument("--all", action="store_true", help="Include notes already marked done")
    parser.add_argument("--done", metavar="ID", action="append", default=[], help="Mark a note as done (repeatable)")
    parser.add_argument("--prompt", action="store_true", help="Print the open notes as a request ready to paste to an agent")
    args = parser.parse_args(argv)
    utf8_stdio()

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
    print(format_prompt(target, notes, root) if args.prompt else format_notes(target, notes, args.all, root))


if __name__ == "__main__":
    main()
