"""Server-side guarantees of the HTML editor: path confinement, safe saves, request guards."""
import http.client
import json
import os
import threading

import pytest

from htmldeck import server as ed


@pytest.fixture
def root(tmp_path):
    (tmp_path / "output" / "deck").mkdir(parents=True)
    (tmp_path / "output" / "deck" / "a.html").write_text("<p>a</p>", encoding="utf-8")
    (tmp_path / "output" / "tmp").mkdir()
    (tmp_path / "output" / "tmp" / "skip.html").write_text("x", encoding="utf-8")
    (tmp_path / "output" / ".hidden").mkdir()
    (tmp_path / "output" / ".hidden" / "secret.html").write_text("x", encoding="utf-8")
    (tmp_path / ".env").write_text("TOKEN=1", encoding="utf-8")
    return tmp_path.resolve()


def test_resolve_accepts_workspace_html(root):
    assert ed.resolve_html_path("output/deck/a.html", root) == root / "output/deck/a.html"


@pytest.mark.parametrize("req, status", [
    ("../outside.html", 403),
    ("/etc/passwd.html", 403),
    ("output/.hidden/secret.html", 403),
    ("output/deck/a.txt", 400),
    ("", 400),
    (None, 400),
])
def test_resolve_rejects_unsafe_paths(root, req, status):
    with pytest.raises(ed.EditorError) as exc:
        ed.resolve_html_path(req, root)
    assert exc.value.status == status


def test_resolve_allows_explicit_cli_target_outside_root(root, tmp_path_factory):
    outside = tmp_path_factory.mktemp("elsewhere") / "x.html"
    outside.write_text("x", encoding="utf-8")
    assert ed.resolve_html_path(str(outside), root, frozenset({outside.resolve()})) == outside.resolve()


def test_list_skips_tmp_hidden_and_previews(root):
    (root / "output" / "deck" / f"{ed.PREVIEW_PREFIX}abc.html").write_text("x", encoding="utf-8")
    assert [f["path"] for f in ed.list_html_files(root)] == ["output/deck/a.html"]


def test_list_covers_the_whole_workspace(root):
    # Any layout: documents at the root or in any folder, not just output/ and docs/.
    (root / "deck.html").write_text("x", encoding="utf-8")
    (root / "slides" / "q3").mkdir(parents=True)
    (root / "slides" / "q3" / "talk.htm").write_text("x", encoding="utf-8")
    (root / "node_modules" / "pkg").mkdir(parents=True)
    (root / "node_modules" / "pkg" / "readme.html").write_text("x", encoding="utf-8")
    assert [f["path"] for f in ed.list_html_files(root)] == ["deck.html", "output/deck/a.html", "slides/q3/talk.htm"]


def test_main_uses_the_folder_of_a_file_outside_the_workspace(tmp_path, monkeypatch, capsys):
    doc = tmp_path / "talks" / "q3.html"
    doc.parent.mkdir()
    doc.write_text("<p>x</p>", encoding="utf-8")
    other = tmp_path / "ws"
    other.mkdir()
    monkeypatch.chdir(other)
    ed.main(["--file", str(doc), "--dry"])
    assert f"root={doc.parent}" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        ed.main(["--root", str(other), "--file", str(doc), "--dry"])


def test_save_writes_backup_and_new_mtime(root):
    target = root / "output/deck/a.html"
    mtime = ed.load_html(target, root)["mtime_ns"]
    res = ed.save_html(target, "<p>b</p>", mtime, False, root)
    assert target.read_text(encoding="utf-8") == "<p>b</p>"
    backups = list((target.parent / ed.BACKUP_DIR_NAME).glob("a.html.*.bak"))
    assert len(backups) == 1 and backups[0].read_text(encoding="utf-8") == "<p>a</p>"
    assert res["mtime_ns"] == str(target.stat().st_mtime_ns)
    assert not list(target.parent.glob(".a.html.tmp.*"))


