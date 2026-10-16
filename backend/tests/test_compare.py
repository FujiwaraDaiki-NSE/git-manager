import subprocess
from pathlib import Path

import pytest

from app import compare


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def commit(repo: Path, message: str) -> str:
    git(repo, "add", ".")
    git(repo, "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def divergent_repo(tmp_path: Path) -> dict[str, str | Path]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.invalid")
    (repo / "shared.txt").write_text("base\n", encoding="utf-8")
    base = commit(repo, "base")

    git(repo, "switch", "-q", "-c", "feature")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    feature = commit(repo, "feature")

    git(repo, "switch", "-q", "main")
    (repo / "main.txt").write_text("main\n", encoding="utf-8")
    main = commit(repo, "main")
    return {"repo": repo, "base": base, "feature": feature, "main": main}


def test_direct_comparison_resolves_refs_and_preserves_direction(divergent_repo):
    result = compare.get_comparison(
        str(divergent_repo["repo"]),
        "refs/heads/main",
        "refs/heads/feature",
        "direct",
    )

    assert result["mode"] == "direct"
    assert result["base"] == divergent_repo["main"]
    assert result["target"] == divergent_repo["feature"]
    assert result["comparison_base"] == divergent_repo["main"]
    assert result["merge_base"] is None
    assert result["stats"] == {
        "files": 2,
        "additions": 1,
        "deletions": 1,
        "binary": 0,
        "renamed": 0,
    }
    assert "--no-ext-diff" in result["command"]
    assert "--no-textconv" in result["command"]
    assert divergent_repo["main"] in result["command"]
    assert divergent_repo["feature"] in result["command"]


def test_merge_base_comparison_requires_one_unique_base(divergent_repo):
    result = compare.get_comparison(
        str(divergent_repo["repo"]),
        divergent_repo["main"],
        divergent_repo["feature"],
        "merge-base",
    )

    assert result["merge_base"] == divergent_repo["base"]
    assert result["merge_bases"] == [divergent_repo["base"]]
    assert result["comparison_base"] == divergent_repo["base"]
    assert result["comparison_label"].startswith("merge-base ")
    assert result["stats"]["files"] == 1
    assert result["stats"]["additions"] == 1


def test_no_merge_base_is_an_explicit_error(tmp_path: Path):
    first = tmp_path / "first"
    first.mkdir()
    git(first, "init", "-q", "-b", "main")
    git(first, "config", "user.name", "Test")
    git(first, "config", "user.email", "test@example.invalid")
    (first / "file.txt").write_text("main\n", encoding="utf-8")
    commit(first, "main")
    # Create two independent roots in one repository so the API can report a
    # missing merge-base without relying on an object from another repo.
    repo = first
    git(repo, "checkout", "--orphan", "unrelated")
    git(repo, "rm", "-q", "-rf", ".")
    (repo / "other.txt").write_text("other\n", encoding="utf-8")
    unrelated = commit(repo, "unrelated")
    git(repo, "switch", "-q", "main")
    main = git(repo, "rev-parse", "main").strip()

    with pytest.raises(compare.ComparisonError) as error:
        compare.get_comparison(str(repo), main, unrelated, "merge-base")
    assert error.value.code == "no_merge_base"


def test_numstat_is_nul_safe_for_rename_binary_and_strange_paths(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.invalid")
    old = "old\tname\n.txt"
    (repo / old).write_text("same content\n", encoding="utf-8")
    base = commit(repo, "base")
    new = "new\tname\n.txt"
    git(repo, "mv", "--", old, new)
    (repo / "binary\tfile.bin").write_bytes(b"\x00\x01\x02\x03")
    target = commit(repo, "rename and binary")

    result = compare.get_comparison(str(repo), base, target, "direct")
    files = {file["path"]: file for file in result["files"]}
    assert files[new]["old_path"] == old
    assert files[new]["additions"] == 0
    assert files["binary\tfile.bin"]["binary"] is True
    assert files["binary\tfile.bin"]["additions"] == "-"
    assert result["stats"]["renamed"] == 1
    assert result["stats"]["binary"] == 1
    assert result["stats"]["additions"] is None
    assert result["stats"]["deletions"] is None


@pytest.mark.parametrize("value", ["--output=/tmp/out", "base\nother", "base..HEAD", "base~1"])
def test_ref_validation_rejects_option_injection_and_revision_expressions(
    divergent_repo, value: str
):
    with pytest.raises(compare.ComparisonError) as error:
        compare.get_comparison(str(divergent_repo["repo"]), value, divergent_repo["feature"], "direct")
    assert error.value.code == "invalid_ref"


def test_patch_is_bounded_and_marked_partial(tmp_path: Path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.invalid")
    (repo / "file.txt").write_text("base\n", encoding="utf-8")
    base = commit(repo, "base")
    (repo / "file.txt").write_text("target\n", encoding="utf-8")
    target = commit(repo, "target")
    monkeypatch.setattr(compare, "PATCH_MAX_BYTES", 8)

    result = compare.get_comparison(str(repo), base, target, "direct")
    assert result["patch_truncated"] is True
    assert len(result["patch"].encode("utf-8")) <= 8
