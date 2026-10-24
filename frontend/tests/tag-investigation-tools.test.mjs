import test from "node:test";
import assert from "node:assert/strict";
import {
  adjacentTags,
  collapseTagTargets,
  encodeTagCreatorFilter,
  filterTagInvestigation,
  hasUnknownTagCreator,
  localTagCreatorCalendarDate,
  TAG_CREATOR_DATE_ALL,
  TAG_CREATOR_DATE_KNOWN,
  TAG_CREATOR_DATE_UNKNOWN,
  tagCreatorDateRangeError,
  tagCreatorIdentities,
  tagInvestigationMarkdown,
  tagSelectionVisibility,
  tagTargetGroupSize,
  tagsJson,
  UNKNOWN_TAG_CREATOR_FILTER,
  UNKNOWN_TAG_OBJECT_TYPE_FILTER,
} from "../app/tag-investigation-tools.mjs";

const releaseA = "Release <release@example.test> 1792191825 +0900";
const releaseB = "Release <release@example.test> 1792191826 +0900";
const tags = [
  { name: "v1", type: "lightweight", hash: "h1", peeled_hash: "c1", peeled_type: "commit", creator: releaseA, creator_date: "2026-10-20T00:00:00+09:00" },
  { name: "v1-alias", type: "lightweight", hash: "h2", peeled_hash: "c1", peeled_type: "commit", creator: releaseB, creator_date: "2026-10-19T15:00:00+00:00" },
  { name: "tree", type: "lightweight", hash: "h3", peeled_hash: "t1", peeled_type: "tree", creator: "Tree Author 1 1792767600 +0900", creator_date: "2026-10-24T00:00:00+09:00" },
  { name: "blob", type: "lightweight", hash: "h4", peeled_hash: "b1", peeled_type: "blob", creator: null, creator_date: null },
  { name: "missing-target", type: "annotated", hash: "h5", peeled_hash: null, peeled_type: null, creator: null, creator_date: null },
  { name: "v2", type: "annotated", hash: "h6", peeled_hash: "c2", peeled_type: "commit", creator: "Release 2 1792531200 +0900", creator_date: "2026-10-24T00:00:00+09:00" },
];

function options(overrides = {}) {
  return {
    query: "",
    type: "all",
    creatorFilter: "",
    objectType: "",
    startDate: null,
    endDate: null,
    datePresence: TAG_CREATOR_DATE_ALL,
    sort: "name",
    collapseTargets: false,
    ...overrides,
  };
}

test("creator identities are exact and keep missing creators in a distinct bucket", () => {
  assert.deepEqual(tagCreatorIdentities(tags), ["Release <release@example.test>", "Release 2", "Tree Author 1"]);
  assert.equal(hasUnknownTagCreator(tags), true);
  assert.deepEqual(filterTagInvestigation(tags, options({ creatorFilter: encodeTagCreatorFilter("Release <release@example.test>") })).map((tag) => tag.name), ["v1", "v1-alias"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ creatorFilter: UNKNOWN_TAG_CREATOR_FILTER })).map((tag) => tag.name), ["blob", "missing-target"]);
});

test("target object type filters include commit, tree, blob, and an explicit unknown bucket", () => {
  assert.deepEqual(filterTagInvestigation(tags, options({ objectType: "tree" })).map((tag) => tag.name), ["tree"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ objectType: "blob" })).map((tag) => tag.name), ["blob"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ objectType: UNKNOWN_TAG_OBJECT_TYPE_FILTER })).map((tag) => tag.name), ["missing-target"]);
});

test("creator date ranges use inclusive local calendar days and reject invalid or reversed bounds", () => {
  assert.equal(localTagCreatorCalendarDate("2026-10-19T15:00:00+00:00"), "2026-10-20");
  assert.equal(tagCreatorDateRangeError("2026-02-30", null), "開始日は有効な日付（YYYY-MM-DD）で指定してください。");
  assert.equal(tagCreatorDateRangeError("2026-10-25", "2026-10-24"), "開始日は終了日以前の日付にしてください。");
  assert.deepEqual(filterTagInvestigation(tags, options({ startDate: "2026-10-20", endDate: "2026-10-20", datePresence: TAG_CREATOR_DATE_KNOWN })).map((tag) => tag.name), ["v1", "v1-alias"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ startDate: "", endDate: "" })).map((tag) => tag.name), ["blob", "missing-target", "tree", "v1", "v1-alias", "v2"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ datePresence: TAG_CREATOR_DATE_UNKNOWN })).map((tag) => tag.name), ["blob", "missing-target"]);
  assert.deepEqual(filterTagInvestigation(tags, options({ datePresence: TAG_CREATOR_DATE_UNKNOWN, startDate: "2026-10-20" })), []);
  assert.deepEqual(filterTagInvestigation(tags, options({ startDate: "2026-10-25", endDate: "2026-10-24" })), []);
});

