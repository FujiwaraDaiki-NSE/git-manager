import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteLabel } from '../app/remote-label.mjs';
import { upstreamLabel } from '../app/upstream-label.mjs';
import { agentStateLabel } from '../app/agent-overview.mjs';
import { sideBySideRows } from '../app/side-by-side.mjs';
import { parsePatch } from '../app/parse-patch.mjs';
import { validCodeSize, validPaneWidth, clampPaneWidth, validCommitColumns, scrollEdges } from '../app/ui-preference-tools.mjs';
test('local remotes retain exact paths including slash and .git', () => {
 for (const path of ['/home/solution2024/thinkplatform-dev/thinkplatform', 'file:///tmp/repo.git', '../x', './x.git', 'relative/repo.git', 'C:\\repo.git']) assert.equal(remoteLabel(path),path);
 assert.equal(remoteLabel('git@github.com:org/repo.git'),'github.com/org/repo');
 assert.equal(remoteLabel('https://github.com/org/repo.git'),'github.com/org/repo');
 assert.equal(remoteLabel(null),'リモート未取得');
});
test('missing reports and upstream absence remain distinct from acquisition failure', () => {
 assert.equal(agentStateLabel(null),'agent報告なし');
 assert.equal(agentStateLabel('merge_ready'),'マージ準備完了');
 assert.equal(upstreamLabel({upstream:null}),'追跡先なし');
 assert.equal(upstreamLabel({}),'追跡先を取得できませんでした');
 assert.match(upstreamLabel({upstream:'origin/main',upstream_ahead:null,upstream_behind:null}),/状態未取得/);
});
test('side comparison pairs unequal replacement blocks and retains hunk boundaries and metadata', () => {
 const rows = parsePatch('@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file')[0].lines.map((line,lineIndex)=>({line,lineIndex}));
 const pairs = sideBySideRows(rows);
 assert.equal(pairs[0].shared.line.kind,'hunk');
 assert.equal(pairs[1].left.line.text,' same');
 assert.equal(pairs[2].left.line.text,'-old');
 assert.equal(pairs[2].right.line.text,'+new');
 assert.equal(pairs[3].left,null);
 assert.equal(pairs[3].right.line.newLine,3);
 assert.equal(pairs[4].shared.line.text,'\\ No newline at end of file');
});
test('persisted display preferences accept only complete supported values; pane width is bounded', () => {
 assert.ok(validCodeSize('medium')); assert.ok(!validCodeSize('huge'));
 assert.ok(validPaneWidth(380)); assert.ok(!validPaneWidth(null)); assert.ok(!validPaneWidth(Infinity));
 assert.equal(clampPaneWidth(100,320),320); assert.equal(clampPaneWidth(1000,280),900);
 assert.ok(validCommitColumns([false,true,false])); assert.ok(!validCommitColumns([true]));
});
test('scroll shadows indicate only the remaining direction', () => {
 assert.deepEqual(scrollEdges(0,100,200),{left:false,right:true});
 assert.deepEqual(scrollEdges(50,100,200),{left:true,right:true});
 assert.deepEqual(scrollEdges(100,100,200),{left:true,right:false});
 assert.deepEqual(scrollEdges(0,200,200),{left:false,right:false});
});

test('remoteの状態をnullから推測しない', () => {
 assert.equal(remoteLabel(null, 'unset'), 'origin未設定');
 assert.equal(remoteLabel(null, 'failed'), 'リモート取得失敗');
 assert.equal(remoteLabel(null, null), 'リモート未取得');
});