def test_save_refuses_when_file_changed_since_load(root):
    target = root / "output/deck/a.html"
    stale = ed.load_html(target, root)["mtime_ns"]
    target.write_text("<p>changed elsewhere</p>", encoding="utf-8")
    os.utime(target, ns=(int(stale) + 5_000_000_000, int(stale) + 5_000_000_000))
    with pytest.raises(ed.EditorError) as exc:
        ed.save_html(target, "<p>mine</p>", stale, False, root)
    assert exc.value.status == 409
    assert target.read_text(encoding="utf-8") == "<p>changed elsewhere</p>"
    ed.save_html(target, "<p>mine</p>", stale, True, root)
    assert target.read_text(encoding="utf-8") == "<p>mine</p>"


def test_save_rotates_backups(root):
    target = root / "output/deck/a.html"
    for i in range(ed.BACKUPS_KEPT + 3):
        ed.save_html(target, f"<p>{i}</p>", None, False, root)
    assert len(list((target.parent / ed.BACKUP_DIR_NAME).glob("a.html.*.bak"))) == ed.BACKUPS_KEPT


@pytest.mark.parametrize("content, status", [("", 400), ("   ", 400), (None, 400)])
def test_save_rejects_empty_content(root, content, status):
    with pytest.raises(ed.EditorError) as exc:
        ed.save_html(root / "output/deck/a.html", content, None, False, root)
    assert exc.value.status == status


def test_save_never_creates_new_files(root):
    with pytest.raises(ed.EditorError) as exc:
        ed.save_html(root / "output/deck/new.html", "<p>x</p>", None, False, root)
    assert exc.value.status == 404


def test_preview_url_sits_next_to_source(root):
    url = ed.preview_url(root / "output/deck/a.html", root)
    assert url.startswith(f"/output/deck/{ed.PREVIEW_PREFIX}") and url.endswith(".html")
    assert ed.preview_url(None, root).count("/") == 1


