"""HtmlDeck — local Canva-style editor for the HTML documents of a workspace.

Author: Avis (hunganh.freeze@gmail.com). Feedback about the tool goes to that address.

The workspace is the folder HtmlDeck is started in (or ``--root``): every document path is
relative to it. The editor UI ships with this package and is served under ``/__htmldeck/``.
Serves the editor UI plus a small JSON API bound to 127.0.0.1:

- ``GET  /api/config``    default document to open
- ``GET  /api/list_html`` HTML files in the workspace
- ``GET  /api/load``      document source + mtime (for conflict detection)
- ``POST /api/preview``   stage the editor's render of a document next to its source,
  so relative assets and the page's own scripts resolve exactly as they do on disk
- ``POST /api/save``      atomic write with a timestamped backup
- ``POST /api/export``    the editor's text as one self-contained file (images, styles, scripts
                          embedded; files on the web only when asked)
- ``GET/POST /api/notes`` review notes pinned to elements, stored beside the document in
  ``.htmldeck_notes/<name>.json`` (never inside the HTML) so an agent can pick them up with
  ``htmldeck-notes`` (``python -m htmldeck.notes``)

Only ``.html``/``.htm`` files inside the workspace (or the file passed with ``--file``)
can be read or written, dot-directories are never served, and requests must carry a
local Host header — so a web page open in the same browser cannot read or overwrite
files through this server.

Run (in the workspace): htmldeck [--file PATH] [--root DIR] [--port 6789]
     or python -m htmldeck ...
"""

from __future__ import annotations

import argparse
import contextlib
import errno
import http.server
import json
import math
import os
import secrets
import shutil
import socketserver
import sys
import threading
import time
import urllib.parse
import webbrowser
from collections import OrderedDict
from pathlib import Path

_WINDOWS = os.name == "nt"
if _WINDOWS:
    import msvcrt
else:
    import fcntl

# The editor UI ships inside the package; the workspace is chosen at start (default: cwd).
WEB_DIR = Path(__file__).resolve().parent / "web"
EDITOR_HTML = WEB_DIR / "index.html"
EDITOR_PREFIX = "/__htmldeck/"

HTML_SUFFIXES = {".html", ".htm"}
LIST_SKIP_PARTS = {"tmp", "node_modules", "venv", "__pycache__", "site-packages"}
LIST_MAX_FILES = 5000   # a huge folder opened as the workspace must not stall the file list
BACKUP_DIR_NAME = ".htmldeck_bak"
BACKUPS_KEPT = 5
SAVE_LOCK = threading.Lock()
NOTES_DIR_NAME = ".htmldeck_notes"
NOTE_FIELDS = {"id": str, "note": str, "status": str, "created": str, "selector": str, "tag": str, "text": str}
NOTE_STATUSES = {"open", "done"}
MAX_NOTES = 500
MAX_NOTE_TARGETS = 12
MAX_BODY_BYTES = 64 * 1024 * 1024
PREVIEW_PREFIX = "__edpreview-"
# Content-Security-Policy, enforced by the browser (the document's own CSP cannot loosen it):
# - the edit preview runs only scripts from this origin (inline, workspace files) unless the
#   user trusted the file's remote scripts; never service workers or plugins;
# - a workspace HTML file opened directly on the editor origin is sandboxed (opaque origin),
#   so its scripts can never call the editor API;
# - documents on the preview origin (presenting) run freely there, without workers.
# connect-src too: a local loader could otherwise fetch remote code and eval it.
EDIT_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self' blob: data:; worker-src 'none'; object-src 'none'"
EDIT_CSP_TRUSTED = "script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src 'none'; object-src 'none'"
RAW_HTML_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; worker-src 'none'; object-src 'none'"
PREVIEW_ORIGIN_CSP = "worker-src 'none'; object-src 'none'"
PREVIEWS_KEPT = 4


