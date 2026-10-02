"""Behaviour that differs by OS: file locking, console encoding, output seen through a pipe."""
import os
import queue
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

from htmldeck import server as ed

REPO = Path(__file__).resolve().parent.parent
ENV = {**os.environ, "PYTHONPATH": str(REPO)}


def test_file_lock_excludes_another_process(tmp_path):
    lock = tmp_path / ".lock"
    holder = textwrap.dedent("""
        import sys, time
        from pathlib import Path
        from htmldeck.server import _file_lock
        with _file_lock(Path(sys.argv[1])):
            print("locked", flush=True)
            time.sleep(1.0)
    """)
    child = subprocess.Popen([sys.executable, "-c", holder, str(lock)], stdout=subprocess.PIPE, text=True, env=ENV)
    try:
        assert child.stdout.readline().strip() == "locked"
        start = time.monotonic()
        with ed._file_lock(lock):
            waited = time.monotonic() - start
    finally:
        child.wait(timeout=15)
    assert waited >= 0.5


def test_cli_output_is_utf8_on_a_legacy_code_page(tmp_path):
    (tmp_path / "a.html").write_text("<p>x</p>", encoding="utf-8")
    env = {**ENV, "PYTHONIOENCODING": "cp1252"}   # what a Windows pipe gets by default
    res = subprocess.run([sys.executable, "-m", "htmldeck.notes", "--root", str(tmp_path), "--file", "a.html"],
                         capture_output=True, env=env, check=False)
    assert res.returncode == 0, res.stderr.decode("utf-8", "replace")
    assert "đang mở" in res.stdout.decode("utf-8")


def test_banner_url_line_is_flushed_when_piped(tmp_path):
    proc = subprocess.Popen([sys.executable, "-m", "htmldeck", "--root", str(tmp_path), "--no-browser", "--port", "0"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV)
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: [lines.put(raw) for raw in proc.stdout], daemon=True).start()
    try:
        deadline = time.monotonic() + 10
        url = None
        while url is None and time.monotonic() < deadline:
            try:
                line = lines.get(timeout=0.5).decode("utf-8", "replace").strip()
            except queue.Empty:
                continue
            if line.startswith("HTMLDECK_URL="):
                url = line.split("=", 1)[1]
        assert url and url.startswith("http://127.0.0.1:")
    finally:
        proc.terminate()
        proc.wait(timeout=10)
