"""Export a document as one self-contained HTML file: what it loads is embedded in it.

Stylesheets become <style> (their url() and @import too), scripts become inline <script>, and
images, media, fonts and icons become data: URIs, so the file can be emailed, shared or opened
offline. Only the tags and attributes that reference something are rewritten; everything else is
kept as written.

Local files are read only inside the workspace (never hidden ones such as .env). Files on the web
(a CDN script, web fonts) are fetched only when asked; otherwise they are listed in the report.

  python -m htmldeck.export --file deck.html [--remote] [-o out.html]
"""

from __future__ import annotations

import argparse
import base64
import html as html_lib
import mimetypes
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

MAX_REMOTE_BYTES = 25 * 1024 * 1024
REMOTE_TIMEOUT = 20
# Attributes that load a file, per tag. srcset lists several, handled apart.
URL_ATTRS = {
    "img": ("src",), "source": ("src",), "video": ("src", "poster"), "audio": ("src",), "track": ("src",),
    "input": ("src",), "embed": ("src",), "object": ("data",),
}
ICON_RELS = {"icon", "shortcut icon", "apple-touch-icon", "mask-icon"}
CSS_URL = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);""", re.I)
MIME_FIX = {".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml",
            ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".avif": "image/avif"}


class _Resolver:
    """Reads what a reference points at, within the rules; remembers what it could not embed."""

    def __init__(self, root: Path, allowed: list[Path], fetch_remote: bool):
        self.root, self.allowed, self.fetch_remote = root, allowed, fetch_remote
        self.embedded: set[str] = set()
        self.missing: list[str] = []
        self.remote: list[str] = []
        self.cache: dict[str, tuple[bytes, str] | None] = {}

    def _note(self, bucket: list[str], ref: str) -> None:
        if ref not in bucket:
            bucket.append(ref)

    def read(self, ref: str, base: str) -> tuple[bytes, str, str] | None:
        """→ (bytes, mime, absolute base for the file's own references), or None to leave `ref`."""
        ref = ref.strip()
        if not ref or ref.startswith(("data:", "#", "blob:", "about:", "javascript:", "mailto:")):
            return None
        absolute = urllib.parse.urljoin(base, ref)
        url = urllib.parse.urlsplit(absolute)
        if url.scheme in ("http", "https"):
            if not self.fetch_remote:
                self._note(self.remote, ref)
                return None
            got = self._fetch(absolute)
        elif url.scheme == "file" and base.startswith("file:"):
            got = self._local(Path(urllib.request.url2pathname(url.path)))
        else:
            got = None
        if got is None:
            if ref not in self.remote:
                self._note(self.missing, ref)
            return None
        data, mime = got
        self.embedded.add(urllib.parse.urldefrag(absolute)[0])
        return data, mime, absolute

    def _local(self, path: Path) -> tuple[bytes, str] | None:
        key = str(path)
        if key not in self.cache:
            self.cache[key] = None
            try:
                path = path.resolve()
                inside = next((d for d in self.allowed if path.is_relative_to(d)), None)
                if inside and path.is_file() and not any(p.startswith(".") for p in path.relative_to(inside).parts):
                    self.cache[key] = (path.read_bytes(), _mime(path.name))
            except OSError:
                pass
        return self.cache[key]

    def _fetch(self, url: str) -> tuple[bytes, str] | None:
        if url not in self.cache:
            self.cache[url] = None
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (HTML Deck export)"})
                with urllib.request.urlopen(req, timeout=REMOTE_TIMEOUT) as res:
                    data = res.read(MAX_REMOTE_BYTES + 1)
                    if len(data) <= MAX_REMOTE_BYTES:
                        mime = res.headers.get_content_type()
                        if mime in ("application/octet-stream", "text/plain"):
                            mime = _mime(urllib.parse.urlsplit(url).path)
                        self.cache[url] = (data, mime)
            except (OSError, ValueError):
                pass
        return self.cache[url]


def _mime(name: str) -> str:
    ext = Path(name).suffix.lower()
    return MIME_FIX.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def _data_uri(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _text(data: bytes) -> str:
    return data.decode("utf-8-sig", errors="replace")


def _css(css: str, base: str, res: _Resolver, depth: int = 0) -> str:
    """A stylesheet with its @import inlined and its url() as data URIs."""
    def imp(m: re.Match) -> str:
        got = res.read(m.group(2), base) if depth < 8 else None
        if not got:
            return m.group(0)
        inner = _css(_text(got[0]), got[2], res, depth + 1)
        media = m.group(3).strip()
        return f"@media {media}{{{inner}}}" if media else inner

    def url(m: re.Match) -> str:
        got = res.read(m.group(2), base)
        return f"url({_data_uri(got[0], got[1])})" if got else m.group(0)

    return CSS_URL.sub(url, CSS_IMPORT.sub(imp, css))


def _srcset(value: str, base: str, res: _Resolver) -> str:
    out = []
    for part in value.split(","):
        bits = part.strip().split(None, 1)
        if not bits:
            continue
        got = res.read(urllib.parse.unquote(bits[0]) if not bits[0].startswith(("http:", "https:")) else bits[0], base)
        out.append(" ".join([_data_uri(got[0], got[1]) if got else bits[0]] + bits[1:]))
    return ", ".join(out)


def _attr(name: str, value: str | None) -> str:
    return f" {name}" if value is None else f' {name}="{value.replace("&", "&amp;").replace(chr(34), "&quot;")}"'


class _Rewriter(HTMLParser):
    """Collects (start, end, replacement) edits on the source text; nothing else is touched."""

    def __init__(self, src: str, base: str, res: _Resolver):
        super().__init__(convert_charrefs=False)
        self.src, self.base, self.res = src, base, res
        self.edits: list[tuple[int, int, str]] = []
        self.lines = [0] + [m.end() for m in re.finditer("\n", src)]
        self.pending_script: tuple[int, str] | None = None   # (start of <script>, its new start tag)
        self.in_style = False

    def _off(self) -> int:
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self._off()
        text = self.get_starttag_text()
        end = start + len(text)
        a = dict(attrs)
        if tag == "link" and (a.get("rel") or "").lower() == "stylesheet" and a.get("href"):
            got = self.res.read(_unescape(a["href"]), self.base)
            if got:
                media = f' media="{a["media"]}"' if a.get("media") else ""
                css = _css(_text(got[0]), got[2], self.res).replace("</style", "<\\/style")
                self.edits.append((start, end, f"<style{media}>{css}</style>"))
            return
        if tag == "link" and (a.get("rel") or "").lower() in ICON_RELS and a.get("href"):
            self._replace_attrs(start, end, tag, attrs, {"href": _unescape(a["href"])})
            return
        if tag == "script":
            self.pending_script = None
            src = a.get("src")
            typ = (a.get("type") or "").lower()
            if src and typ != "module":
                got = self.res.read(_unescape(src), self.base)
                if got:
                    keep = "".join(_attr(k, v) for k, v in attrs if k not in ("src", "integrity", "crossorigin", "defer", "async"))
                    code = _text(got[0])
                    self.pending_script = (start, f"<script{keep}>" + re.sub(r"</(script)", r"<\\/\1", code, flags=re.I))
            return
        if tag == "style":
            self.in_style = True
        changes = {k: _unescape(v) for k, v in attrs if v and k in URL_ATTRS.get(tag, ())}
        if a.get("srcset") and tag in ("img", "source"):
            changes["srcset"] = None
        if a.get("style") and "url(" in a["style"]:
            changes["style"] = None
        if changes:
            self._replace_attrs(start, end, tag, attrs, changes)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def _replace_attrs(self, start, end, tag, attrs, changes):
        """Rebuild the start tag with the loaded files embedded (the export is a derived file:
        quoting may be normalised, every attribute and its value are kept)."""
        parts, changed = [], False
        for k, v in attrs:
            if k in changes and v:
                raw = _unescape(v)
                if k == "srcset":
                    new = _srcset(raw, self.base, self.res)
                elif k == "style":
                    new = _css(raw, self.base, self.res)
                else:
                    got = self.res.read(raw, self.base)
                    new = _data_uri(got[0], got[1]) if got else raw
                changed |= new != raw
                parts.append(_attr(k, new))
            else:
                parts.append(_attr(k, None if v is None else _unescape(v)))
        if changed:
            text = self.get_starttag_text()
            self.edits.append((start, end, f"<{text[1:1 + len(tag)]}{''.join(parts)}{'/>' if text.endswith('/>') else '>'}"))

    def handle_endtag(self, tag):
        if tag == "script" and self.pending_script:
            start, head = self.pending_script
            self.pending_script = None
            end = self._off() + len("</script>")
            self.edits.append((start, end, head + "</script>"))
        if tag == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style and "url(" in data or self.in_style and "@import" in data:
            start = self._off()
            new = _css(data, self.base, self.res)
            if new != data:
                self.edits.append((start, start + len(data), new.replace("</style", "<\\/style")))


def _unescape(v: str) -> str:
    return html_lib.unescape(v)


def single_file(html: str, doc: Path, root: Path, fetch_remote: bool = False) -> tuple[str, dict]:
    """`html` (the document's text) with what it loads embedded, and a report of what was not."""
    doc = doc.resolve()
    root = root.resolve()
    allowed = [root] if doc.is_relative_to(root) else [doc.parent]
    res = _Resolver(root, allowed, fetch_remote)
    base = doc.as_uri()
    m = re.search(r"""<base\s[^>]*href\s*=\s*["']([^"']+)""", html, re.I)
    if m:
        base = urllib.parse.urljoin(base, m.group(1))
    rw = _Rewriter(html, base, res)
    rw.feed(html)
    rw.close()
    out, last = [], 0
    for start, end, new in sorted(rw.edits):
        if start < last:
            continue
        out.append(html[last:start])
        out.append(new)
        last = end
    out.append(html[last:])
    return "".join(out), {"embedded": len(res.embedded), "missing": res.missing, "remote": res.remote}


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="Export an HTML document as one self-contained file")
    parser.add_argument("--root", default=".", help="Workspace folder (default: the current folder)")
    parser.add_argument("--file", required=True, help="HTML document to export")
    parser.add_argument("--remote", action="store_true", help="Also download and embed files from the web (CDN scripts, web fonts)")
    parser.add_argument("-o", "--output", help="Output file (default: <name>.single.html beside the document)")
    args = parser.parse_args(argv)
    root = Path(args.root).expanduser().resolve()
    doc = Path(args.file).expanduser()
    doc = (doc if doc.is_absolute() else root / doc).resolve()
    html, rep = single_file(doc.read_text(encoding="utf-8"), doc, root, args.remote)
    out = Path(args.output) if args.output else doc.with_name(doc.stem + ".single.html")
    out.write_text(html, encoding="utf-8", newline="")
    print(f"{out} · {len(html.encode('utf-8')) // 1024} KB · {rep['embedded']} file(s) embedded")
    for ref in rep["missing"]:
        print(f"  not found, kept as a link: {ref}")
    for ref in rep["remote"]:
        print(f"  on the web, kept as a link (use --remote to embed): {ref}")
    if rep["missing"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