class EditorError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def resolve_html_path(req_path: str | None, root: Path, extra_allowed: frozenset[Path] = frozenset()) -> Path:
    """Map a client-supplied path to an HTML file the editor is allowed to touch."""
    if not req_path:
        raise EditorError(400, "Missing path parameter")
    path = Path(req_path)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if path in extra_allowed:
        return path
    if not path.is_relative_to(root):
        raise EditorError(403, "Only files inside the workspace can be opened")
    if any(part.startswith(".") for part in path.relative_to(root).parts):
        raise EditorError(403, "Files in hidden folders are not opened")
    if path.suffix.lower() not in HTML_SUFFIXES:
        raise EditorError(400, "Only .html / .htm files are supported")
    return path


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def list_html_files(root: Path) -> list[dict]:
    """HTML documents anywhere in the workspace (hidden and tooling folders skipped)."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in LIST_SKIP_PARTS)
        for fname in filenames:
            p = Path(dirpath) / fname
            if fname.startswith(".") or fname.startswith(PREVIEW_PREFIX) or p.suffix.lower() not in HTML_SUFFIXES:
                continue
            stat = p.stat()
            files.append({"path": p.relative_to(root).as_posix(), "size": stat.st_size, "mtime": int(stat.st_mtime)})
            if len(files) >= LIST_MAX_FILES:
                break
        if len(files) >= LIST_MAX_FILES:
            break
    files.sort(key=lambda f: f["path"])
    return files


def load_html(target: Path, root: Path) -> dict:
    if not target.is_file():
        raise EditorError(404, f"File not found: {display_path(target, root)}")
    raw = target.read_bytes()
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise EditorError(415, "File is not UTF-8") from exc
    return {
        "path": display_path(target, root),
        "filename": target.name,
        "size": len(raw),
        "mtime_ns": str(target.stat().st_mtime_ns),
        "content": content,
    }


def _backup(target: Path, stamp: str) -> Path:
    backup_dir = target.parent / BACKUP_DIR_NAME
    backup_dir.mkdir(exist_ok=True)
    backup = backup_dir / f"{target.name}.{stamp}.bak"
    shutil.copy2(target, backup)
    old = sorted(backup_dir.glob(f"{target.name}.*.bak"))
    for stale in old[:-BACKUPS_KEPT]:
        stale.unlink()
    return backup


def save_html(target: Path, content: object, expected_mtime_ns: str | None, force: bool, root: Path) -> dict:
    """Atomically overwrite an existing HTML file, refusing if it changed since load."""
    if not isinstance(content, str) or not content.strip():
        raise EditorError(400, "Content is empty or invalid")
    # The mtime check, backup and replace must be one step, or two tabs can both pass the check.
    with SAVE_LOCK:
        return _save_locked(target, content, expected_mtime_ns, force, root)


def _save_locked(target: Path, content: str, expected_mtime_ns: str | None, force: bool, root: Path) -> dict:
    if not target.is_file():
        raise EditorError(404, "Target file does not exist (the editor does not create files)")
    current = str(target.stat().st_mtime_ns)
    if expected_mtime_ns and not force and current != str(expected_mtime_ns):
        raise EditorError(409, "The file was changed outside the editor since it was opened")

    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
    backup = _backup(target, stamp)
    tmp = target.with_name(f".{target.name}.tmp.{os.getpid()}.{secrets.token_hex(4)}")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(content)
        shutil.copymode(target, tmp)
        _replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)

    return {
        "success": True,
        "file": display_path(target, root),
        "backup": display_path(backup, root),
        "bytes_written": len(content.encode("utf-8")),
        "mtime_ns": str(target.stat().st_mtime_ns),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def export_html(target: Path, content: object, root: Path, fetch_remote: bool) -> dict:
    """The editor's current text of `target` as one self-contained file (see htmldeck.export)."""
    from htmldeck.export import single_file
    if not isinstance(content, str) or not content:
        raise EditorError(400, "Missing content")
    html, report = single_file(content, target, root, fetch_remote)
    return {"success": True, "html": html, **report}


