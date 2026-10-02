"""Set HtmlDeck's version everywhere it is declared; pyproject.toml is the source of truth.

  python tools/bump_version.py 0.2.0          write 0.2.0 into pyproject.toml and every manifest
  python tools/bump_version.py --check 0.2.0  exit 1 unless every one of them already says 0.2.0
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_MANIFESTS = (".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "packaging/npm/package.json")
PYPROJECT_VERSION = re.compile(r'^version = "([^"]+)"', re.M)
JSON_VERSION = re.compile(r'^(  "version": ")[^"]*(")', re.M)   # the top-level key, two-space indent
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def manifest_versions(root: Path = ROOT) -> dict[str, str]:
    versions = {"pyproject.toml": PYPROJECT_VERSION.search((root / "pyproject.toml").read_text(encoding="utf-8")).group(1)}
    for rel in JSON_MANIFESTS:
        versions[rel] = json.loads((root / rel).read_text(encoding="utf-8"))["version"]
    return versions


def _replace_in(path: Path, pattern: re.Pattern, repl: str) -> None:
    # Bytes in, bytes out: only the version changes, never the layout or the line endings.
    text, count = pattern.subn(repl, path.read_bytes().decode("utf-8"), count=1)
    if count != 1:
        raise SystemExit(f"{path}: no version field to replace")
    path.write_bytes(text.encode("utf-8"))


def write_version(version: str, root: Path = ROOT) -> None:
    _replace_in(root / "pyproject.toml", PYPROJECT_VERSION, f'version = "{version}"')
    for rel in JSON_MANIFESTS:
        _replace_in(root / rel, JSON_VERSION, rf"\g<1>{version}\g<2>")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set or check HtmlDeck's version in every manifest")
    parser.add_argument("version", help="X.Y.Z")
    parser.add_argument("--check", action="store_true", help="Only verify; exit 1 on any mismatch")
    args = parser.parse_args(argv)
    if not SEMVER.match(args.version):
        print(f"not a X.Y.Z version: {args.version}", file=sys.stderr)
        return 2
    if args.check:
        wrong = {rel: v for rel, v in manifest_versions().items() if v != args.version}
        for rel, v in wrong.items():
            print(f"{rel}: {v} (expected {args.version})", file=sys.stderr)
        return 1 if wrong else 0
    write_version(args.version)
    print(f"version {args.version} → pyproject.toml, {', '.join(JSON_MANIFESTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
