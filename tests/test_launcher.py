"""The plugin launcher runs the plugin's own copy of HtmlDeck with whatever Python ≥ 3.11 is on PATH."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
posix_only = pytest.mark.skipif(os.name == "nt", reason="sh launcher")
windows_only = pytest.mark.skipif(os.name != "nt", reason="cmd launcher")


@pytest.fixture
def plugin(tmp_path):
    """A copy of the plugin (scripts + package) somewhere else, like Claude/Codex's plugin cache."""
    root = tmp_path / "plugin"
    shutil.copytree(REPO / "scripts", root / "scripts")
    shutil.copytree(REPO / "htmldeck", root / "htmldeck", ignore=shutil.ignore_patterns("__pycache__"))
    return root


@pytest.fixture
def workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def _expected_editor(plugin):
    return str((plugin / "htmldeck" / "web" / "index.html").resolve())


def test_launcher_runs_its_own_copy(plugin, workspace):
    # The dev venv has htmldeck installed from REPO; the launcher must still use the copy beside it.
    res = subprocess.run([sys.executable, str(plugin / "scripts" / "launcher.py"), "--dry", "--root", str(workspace)],
                         capture_output=True, text=True, encoding="utf-8", check=False)
    assert res.returncode == 0, res.stderr
    assert f"editor={_expected_editor(plugin)}" in res.stdout


def test_launcher_notes_subcommand(plugin, workspace):
    (workspace / "a.html").write_text("<p>x</p>", encoding="utf-8")
    res = subprocess.run([sys.executable, str(plugin / "scripts" / "launcher.py"), "notes", "--root", str(workspace), "--file", "a.html"],
                         capture_output=True, text=True, encoding="utf-8", check=False)
    assert res.returncode == 0, res.stderr
    assert "a.html" in res.stdout


def _shim_dir(tmp_path, name, body):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    shim = bindir / name
    shim.write_text(body, encoding="utf-8")
    shim.chmod(0o755)
    return bindir


@posix_only
def test_sh_launcher_finds_python_on_path(plugin, workspace, tmp_path):
    bindir = _shim_dir(tmp_path, "python3", f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    res = subprocess.run(["/bin/sh", str(plugin / "scripts" / "htmldeck-run"), "--dry", "--root", str(workspace)],
                         capture_output=True, text=True, env={"PATH": str(bindir)}, check=False)
    assert res.returncode == 0, res.stderr
    assert f"editor={_expected_editor(plugin)}" in res.stdout


@posix_only
def test_sh_launcher_without_python_explains_and_exits_127(plugin, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    res = subprocess.run(["/bin/sh", str(plugin / "scripts" / "htmldeck-run"), "--dry"],
                         capture_output=True, text=True, env={"PATH": str(empty)}, check=False)
    assert res.returncode == 127
    assert "Python" in res.stderr and "3.11" in res.stderr


@posix_only
def test_sh_launcher_is_executable_in_git():
    mode = subprocess.run(["git", "ls-files", "-s", "scripts/htmldeck-run"], cwd=REPO, capture_output=True, text=True,
                          check=False).stdout
    assert mode.startswith("100755")


@windows_only
def test_cmd_launcher_finds_python_on_path(plugin, workspace, tmp_path):
    bindir = _shim_dir(tmp_path, "python.bat", f'@"{sys.executable}" %*\r\n')
    env = {"PATH": f"{bindir};{os.environ['SystemRoot']}\\System32", "SystemRoot": os.environ["SystemRoot"]}
    res = subprocess.run(["cmd", "/c", str(plugin / "scripts" / "htmldeck-run.cmd"), "--dry", "--root", str(workspace)],
                         capture_output=True, text=True, encoding="utf-8", env=env, check=False)
    assert res.returncode == 0, res.stderr
    assert f"editor={_expected_editor(plugin)}" in res.stdout