test("visible navigation never wraps and a filtered or collapsed selection stays explicit", () => {
  const visible = [tags[0], tags[2], tags[5]];
  assert.equal(adjacentTags(visible, "tree").previous.name, "v1");
  assert.equal(adjacentTags(visible, "tree").next.name, "v2");
  assert.equal(adjacentTags(visible, "v1").previous, null);
  assert.equal(adjacentTags(visible, "v2").next, null);
  assert.equal(adjacentTags(visible, "blob").previous, null);
  assert.equal(tagSelectionVisibility(tags.filter((tag) => tag.name !== "blob"), visible, "blob"), "filtered");
  assert.equal(tagSelectionVisibility([...tags], [tags[0], tags[2], tags[3], tags[4], tags[5]], "v1-alias"), "collapsed");
  assert.equal(tagSelectionVisibility(tags, visible, null), "none");
});

test("collapse keeps one representative only for the same exact target object", () => {
  const collapsed = collapseTagTargets(tags, true);
  assert.deepEqual(collapsed.map((tag) => tag.name), ["v1", "tree", "blob", "missing-target", "v2"]);
  assert.equal(tagTargetGroupSize(tags, tags[0]), 2);
  assert.equal(tagTargetGroupSize(tags, tags[2]), 1);
  assert.deepEqual(collapseTagTargets(tags, false), tags);
});

test("JSON export contains only visible rows and repository plus active filter metadata", () => {
  const filter = options({ creatorFilter: UNKNOWN_TAG_CREATOR_FILTER, collapseTargets: true });
  const json = tagsJson([tags[3], tags[4]], { repositoryPath: "/repo/demo", filters: filter });
  assert.deepEqual(JSON.parse(json), {
    repository_path: "/repo/demo",
    filters: {
      query: "",
      type: "all",
      creator: UNKNOWN_TAG_CREATOR_FILTER,
      target_object_type: "",
      creator_date_presence: TAG_CREATOR_DATE_ALL,
      creator_date_start: null,
      creator_date_end: null,
      sort: "name",
      collapse_same_target: true,
    },
    count: 2,
    tags: [tags[3], tags[4]],
  });
  assert.throws(() => tagsJson([], { repositoryPath: "/repo/demo", filters: { query: "" } }), /provided explicitly/);
});

test("selected-tag Markdown captures repository, object, target, annotation, and truncation facts", () => {
  const markdown = tagInvestigationMarkdown({
    ...tags[5],
    annotation: {
      object_hash: "c2",
      object_type: "commit",
      tag: "v2",
      tagger: "Release 2",
      tagger_date: "2026-10-24T00:00:00+09:00",
      message: "release `notes`\nsecond line",
      message_truncated: true,
    },
  }, "/repo/<demo>", {
    hash: "c2",
    subject: "Release <two>",
    author: "Author",
    date: "2026-10-24T00:00:00+09:00",
  });
  assert.match(markdown, /^# gitdash tag investigation/m);
  assert.match(markdown, /repository_path: \/repo\/&lt;demo&gt;/u);
  assert.match(markdown, /tag_object_hash: h6/u);
  assert.match(markdown, /target_hash: c2/u);
  assert.match(markdown, /message_truncated: true/u);
  assert.match(markdown, /release `notes`/u);
  assert.match(markdown, /hash: c2/u);
  assert.throws(() => tagInvestigationMarkdown({}, "/repo", null), /provided explicitly/);
  assert.throws(() => tagInvestigationMarkdown({ ...tags[5], annotation: null }, "/repo"), /targetCommit/);
});
