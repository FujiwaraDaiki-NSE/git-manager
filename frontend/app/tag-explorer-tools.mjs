/** Pure helpers for the read-only tag explorer. */

export const TAG_TYPES = [
  { key: "all", label: "すべて" },
  { key: "lightweight", label: "軽量" },
  { key: "annotated", label: "注釈付き" },
];

export const TAG_SORTS = [
  { key: "name", label: "名前順" },
  { key: "oldest", label: "作成日（古い順）" },
  { key: "newest", label: "作成日（新しい順）" },
];

function knownTag(tag) {
  return tag !== null && typeof tag === "object";
}

/** Search by the complete tag name.  A non-empty query never broadens to a substring search. */
export function searchTags(tags, query) {
  if (typeof query !== "string") return [];
  const needle = query.trim();
  if (needle === "") return tags.filter(knownTag);
  return tags.filter((tag) => knownTag(tag) && tag.name === needle);
}

/** Apply the explicit lightweight/annotated type condition. */
export function filterTags(tags, type) {
  if (type === "all") return tags.filter(knownTag);
  if (type !== "lightweight" && type !== "annotated") return [];
  return tags.filter((tag) => knownTag(tag) && tag.type === type);
}

function dateValue(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareNames(left, right) {
  return String(left.name).localeCompare(String(right.name), "ja", { sensitivity: "base" });
}

/** Sort without mutating the source. Unknown creator dates always stay last. */
export function sortTags(tags, order) {
  const nameAscending = order === "name" || order === "name-asc";
  const nameDescending = order === "name-desc";
  const dateAscending = order === "oldest" || order === "creator-date-asc" || order === "date-asc";
  const dateDescending = order === "newest" || order === "creator-date-desc" || order === "date-desc";
  if (!nameAscending && !nameDescending && !dateAscending && !dateDescending) {
    return [];
  }
  return tags.filter(knownTag).map((tag, index) => ({ tag, index })).sort((left, right) => {
    if (nameAscending || nameDescending) {
      const result = compareNames(left.tag, right.tag);
      if (result !== 0) return nameDescending ? -result : result;
      return left.index - right.index;
    }
    const leftDate = dateValue(left.tag.creator_date);
    const rightDate = dateValue(right.tag.creator_date);
    if (leftDate === null && rightDate !== null) return 1;
    if (rightDate === null && leftDate !== null) return -1;
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
      return dateAscending ? leftDate - rightDate : rightDate - leftDate;
    }
    return left.index - right.index;
  }).map(({ tag }) => tag);
}

/** Apply every visible condition in a deterministic order. */
export function visibleTags(tags, { query, type, sort }) {
  if (typeof query !== "string" || typeof type !== "string" || typeof sort !== "string") return [];
  return sortTags(filterTags(searchTags(tags, query), type), sort);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Keep formula-looking names as text when opened by a spreadsheet program.
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS = ["name", "type", "hash", "peeled_hash", "peeled_type", "creator", "creator_date"];

/** Export exactly the supplied (already filtered) tags as an RFC-quoted CSV. */
export function tagsCsv(tags) {
  return "\uFEFF" + [
    CSV_COLUMNS.map(csvCell),
    ...tags.filter(knownTag).map((tag) => CSV_COLUMNS.map((column) => csvCell(tag[column]))),
  ].map((row) => row.join(",")).join("\r\n");
}

// Short names make the helpers convenient in small tests and keep the
// exported vocabulary close to the UI label.
export const tagCsv = tagsCsv;
export const filterTagType = filterTags;

/** Display Git's creator identity separately from its raw epoch/timezone suffix. */
export function tagCreatorIdentity(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.replace(/ -?\d+ [+-]\d{4}$/u, "");
}