def notes_path(target: Path) -> Path:
    return target.parent / NOTES_DIR_NAME / f"{target.name}.json"


def read_notes(target: Path) -> list[dict]:
    path = notes_path(target)
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("notes", []) if isinstance(data, dict) else []


def _clean_note(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise EditorError(400, "A note must be an object")
    note = {}
    for key, kind in NOTE_FIELDS.items():
        value = raw.get(key, "")
        if not isinstance(value, kind):
            raise EditorError(400, f"Invalid field: {key}")
        note[key] = value[:4000]
    if not note["id"] or not note["note"].strip():
        raise EditorError(400, "A note needs an id and text")
    if note["status"] not in NOTE_STATUSES:
        raise EditorError(400, "status must be open or done")
    for key in ("line", "slide"):
        note[key] = _line(raw.get(key))
    # A region note: one request about an area drawn on a slide. The top-level anchor is the
    # slide (so older readers still see a whole-slide note); the area and the elements found
    # in it ride along. Element notes carry none of these keys.
    if "kind" in raw:
        if raw["kind"] != "region":
            raise EditorError(400, "kind must be region")
        note["kind"] = "region"
        note["region"] = _box(raw.get("region"), ("x", "y", "width", "height"))
        note["canvas"] = _box(raw.get("canvas"), ("width", "height"))
        targets = raw.get("targets", [])
        if not isinstance(targets, list) or len(targets) > MAX_NOTE_TARGETS:
            raise EditorError(400, "Invalid targets")
        note["targets"] = [_clean_target(t) for t in targets]
    return note


def _line(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _box(raw: object, keys: tuple[str, ...]) -> dict:
    """Finite numbers in CSS pixels; width and height must be positive."""
    if not isinstance(raw, dict):
        raise EditorError(400, "Missing region coordinates")
    box = {}
    for key in keys:
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise EditorError(400, f"Invalid coordinate: {key}")
        if key in ("width", "height") and value <= 0:
            raise EditorError(400, f"{key} must be greater than 0")
        box[key] = round(value, 2)
    return box


def _clean_target(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise EditorError(400, "A target must be an object")
    target = {}
    for key in ("selector", "tag", "text"):
        value = raw.get(key, "")
        if not isinstance(value, str):
            raise EditorError(400, f"Invalid field: target.{key}")
        target[key] = value[:4000]
    target["line"] = _line(raw.get("line"))
    return target


def _replace(src: Path, dst: Path) -> None:
    """os.replace, retried briefly on Windows, which refuses while another process reads ``dst``."""
    for _ in range(50 if _WINDOWS else 0):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            time.sleep(0.02)
    os.replace(src, dst)


@contextlib.contextmanager
def _file_lock(path: Path):
    """Exclusive lock on ``path`` shared with other processes: flock on POSIX, a one-byte lock on Windows."""
    with open(path, "a+") as fh:
        if _WINDOWS:
            fh.seek(0)
            while True:
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError as exc:   # LK_LOCK gives up after ~10 s; keep waiting, as flock does
                    if exc.errno != errno.EDEADLOCK:
                        raise
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


@contextlib.contextmanager
def _notes_lock(target: Path):
    """Cross-process lock: the editor and htmldeck-notes may both edit the same sidecar."""
    lock_dir = notes_path(target).parent
    lock_dir.mkdir(exist_ok=True)
    with SAVE_LOCK, _file_lock(lock_dir / ".lock"):
        yield


def _write_notes_file(target: Path, notes: list[dict], root: Path) -> None:
    path = notes_path(target)
    tmp = path.with_name(f".{path.name}.tmp.{secrets.token_hex(4)}")
    try:
        tmp.write_text(json.dumps({"file": display_path(target, root), "notes": notes}, ensure_ascii=False, indent=2), encoding="utf-8")
        _replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def write_notes(target: Path, notes: object, root: Path) -> dict:
    """Replace the review notes of a document (atomic, validated)."""
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        raise EditorError(400, "Invalid note list")
    if not target.is_file():
        raise EditorError(404, "Target file does not exist")
    cleaned = [_clean_note(n) for n in notes]
    with _notes_lock(target):
        _write_notes_file(target, cleaned, root)
    return {"success": True, "count": len(cleaned), "notes_file": display_path(notes_path(target), root)}


# The drawn region is a capture snapshot: re-anchoring after a save moves the anchors
# (selector, line, targets), never the area.
NOTE_PATCH_FIELDS = {"status", "note", "selector", "line", "text", "tag", "targets"}


def apply_note_ops(target: Path, ops: object, root: Path) -> dict:
    """Apply add/update/delete operations against the sidecar as it is on disk right now,
    so a stale copy in one client can never undo another client's change."""
    if not isinstance(ops, list) or not ops:
        raise EditorError(400, "Missing list of operations")
    if not target.is_file():
        raise EditorError(404, "Target file does not exist")
    with _notes_lock(target):
        notes = read_notes(target)
        by_id = {n.get("id"): n for n in notes}
        for op in ops:
            kind = op.get("op") if isinstance(op, dict) else None
            if kind == "add":
                note = _clean_note(op.get("note"))
                if note["id"] in by_id:
                    raise EditorError(409, "Duplicate note id")
                notes.append(note)
                by_id[note["id"]] = note
            elif kind == "update":
                current = by_id.get(op.get("id"))
                if current is None:
                    continue
                patch = {k: v for k, v in (op.get("patch") or {}).items() if k in NOTE_PATCH_FIELDS}
                merged = _clean_note({**current, **patch})
                current.clear()
                current.update(merged)
            elif kind == "delete":
                notes = [n for n in notes if n.get("id") != op.get("id")]
                by_id.pop(op.get("id"), None)
            else:
                raise EditorError(400, "Invalid note operation")
        if len(notes) > MAX_NOTES:
            raise EditorError(400, "Too many notes")
        _write_notes_file(target, notes, root)
    return {"success": True, "notes": notes, "notes_file": display_path(notes_path(target), root)}


def preview_url(source: Path | None, root: Path) -> str:
    """URL for a staged preview that sits in the same directory as its source file."""
    rel_dir = ""
    if source is not None and source.parent.is_relative_to(root):
        rel_dir = source.parent.relative_to(root).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir
    name = f"{PREVIEW_PREFIX}{secrets.token_hex(8)}.html"
    parts = [urllib.parse.quote(p) for p in rel_dir.split("/") if p] + [name]
    return "/" + "/".join(parts)


class HTMLEditorHandler(http.server.SimpleHTTPRequestHandler):
    root: Path = Path.cwd()
    target_file: Path | None = None   # --file: opened first, allowed even outside the workspace
    explicit_file: bool = False  # --file given: open it instead of the browser's last file
    test_hooks: bool = False  # --test-hooks: the UI honours fault-injection URL params (spec only)
    editor_html: Path = EDITOR_HTML
    previews: OrderedDict[str, tuple[bytes, str]] = OrderedDict()   # edit previews: (body, CSP)
    present_previews: OrderedDict[str, bytes] = OrderedDict()       # served by the preview origin
    previews_lock = threading.Lock()
    preview_origin: str = ""
    # Pinned, not left to the host's mime.types: a module served with any other type is
    # refused by the browser and the editor comes up blank.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
        ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json",
    }

    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return self.extensions_map.get(ext) or super().guess_type(path)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.root), **kwargs)

    # --- request guards -------------------------------------------------
    def _local_origins(self) -> set[str]:
        port = self.server.server_address[1]
        return {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in self._local_origins()

    def _same_origin_fetch(self) -> bool:
        # Set by the browser, not by page scripts. The preview origin (another port) is
        # same-site, not same-origin, so it is refused like any other site.
        return self.headers.get("Sec-Fetch-Site") == "same-origin"

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        parsed = urllib.parse.urlparse(origin)
        return parsed.scheme == "http" and parsed.netloc in self._local_origins()

    # --- routing --------------------------------------------------------
    def do_GET(self):
        if not self._host_ok():
            self._send_json({"error": "Invalid Host"}, 403)
            return
        parsed = urllib.parse.urlparse(self.path)
        route = {
            "/api/config": self._api_config,
            "/api/list_html": self._api_list_html,
            "/api/load": self._api_load,
            "/api/notes": self._api_notes_get,
        }.get(parsed.path)
        if route:
            if not self._same_origin_fetch():
                self._send_json({"error": "Only the editor may call the API"}, 403)
                return
            self._run_api(route, parsed)
            return
        if parsed.path in ("/", "/index.html"):
            self.send_response(302)
            # Keep the query so /?file=<path> still opens that file.
            query = "?" + parsed.query if parsed.query else ""
            self.send_header("Location", EDITOR_PREFIX + "index.html" + query)
            self.end_headers()
            return
        if parsed.path.startswith(EDITOR_PREFIX):
            self._send_editor_file(parsed.path[len(EDITOR_PREFIX):])
            return
        with self.previews_lock:
            staged = self.previews.get(parsed.path)
        if staged is not None:
            body, csp = staged
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", csp)
            self.end_headers()
            self.wfile.write(body)
            return
        rel = urllib.parse.unquote(parsed.path).lstrip("/")
        if any(part.startswith(".") for part in Path(rel).parts):
            self.send_error(404)
            return
        # A symlink must not expose files outside the workspace or inside hidden directories.
        real = Path(self.translate_path(self.path)).resolve()
        if not real.is_relative_to(self.root) or any(part.startswith(".") for part in real.relative_to(self.root).parts):
            self.send_error(404)
            return
        # Every workspace response: a directory URL serving its index.html, an SVG or XML
        # opened as a document must all be sandboxed (CSP is ignored on images, styles and
        # scripts, so this costs nothing elsewhere). The editor's own files are served above.
        self._csp = RAW_HTML_CSP
        super().do_GET()

    def _send_editor_file(self, rel: str):
        """The editor UI, from the package's web/ folder (never from the workspace)."""
        rel = urllib.parse.unquote(rel)
        target = (self.editor_html.parent / rel).resolve()
        web = self.editor_html.parent.resolve()
        if not target.is_relative_to(web) or any(p.startswith(".") for p in target.relative_to(web).parts) or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        self.send_error(405)

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok() or not self._same_origin_fetch():
            self._send_json({"error": "Invalid Origin"}, 403)
            return
        parsed = urllib.parse.urlparse(self.path)
        route = {"/api/save": self._api_save, "/api/preview": self._api_preview, "/api/notes": self._api_notes_post,
                 "/api/export": self._api_export}.get(parsed.path)
        if route is None:
            self.send_error(404, "Endpoint not found")
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._send_json({"error": "Content-Type must be application/json"}, 415)
            return
        self._run_api(route, parsed)

    def list_directory(self, path):
        self.send_error(404)
        return None

    # --- API ------------------------------------------------------------
    def _run_api(self, handler, parsed):
        try:
            self._send_json(handler(parsed))
        except EditorError as exc:
            self._send_json({"error": str(exc)}, exc.status)
        except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _allowed_extra(self) -> frozenset[Path]:
        return frozenset({self.target_file}) if self.target_file else frozenset()

    def _api_config(self, parsed):
        return {
            "default_path": display_path(self.target_file, self.root) if self.target_file else None,
            "explicit": self.explicit_file,
            "test_hooks": self.test_hooks,
            "preview_origin": self.preview_origin,
        }

    def _api_list_html(self, parsed):
        return {"files": list_html_files(self.root)}

    def _api_load(self, parsed):
        req_path = urllib.parse.parse_qs(parsed.query).get("path", [None])[0]
        target = resolve_html_path(req_path, self.root, self._allowed_extra())
        return load_html(target, self.root)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise EditorError(413, "Invalid body size")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise EditorError(400, "Body must be a JSON object")
        return payload

    def _api_preview(self, parsed):
        payload = self._read_json()
        content = payload.get("content")
        if not isinstance(content, str):
            raise EditorError(400, "Missing content")
        source = payload.get("path")
        source_path = resolve_html_path(source, self.root, self._allowed_extra()) if source else None
        url = preview_url(source_path, self.root)
        # Presenting runs the document on the preview origin, away from this API.
        if payload.get("target") == "present":
            if not self.preview_origin:
                raise EditorError(503, "The presentation origin is not running")
            with self.previews_lock:
                self.present_previews[url] = content.encode("utf-8")
                while len(self.present_previews) > PREVIEWS_KEPT:
                    self.present_previews.popitem(last=False)
            return {"url": self.preview_origin + url}
        csp = EDIT_CSP_TRUSTED if payload.get("trust_remote") is True else EDIT_CSP
        with self.previews_lock:
            self.previews[url] = (content.encode("utf-8"), csp)
            while len(self.previews) > PREVIEWS_KEPT:
                self.previews.popitem(last=False)
        return {"url": url}

    def _api_notes_get(self, parsed):
        req_path = urllib.parse.parse_qs(parsed.query).get("path", [None])[0]
        target = resolve_html_path(req_path, self.root, self._allowed_extra())
        return {"notes": read_notes(target), "notes_file": display_path(notes_path(target), self.root)}

    def _api_notes_post(self, parsed):
        payload = self._read_json()
        target = resolve_html_path(payload.get("path"), self.root, self._allowed_extra())
        return apply_note_ops(target, payload.get("ops"), self.root)

    def _api_save(self, parsed):
        payload = self._read_json()
        target = resolve_html_path(payload.get("path"), self.root, self._allowed_extra())
        return save_html(target, payload.get("content"), payload.get("mtime_ns"), bool(payload.get("force")), self.root)

    def _api_export(self, parsed):
        payload = self._read_json()
        target = resolve_html_path(payload.get("path"), self.root, self._allowed_extra())
        return export_html(target, payload.get("content"), self.root, bool(payload.get("remote")))

    def _send_json(self, data: dict, status_code: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    _csp: str | None = None

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        if self._csp:
            self.send_header("Content-Security-Policy", self._csp)
        super().end_headers()

    def log_message(self, format, *args):
        if args and "/api/" in str(args[0]):
            sys.stdout.write(f"[editor] {args[0]} - {args[1]}\n")
            sys.stdout.flush()


class PreviewOriginHandler(http.server.SimpleHTTPRequestHandler):
    """The preview origin: a second port that only serves workspace files and staged present
    previews. No API, no editor UI: a document presented here cannot reach either."""

    root: Path = Path.cwd()
    extensions_map = HTMLEditorHandler.extensions_map
    guess_type = HTMLEditorHandler.guess_type

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.root), **kwargs)

    def do_GET(self):
        port = self.server.server_address[1]
        if self.headers.get("Host", "") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            self.send_error(403)
            return
        parsed = urllib.parse.urlparse(self.path)
        with HTMLEditorHandler.previews_lock:
            staged = HTMLEditorHandler.present_previews.get(parsed.path)
        if staged is not None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(staged)))
            self.send_header("Content-Security-Policy", PREVIEW_ORIGIN_CSP)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(staged)
            return
        rel = urllib.parse.unquote(parsed.path).lstrip("/")
        if parsed.path.startswith(EDITOR_PREFIX) or rel.startswith("api/") or any(p.startswith(".") for p in Path(rel).parts):
            self.send_error(404)
            return
        real = Path(self.translate_path(self.path)).resolve()
        if not real.is_relative_to(self.root) or any(p.startswith(".") for p in real.relative_to(self.root).parts):
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Content-Security-Policy", PREVIEW_ORIGIN_CSP)
        super().end_headers()

    def do_HEAD(self):
        self.send_error(405)

    def do_POST(self):
        self.send_error(405)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format, *args):
        pass


