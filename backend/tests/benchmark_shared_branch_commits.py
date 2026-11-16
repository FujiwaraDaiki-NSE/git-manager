"""Run manually: PYTHONPATH=. uv run python tests/benchmark_shared_branch_commits.py.

Uses real Git history and the same project builder, alternating legacy/new
serialization. Node measures JSON.parse plus resolving every row.
"""
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import time
from unittest.mock import patch

from app import project
from test_project import init_repo, git


def main():
    with tempfile.TemporaryDirectory() as directory:
        repo = Path(directory) / "repo"
        init_repo(repo)
        tree = git(repo, "rev-parse", "HEAD^{tree}").strip()
        head = git(repo, "rev-parse", "HEAD").strip()
        for index in range(260):
            head = git(repo, "commit-tree", tree, "-p", head, "-m", f"shared history {index}: " + "details " * 30).strip()
        git(repo, "update-ref", "refs/heads/main", head)
        for index in range(160):
            tip = git(repo, "commit-tree", tree, "-p", head, "-m", f"feature {index}").strip()
            git(repo, "update-ref", f"refs/heads/feature-{index}", tip)
        normalize = project.shared_branch_commits
        samples = {"before": [], "after": []}
        payloads = {}
        for _ in range(3):
            for mode in samples:
                with patch.object(project, "shared_branch_commits", (lambda rows: None) if mode == "before" else normalize):
                    start = time.perf_counter()
                    result = project.build(str(repo), str(repo), range_name="all")
                    if mode == "before":
                        del result["branch_commits"]
                    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
                    samples[mode].append((time.perf_counter() - start) * 1000)
                    payloads[mode] = payload
        before = json.loads(payloads["before"])
        after = json.loads(payloads["after"])
        for old, new in zip(before["branch_rows"], after["branch_rows"], strict=True):
            assert old == {**new, "commits": [after["branch_commits"][h] for h in new["commit_hashes"]]}
        files = {}
        for mode, payload in payloads.items():
            path = Path(directory) / f"{mode}.json"
            path.write_bytes(payload)
            files[mode] = str(path)
        resolver = (Path(__file__).resolve().parents[2] / "frontend/app/branch-commits.mjs").as_uri()
        script = """
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolveBranchCommits } from RESOLVER;
const files = FILES;
for (const [mode, file] of Object.entries(files)) {
  const raw = fs.readFileSync(file, 'utf8');
  const samples = [];
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const project = JSON.parse(raw);
    const rows = project.branch_rows.map(row => mode === 'after' ? resolveBranchCommits(project, row) : row.commits);
    if (!rows.length) throw new Error('empty fixture');
    if (i >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a,b) => a-b);
  console.log(JSON.stringify({ mode, parse_resolve_ms: samples[15] }));
}
""".replace("RESOLVER", json.dumps(resolver)).replace("FILES", json.dumps(files))
        node = subprocess.check_output(["node", "--input-type=module", "-e", script], text=True)
        print(json.dumps({
            "branches": len(after["branch_rows"]),
            "entries": sum(len(row["commit_hashes"]) for row in after["branch_rows"]),
            "unique": len(after["branch_commits"]),
            "build_serialize_ms": {mode: statistics.median(values) for mode, values in samples.items()},
            "json_bytes": {mode: len(payload) for mode, payload in payloads.items()},
            "restored_rows_equal": True,
        }, indent=2))
        print(node)


if __name__ == "__main__":
    main()
