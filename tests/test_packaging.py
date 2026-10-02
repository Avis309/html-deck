"""What a published wheel contains: the whole editor UI, MIT license metadata, no old author email."""
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


def test_no_old_author_email_in_tracked_files():
    out = subprocess.run(["git", "grep", "-l", "anhnh8@vng.com.vn", "--", ".", ":!tests/test_packaging.py"], cwd=REPO, capture_output=True, text=True)
    assert out.stdout == ""


def test_wheel_ships_the_whole_editor(tmp_path):
    pytest.importorskip("build")
    subprocess.run([sys.executable, "-m", "build", "--wheel", "--outdir", str(tmp_path), str(REPO)],
                   check=True, capture_output=True)
    wheel = next(tmp_path.glob("htmldeck-*.whl"))
    with zipfile.ZipFile(wheel) as zf:
        names = set(zf.namelist())
        meta = zf.read(next(n for n in names if n.endswith(".dist-info/METADATA"))).decode()
    web = REPO / "htmldeck" / "web"
    expected = {"htmldeck/" + p.relative_to(REPO / "htmldeck").as_posix() for p in web.rglob("*") if p.is_file()}
    assert expected <= names, sorted(expected - names)
    assert "License-Expression: MIT" in meta
    assert "hunganh.freeze@gmail.com" in meta