@pytest.fixture
def server(root):
    handler = type("H", (ed.HTMLEditorHandler,), {"root": root, "target_file": root / "output/deck/a.html"})
    handler.previews = ed.OrderedDict()
    httpd = ed.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def _request(port, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    # What the browser sends for the editor's own fetches (page scripts cannot set it).
    hdrs = {"Host": f"127.0.0.1:{port}", "Sec-Fetch-Site": "same-origin"}
    hdrs.update(headers or {})
    conn.request(method, path, body=body, headers=hdrs)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    return res.status, data


def _symlink_or_skip(link, target):
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as exc:   # Windows without the symlink privilege
        pytest.skip(f"symlinks not permitted: {exc}")


def test_http_config_reports_whether_file_was_explicit(server):
    status, data = _request(server, "GET", "/api/config")
    assert status == 200
    # test_hooks is off unless the server is started with --test-hooks (spec only).
    assert json.loads(data) == {"default_path": "output/deck/a.html", "explicit": False, "test_hooks": False, "preview_origin": ""}


def test_http_root_redirect_keeps_query(server):
    conn = http.client.HTTPConnection("127.0.0.1", server, timeout=5)
    conn.request("GET", "/?file=output/deck/a.html", headers={"Host": f"127.0.0.1:{server}"})
    res = conn.getresponse()
    res.read()
    conn.close()
    assert res.status == 302 and res.getheader("Location").endswith("?file=output/deck/a.html")


def test_http_rejects_foreign_host(server):
    status, _ = _request(server, "GET", "/api/load?path=output/deck/a.html", headers={"Host": "evil.example"})
    assert status == 403


def test_http_blocks_dotfiles(server):
    assert _request(server, "GET", "/.env")[0] == 404


def test_http_save_requires_json_and_same_origin(server):
    body = json.dumps({"path": "output/deck/a.html", "content": "<p>pwn</p>"})
    assert _request(server, "POST", "/api/save", body, {"Content-Type": "text/plain"})[0] == 415
    cross = {"Content-Type": "application/json", "Origin": "https://evil.example"}
    assert _request(server, "POST", "/api/save", body, cross)[0] == 403
    ok = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{server}"}
    status, data = _request(server, "POST", "/api/save", body, ok)
    assert status == 200 and json.loads(data)["success"]


def test_http_preview_roundtrip(server):
    body = json.dumps({"path": "output/deck/a.html", "content": "<p>staged</p>"})
    status, data = _request(server, "POST", "/api/preview", body, {"Content-Type": "application/json"})
    assert status == 200
    url = json.loads(data)["url"]
    status, page = _request(server, "GET", url)
    assert status == 200 and page == b"<p>staged</p>"


def test_http_api_requires_same_origin_fetch(server):
    # Another port of 127.0.0.1 (the preview origin) is same-site, not same-origin.
    body = json.dumps({"path": "output/deck/a.html", "content": "<p>pwn</p>"})
    for site in ("same-site", "cross-site", "none", None):
        hdrs = {"Content-Type": "application/json", "Sec-Fetch-Site": site} if site else {"Content-Type": "application/json"}
        conn = http.client.HTTPConnection("127.0.0.1", server, timeout=5)
        conn.request("POST", "/api/save", body=body, headers={"Host": f"127.0.0.1:{server}", **{k: v for k, v in hdrs.items()}})
        res = conn.getresponse()
        res.read()
        conn.close()
        assert res.status == 403, site
    assert _request(server, "GET", "/api/config", headers={"Sec-Fetch-Site": "same-site"})[0] == 403


def _head(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers={"Host": f"127.0.0.1:{port}"})
    res = conn.getresponse()
    res.read()
    conn.close()
    return res.status, res.getheader("Content-Security-Policy") or ""


def test_http_edit_preview_csp_blocks_remote_scripts_unless_trusted(server):
    for trust, remote in ((False, False), (True, True)):
        body = json.dumps({"path": "output/deck/a.html", "content": "<p>x</p>", "trust_remote": trust})
        url = json.loads(_request(server, "POST", "/api/preview", body, {"Content-Type": "application/json"})[1])["url"]
        status, csp = _head(server, url)
        assert status == 200 and "worker-src 'none'" in csp
        assert ("script-src *" in csp) == remote
        assert ("connect-src 'self'" in csp) == (not remote)


def test_http_workspace_html_is_sandboxed_on_editor_origin(server, root):
    status, csp = _head(server, "/output/deck/a.html")
    assert status == 200 and csp.startswith("sandbox")
    # A directory URL serving its index.html, and an SVG opened as a document, likewise.
    (root / "output/demo").mkdir(parents=True)
    (root / "output/demo/index.html").write_text("<script>x()</script>", encoding="utf-8")
    (root / "output/demo/pic.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>", encoding="utf-8")
    for path in ("/output/demo/", "/output/demo/pic.svg"):
        status, csp = _head(server, path)
        assert status == 200 and csp.startswith("sandbox"), path


def test_preview_origin_serves_presented_documents_without_api(root):
    handler = type("H", (ed.HTMLEditorHandler,), {"root": root, "target_file": root / "output/deck/a.html"})
    handler.previews, handler.present_previews = ed.OrderedDict(), ed.OrderedDict()
    pv = type("P", (ed.PreviewOriginHandler,), {"root": root})
    ed.HTMLEditorHandler.present_previews = handler.present_previews
    a = ed.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    b = ed.http.server.ThreadingHTTPServer(("127.0.0.1", 0), pv)
    for srv in (a, b):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        handler.preview_origin = f"http://127.0.0.1:{b.server_address[1]}"
        body = json.dumps({"path": "output/deck/a.html", "content": "<p>show</p>", "target": "present"})
        url = json.loads(_request(a.server_address[1], "POST", "/api/preview", body, {"Content-Type": "application/json"})[1])["url"]
        assert url.startswith(handler.preview_origin)
        path = url[len(handler.preview_origin):]
        status, csp = _head(b.server_address[1], path)
        assert status == 200 and "worker-src 'none'" in csp
        assert _head(a.server_address[1], path)[0] == 404          # not on the editor origin
        assert _head(b.server_address[1], "/api/config")[0] == 404  # no API on the preview origin
        assert _head(b.server_address[1], "/output/deck/a.html")[0] == 200
    finally:
        for srv in (a, b):
            srv.shutdown()
            srv.server_close()


def test_http_does_not_follow_symlinks_out_of_root(server, root, tmp_path_factory):
    outside = tmp_path_factory.mktemp("secret")
    (outside / "id_rsa").write_text("KEY", encoding="utf-8")
    _symlink_or_skip(root / "output" / "link", outside)
    assert _request(server, "GET", "/output/link/id_rsa")[0] == 404


def test_concurrent_saves_with_same_mtime_only_one_wins(root):
    target = root / "output/deck/a.html"
    mtime = ed.load_html(target, root)["mtime_ns"]
    results = []

    def attempt(text):
        try:
            ed.save_html(target, text, mtime, False, root)
            results.append("ok")
        except ed.EditorError as exc:
            results.append(exc.status)

    threads = [threading.Thread(target=attempt, args=(f"<p>{i}</p>",)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 1 and results.count(409) == 5
    assert not list(target.parent.glob(".a.html.tmp.*"))


def _note(**over):
    base = {"id": "n1", "note": "Đổi tiêu đề", "status": "open", "created": "2026-09-27", "selector": "#h1", "tag": "h1", "text": "Game Growth", "line": 3, "slide": 0}
    base.update(over)
    return base


def test_notes_roundtrip_live_beside_document_not_inside(root):
    target = root / "output/deck/a.html"
    res = ed.write_notes(target, [_note()], root)
    assert res["count"] == 1 and res["notes_file"] == f"output/deck/{ed.NOTES_DIR_NAME}/a.html.json"
    assert ed.read_notes(target)[0]["note"] == "Đổi tiêu đề"
    assert target.read_text(encoding="utf-8") == "<p>a</p>"


@pytest.mark.parametrize("bad", [_note(status="later"), _note(note="  "), _note(id=""), "x", _note(selector=5)])
def test_notes_reject_invalid_entries(root, bad):
    with pytest.raises(ed.EditorError):
        ed.write_notes(root / "output/deck/a.html", [bad], root)


def test_list_notes_relocates_line_by_text(root):
    from htmldeck import notes as ln
    target = root / "output/deck/a.html"
    target.write_text("<html>\n<body>\n\n<h1>Game Growth</h1>\n</body></html>", encoding="utf-8")
    out = ln.format_notes(target, [_note(), _note(id="n2", status="done")], show_all=False)
    assert "dòng 4" in out and "slide 1" in out and "n2" not in out


def test_list_notes_prefers_occurrence_nearest_pinned_line():
    from htmldeck import notes as ln
    source = "<nav>Agenda</nav>\n" + "\n" * 10 + "<h2>Agenda</h2>\n"
    assert ln.current_line(source, _note(text="Agenda", line=12)) == 12
    assert ln.current_line(source, _note(text="Agenda", line=None)) == 1
    assert ln.current_line(source, _note(text="missing", line=7)) == 7


def test_note_ops_merge_against_disk_not_stale_client_copy(root):
    target = root / "output/deck/a.html"
    ed.apply_note_ops(target, [{"op": "add", "note": _note(id="A")}], root)
    # agent marks A done; an editor holding a stale list then adds B
    ed.apply_note_ops(target, [{"op": "update", "id": "A", "patch": {"status": "done"}}], root)
    res = ed.apply_note_ops(target, [{"op": "add", "note": _note(id="B")}], root)
    assert [(n["id"], n["status"]) for n in res["notes"]] == [("A", "done"), ("B", "open")]
    res = ed.apply_note_ops(target, [{"op": "delete", "id": "A"}], root)
    assert [n["id"] for n in res["notes"]] == ["B"]
    with pytest.raises(ed.EditorError):
        ed.apply_note_ops(target, [{"op": "add", "note": _note(id="B")}], root)


def test_http_symlink_into_hidden_dir_is_blocked(server, root):
    _symlink_or_skip(root / "output" / "alias", root / "output" / ".hidden")
    assert _request(server, "GET", "/output/alias/secret.html")[0] == 404


def test_editor_assets_have_pinned_mime_even_if_host_table_is_wrong(monkeypatch):
    import mimetypes

    # A host mime.types that maps .mjs/.css wrongly must not reach the browser.
    monkeypatch.setitem(mimetypes.types_map, ".mjs", "application/octet-stream")
    monkeypatch.setitem(mimetypes.types_map, ".css", "text/plain")
    handler = ed.HTMLEditorHandler.__new__(ed.HTMLEditorHandler)
    assert handler.guess_type("htmldeck/web/js/app.mjs") == "text/javascript"
    assert handler.guess_type("htmldeck/web/css/editor.css") == "text/css"
    assert handler.guess_type("output/x/pic.svg") == "image/svg+xml"
