"""Behaviour that differs by OS: file locking, console encoding, output seen through a pipe."""
import os
import queue
import socket
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

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


def test_replace_retries_while_windows_holds_the_target_open(tmp_path, monkeypatch):
    # Windows refuses to replace a file another process is reading (no FILE_SHARE_DELETE); that clears quickly.
    src, dst = tmp_path / "new", tmp_path / "old"
    src.write_text("new", encoding="utf-8")
    dst.write_text("old", encoding="utf-8")
    real, calls = os.replace, []

    def busy_twice(a, b):
        calls.append(a)
        if len(calls) <= 2:
            raise PermissionError(13, "in use")
        real(a, b)

    monkeypatch.setattr(ed, "_WINDOWS", True)
    monkeypatch.setattr(ed.os, "replace", busy_twice)
    ed._replace(src, dst)
    assert dst.read_text(encoding="utf-8") == "new" and len(calls) == 3


def test_replace_does_not_mask_errors_elsewhere(tmp_path, monkeypatch):
    def denied(a, b):
        raise PermissionError(13, "denied")

    monkeypatch.setattr(ed, "_WINDOWS", False)
    monkeypatch.setattr(ed.os, "replace", denied)
    with pytest.raises(PermissionError):
        ed._replace(tmp_path / "a", tmp_path / "b")


def test_binding_skips_the_reverse_dns_lookup(tmp_path, monkeypatch):
    # HTTPServer.server_bind calls socket.getfqdn, which can stall for seconds (macOS runners) before the URL prints.
    def no_dns(*_):
        raise AssertionError("getfqdn called")

    monkeypatch.setattr(socket, "getfqdn", no_dns)
    monkeypatch.setattr(ed.HTMLEditorHandler, "preview_origin", ed.HTMLEditorHandler.preview_origin)  # restored after
    editor = ed.bind_server(0, attempts=1)
    editor.server_close()
    preview = ed.start_preview_origin(tmp_path)
    preview.shutdown()
    preview.server_close()