class LocalServer(http.server.ThreadingHTTPServer):
    """ThreadingHTTPServer without the reverse DNS lookup (socket.getfqdn) in server_bind, which can
    stall startup for seconds on macOS; the server only ever listens on 127.0.0.1."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def start_preview_origin(root: Path) -> LocalServer:
    """Bind the preview origin on a free port and serve it in the background."""
    handler = type("PreviewOrigin", (PreviewOriginHandler,), {"root": root})
    srv = LocalServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    HTMLEditorHandler.preview_origin = f"http://127.0.0.1:{srv.server_address[1]}"
    return srv


def utf8_stdio() -> None:
    """Print Vietnamese/Chinese messages even through a pipe in a legacy code page (Windows cp1252)."""
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")


def bind_server(start_port: int, attempts: int = 50) -> LocalServer:
    for port in range(start_port, start_port + attempts):
        try:
            return LocalServer(("127.0.0.1", port), HTMLEditorHandler)
        except OSError:
            continue
    raise SystemExit(f"No free port in {start_port}-{start_port + attempts - 1}")


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(prog="htmldeck", description="Edit and present the HTML documents of a workspace")
    parser.add_argument("--root", help="Workspace folder (default: the current folder, or the folder of --file when it lies outside it)")
    parser.add_argument("--file", help="HTML file to open first (relative to the workspace, or absolute)")
    parser.add_argument("--port", type=int, default=6789, help="First port to try")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser")
    parser.add_argument("--dry", action="store_true", help="Validate arguments and exit")
    parser.add_argument("--test-hooks", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    utf8_stdio()

    root = Path(args.root or ".").expanduser().resolve()
    if not root.is_dir():
        print(f"Error: not a folder: {root}", file=sys.stderr)
        sys.exit(1)
    target = None
    if args.file:
        target = Path(args.file).expanduser()
        target = (target if target.is_absolute() else root / target).resolve()
        if not target.is_file() or target.suffix.lower() not in HTML_SUFFIXES:
            print(f"Error: not a valid HTML file: {target}", file=sys.stderr)
            sys.exit(1)
        # A document's relative assets (images, CSS) are served from the workspace only, so the
        # document has to be inside it: without --root, its own folder becomes the workspace.
        if not target.is_relative_to(root):
            if args.root:
                print(f"Error: {target} is outside the workspace {root} — pass a --root that contains it, or drop --root", file=sys.stderr)
                sys.exit(1)
            root = target.parent
    if not EDITOR_HTML.is_file():
        print(f"Error: editor UI missing: {EDITOR_HTML}", file=sys.stderr)
        sys.exit(1)
    if args.dry:
        print(f"[dry] root={root} file={display_path(target, root) if target else '-'} editor={EDITOR_HTML}")
        return

    HTMLEditorHandler.root = root
    HTMLEditorHandler.target_file = target
    HTMLEditorHandler.explicit_file = bool(args.file)
    HTMLEditorHandler.test_hooks = args.test_hooks
    httpd = bind_server(args.port)
    preview = start_preview_origin(root)
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    print("============================================================")
    print("  HtmlDeck · by Avis (hunganh.freeze@gmail.com)")
    print(f"  Workspace     : {root}")
    print(f"  Open first    : {display_path(target, root) if target else '(last file / pick from the list)'}")
    print(f"  Editor URL    : {url}")
    print(f"  Preview origin: {HTMLEditorHandler.preview_origin}  (presenting, no API)")
    print("============================================================")
    print(f"HTMLDECK_URL={url}", flush=True)   # stable, untranslated: agents read the URL from this line
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nEditor server stopped.")
    finally:
        httpd.server_close()
        preview.shutdown()
        preview.server_close()


if __name__ == "__main__":
    main()
