"""Plugin manifests for Claude Code and Codex, the shared skill, and one version everywhere."""
import importlib.util
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("bump_version", REPO / "tools" / "bump_version.py")
bump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bump)


def _json(rel):
    return json.loads((REPO / rel).read_text(encoding="utf-8"))


def _frontmatter(rel):
    text = (REPO / rel).read_text(encoding="utf-8")
    assert text.startswith("---\n"), rel
    head = text[4:text.index("\n---", 4)]
    return dict(line.split(": ", 1) for line in head.splitlines() if ": " in line)


def test_all_manifests_name_the_same_plugin():
    assert _json(".claude-plugin/plugin.json")["name"] == "htmldeck"
    assert _json(".codex-plugin/plugin.json")["name"] == "htmldeck"
    assert _json("packaging/npm/package.json")["name"] == "htmldeck"
    claude_mp = _json(".claude-plugin/marketplace.json")
    assert claude_mp["plugins"] == [{**claude_mp["plugins"][0], "name": "htmldeck", "source": "./"}]
    codex_mp = _json(".agents/plugins/marketplace.json")
    assert codex_mp["plugins"][0]["name"] == "htmldeck"
    assert codex_mp["plugins"][0]["source"] == {"source": "local", "path": "./"}


def test_manifests_carry_author_and_license():
    for rel in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        data = _json(rel)
        assert data["license"] == "MIT"
        assert data["author"]["email"] == "hunganh.freeze@gmail.com"


def test_codex_manifest_points_at_the_skills():
    data = _json(".codex-plugin/plugin.json")
    assert (REPO / data["skills"] / "htmldeck" / "SKILL.md").is_file()
    assert data["interface"]["displayName"] == "HTML Deck"


def test_skill_and_command_have_frontmatter():
    skill = _frontmatter("skills/htmldeck/SKILL.md")
    assert skill["name"] == "htmldeck" and len(skill["description"]) > 80
    assert _frontmatter("commands/htmldeck.md")["description"]


def test_skill_names_files_that_exist():
    text = (REPO / "skills/htmldeck/SKILL.md").read_text(encoding="utf-8")
    for rel in ("scripts/htmldeck-run", "scripts/htmldeck-run.cmd"):
        assert rel in text and (REPO / rel).is_file()
    assert "HTMLDECK_URL=" in text


def test_versions_agree_everywhere():
    versions = bump.manifest_versions(REPO)
    assert set(versions) == {"pyproject.toml", *bump.JSON_MANIFESTS}
    assert len(set(versions.values())) == 1, versions


def test_bump_writes_every_manifest(tmp_path):
    for rel in ("pyproject.toml", *bump.JSON_MANIFESTS):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / rel, tmp_path / rel)
    bump.write_version("9.8.7", tmp_path)
    assert set(bump.manifest_versions(tmp_path).values()) == {"9.8.7"}
    # Only the version line changes: inline arrays and line endings stay as written.
    for rel in ("pyproject.toml", *bump.JSON_MANIFESTS):
        before = (REPO / rel).read_bytes().splitlines()
        after = (tmp_path / rel).read_bytes().splitlines()
        assert len(before) == len(after), rel
        assert sum(a != b for a, b in zip(before, after, strict=True)) == 1, rel


def test_bump_check_reports_mismatch(capsys):
    current = bump.manifest_versions(REPO)["pyproject.toml"]
    assert bump.main(["--check", current]) == 0
    assert bump.main(["--check", "99.0.0"]) == 1
    assert "expected 99.0.0" in capsys.readouterr().err
    assert bump.main(["not-a-version"]) == 2
