export const REPOSITORY_FILES_MAX_PREVIEW_BYTES = 64 * 1024;
export const REPOSITORY_FILES_MAX_BLOB_BYTES = 1024 * 1024;

function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

/** Build an inventory request with every API input present, including empty filters. */
export function repositoryFilesQuery(path, revision, directory, query) {
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(directory, "directory");
  requiredString(query, "query");
  return new URLSearchParams({ path, revision, directory, query }).toString();
}

/** Build an exact blob request.  No implicit current revision or path is used. */
export function repositoryFileQuery(path, revision, file) {
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(file, "file");
  return new URLSearchParams({ path, revision, file }).toString();
}

function normalizedDirectory(directory) {
  requiredString(directory, "directory");
  if (directory === "" || directory === ".") return "";
  if (directory.startsWith("/") || directory.endsWith("/") || directory.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("directory must be a normalized relative path");
  }
  return directory;
}

function entryPath(entry) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return null;
  return entry.path;
}

function compareEntries(left, right) {
  const a = entryPath(left) || "";
  const b = entryPath(right) || "";
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Return immediate children of one normalized directory from the retrieved inventory. */
export function listRepositoryDirectoryEntries(entries, directory) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be provided explicitly");
  const current = normalizedDirectory(directory);
  const prefix = current ? `${current}/` : "";
  const children = new Map();
  for (const entry of entries) {
    const path = entryPath(entry);
    if (!path || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      children.set(path, entry);
      continue;
    }
    const childPath = `${prefix}${rest.slice(0, slash)}`;
    if (!children.has(childPath)) {
      children.set(childPath, {
        path: childPath,
        mode: "040000",
        type: "tree",
        hash: null,
      });
    }
  }
  return Array.from(children.values()).sort(compareEntries);
}

/** Search every retrieved non-directory path, with whitespace-separated terms. */
export function searchRepositoryFileEntries(entries, query) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be provided explicitly");
  requiredString(query, "query");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return entries
    .filter((entry) => entryPath(entry) && entry.type !== "tree")
    .filter((entry) => {
      const path = entry.path.toLocaleLowerCase();
      return terms.every((term) => path.includes(term));
    })
    .sort(compareEntries);
}

/** Keep a local directory view tied to the same retrieved inventory. */
export function filterRepositoryFileEntries(entries, directory, query) {
  requiredString(query, "query");
  const current = normalizedDirectory(directory);
  return query.trim() === ""
    ? listRepositoryDirectoryEntries(entries, current)
    : searchRepositoryFileEntries(entries, query);
}

/** Limit text by encoded UTF-8 bytes so the preview cap is meaningful for CJK text too. */
export function boundedRepositoryText(text, maxBytes = REPOSITORY_FILES_MAX_PREVIEW_BYTES) {
  requiredString(text, "text");
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative integer");
  if (typeof TextEncoder === "undefined" || typeof TextDecoder === "undefined") return text.slice(0, maxBytes);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      // A UTF-8 code point may straddle the exact byte cap.  Remove only the
      // incomplete suffix so the returned text remains valid and bounded.
    }
  }
  return "";
}

/** Convert an API base64 payload back to exact bytes for a binary-preserving download. */
export function repositoryBase64ToBytes(value) {
  requiredString(value, "base64");
  if (typeof atob !== "function") throw new Error("base64 decoding is unavailable");
  let decoded;
  try {
    decoded = atob(value);
  } catch {
    throw new TypeError("base64 is invalid");
  }
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) result[index] = decoded.charCodeAt(index);
  return result;
}

/** Create the existing file-history investigation link without starting the investigation. */
export function buildRepositoryFileHistoryHref(href, path, revision, file, follow) {
  requiredString(href, "href");
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(file, "file");
  if (!/^[0-9a-f]{40,64}$/iu.test(revision)) throw new TypeError("revision must be a full resolved hash");
  if (!file) throw new TypeError("file must be a non-empty path");
  if (typeof follow !== "boolean") throw new TypeError("follow must be provided explicitly");
  const url = new URL(href, "http://localhost");
  url.searchParams.set("path", path);
  url.searchParams.set("tab", "info");
  for (const key of ["investigation", "investigationBase", "investigationTarget", "investigationMode", "investigationRevision", "investigationFile", "investigationFollow"]) url.searchParams.delete(key);
  url.searchParams.set("investigation", "file-history");
  url.searchParams.set("investigationRevision", revision);
  url.searchParams.set("investigationFile", file);
  url.searchParams.set("investigationFollow", String(follow));
  return /^[a-z][a-z\d+.-]*:/iu.test(href) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

export function repositoryFileName(file) {
  requiredString(file, "file");
  const parts = file.split("/");
  return parts.at(-1) || "gitdash-file";
}
