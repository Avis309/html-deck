"""`npm pack` → install the tarball → its `htmldeck` bin runs the Python copy shipped inside it."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
NPM = shutil.which("npm")


@pytest.mark.skipif(NPM is None, reason="npm not installed")
def test_npm_package_runs_its_bundled_python(tmp_path):
    subprocess.run([NPM, "pack", "--pack-destination", str(tmp_path)], cwd=REPO / "packaging" / "npm",
                   check=True, capture_output=True)
    tarball = next(tmp_path.glob("avis309-htmldeck-*.tgz"))
    prefix = tmp_path / "inst"
    subprocess.run([NPM, "install", "--prefix", str(prefix), "--offline", "--no-audit", "--no-fund", str(tarball)],
                   check=True, capture_output=True)
    pkg = prefix / "node_modules" / "@avis309" / "htmldeck"
    assert (pkg / "LICENSE").is_file() and (pkg / "README.md").is_file()
    assert not list(pkg.rglob("__pycache__"))
    exe = prefix / "node_modules" / ".bin" / ("htmldeck.cmd" if os.name == "nt" else "htmldeck")
    ws = tmp_path / "ws"
    ws.mkdir()
    res = subprocess.run([str(exe), "--dry", "--root", str(ws)], capture_output=True, text=True, encoding="utf-8", check=False)
    assert res.returncode == 0, res.stderr
    assert f"editor={(pkg / 'python' / 'htmldeck' / 'web' / 'index.html').resolve()}" in res.stdout
