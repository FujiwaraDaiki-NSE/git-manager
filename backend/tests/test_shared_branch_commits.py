from copy import deepcopy

from app import project, branch_history
from test_project import init_repo, commit, git


def test_project_shared_history_preserves_rows_and_pages(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    for index in range(205):
        commit(repo, f"shared {index}")
    git(repo, "branch", "feature")
    expected = []
    normalize = project.shared_branch_commits

    def capture(rows):
        expected.extend(deepcopy(rows))
        return normalize(rows)

    monkeypatch.setattr(project, "shared_branch_commits", capture)
    result = project.build(str(repo), str(repo))
    assert len(result["branch_rows"]) == 2
    for original, row in zip(expected, result["branch_rows"], strict=True):
        restored = {**row, "commits": [result["branch_commits"][h] for h in row["commit_hashes"]]}
        assert restored == original
        assert "commits" not in row
        assert row["history_cursor"] == 200
        page = branch_history.read_page(str(repo), row["history_heads"], row["history_cursor"])
        assert page["commits"]
        assert page["next_offset"] is None
    assert len(result["branch_commits"]) == 200
    assert normalize(None) is None
    assert normalize([]) == {}
