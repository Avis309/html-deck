"""What a published wheel contains: the whole editor UI and MIT license metadata."""
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


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
