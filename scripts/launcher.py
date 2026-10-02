"""Run HtmlDeck from this plugin's own copy — no install needed, any Python ≥ 3.11 (standard library only).

Usage: launcher.py [notes] [args...]   ``notes`` runs htmldeck-notes, anything else the editor server.
The copy beside this script always wins over an htmldeck installed elsewhere, so the plugin's skill
and the code it drives never drift apart.
"""

import sys
from pathlib import Path

if sys.version_info < (3, 11):
    sys.stderr.write(f"htmldeck: cần Python >= 3.11 (đang chạy {sys.version.split()[0]}) — "
                     "cài từ https://www.python.org/downloads/ hoặc chạy: uv python install 3.12\n")
    sys.exit(127)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main(argv: list[str]) -> None:
    if argv[:1] == ["notes"]:
        from htmldeck.notes import main as run
        argv = argv[1:]
    else:
        from htmldeck.server import main as run
    run(argv)


if __name__ == "__main__":
    main(sys.argv[1:])
