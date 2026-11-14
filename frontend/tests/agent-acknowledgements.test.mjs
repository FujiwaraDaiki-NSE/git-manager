import test from 'node:test';
import assert from 'node:assert/strict';
import { agentReportKey } from '../app/agent-overview.mjs';
import { agentWorktreeCommand, isAcknowledged, parseAcknowledgements, reportIdentity, updateAcknowledgements } from '../app/agent-acknowledgements.mjs';

test('acknowledgements identify an exact project/branch report and reopen on either new identity field', () => {
  const task = { project_id: 'project-a', branch: 'main', event_id: 'e1', sequence: 7 };
  const saved = { [agentReportKey(task)]: reportIdentity(task) };
  const restored = parseAcknowledgements(JSON.stringify(saved));
  assert.equal(isAcknowledged(task, restored), true);
  for (const change of [{ event_id: 'e2' }, { sequence: 8 }, { branch: 'feature' }, { project_id: 'project-b' }]) {
    assert.equal(isAcknowledged({ ...task, ...change }, restored), false);
  }
  assert.equal(reportIdentity({ event_id: null, sequence: null }), null);
  assert.deepEqual(parseAcknowledgements(null), {});
  for (const raw of ['broken', '[]', 'null', '{"key":{"eventId":null,"sequence":null}}', '{"key":{"eventId":"e1"}}']) {
    assert.equal(parseAcknowledgements(raw), null);
  }
});

test('worktree command accepts only an observed absolute path and quotes shell metacharacters literally', () => {
  assert.equal(agentWorktreeCommand("/tmp/it's $(printf unsafe)"), "cd '/tmp/it'\\''s $(printf unsafe)'");
  for (const path of [null, undefined, '', 'relative/path', '/tmp/invalid\0path']) assert.equal(agentWorktreeCommand(path), null);
});


test('bulk acknowledgement and undo affect only the selected exact reports, preserving new reports and other groups', () => {
  const task = (project, branch, id, sequence) => ({ project_id: project, branch, event_id: id, sequence });
  const old = task('p', 'old', 'e1', 1);
  const other = task('p', 'other', 'e2', 2);
  const existing = updateAcknowledgements([other], {}, true);
  const saved = updateAcknowledgements([old], existing, true);
  assert.equal(isAcknowledged(old, saved), true);
  assert.equal(isAcknowledged(other, saved), true);
  assert.equal(isAcknowledged(old, existing), false);
  const newer = { ...old, event_id: 'e3', sequence: 3 };
  assert.equal(isAcknowledged(newer, saved), false);
  const undone = updateAcknowledgements([old], saved, false);
  assert.equal(isAcknowledged(old, undone), false);
  assert.equal(isAcknowledged(other, undone), true);
  const newerSaved = updateAcknowledgements([newer], saved, true);
  assert.equal(isAcknowledged(newer, updateAcknowledgements([old], newerSaved, false)), true);
});
