"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRepoStream } from "./repo-stream";
import { agentStateLabel } from "./agent-overview.mjs";
import { agentReportLaneId } from "./agent-timeline-tools.mjs";
import { FAVORITES_STORAGE_KEY, parseFavoriteIds } from "./home-overview.mjs";

const STORAGE_KEY = "gitdash.desktop-notifications";
const SCOPE_STORAGE_KEY = "gitdash.desktop-notification-scope";
type NotificationScope = "all" | "favorites";

function readFavoriteIds() {
  try { return parseFavoriteIds(localStorage.getItem(FAVORITES_STORAGE_KEY)); }
  catch { return null; }
}

export default function DesktopNotifications() {
  const { subscribeAgentAttention, projectSummaries, repos, reposLoading } = useRepoStream();
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<NotificationScope | null>(null);
  const [scopeIssue, setScopeIssue] = useState("");
  const [favoritesUnreadable, setFavoritesUnreadable] = useState(false);
  const enabledRef = useRef(false);
  const scopeRef = useRef<NotificationScope | null>(null);
  const projectsRef = useRef(projectSummaries);
  projectsRef.current = projectSummaries;
  const reposRef = useRef(reposLoading ? null : repos);
  reposRef.current = reposLoading ? null : repos;

  useEffect(() => {
    setAvailable("Notification" in window && window.isSecureContext);
    try {
      const active = localStorage.getItem(STORAGE_KEY) === "true" && "Notification" in window && Notification.permission === "granted";
      enabledRef.current = active;
      setEnabled(active);
    } catch { setMessage("通知設定を読み込めませんでした。"); }
    const applyStoredScope = (stored: string | null) => {
      // Existing users have all-project notifications until they select a scope.
      const loaded = stored === null ? "all" : stored === "all" || stored === "favorites" ? stored : null;
      scopeRef.current = loaded;
      setScope(loaded);
      setScopeIssue(loaded === null ? "通知対象の設定を読み込めませんでした。" : "");
    };
    try { applyStoredScope(localStorage.getItem(SCOPE_STORAGE_KEY)); }
    catch { setScopeIssue("通知対象の設定を読み込めませんでした。"); }

    const syncScope = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === SCOPE_STORAGE_KEY || event.key === null)) {
        applyStoredScope(event.newValue);
      }
    };
    window.addEventListener("storage", syncScope);
    return () => window.removeEventListener("storage", syncScope);
  }, []);

  useEffect(() => {
    setFavoritesUnreadable(scope === "favorites" && readFavoriteIds() === null);
  }, [scope]);

  useEffect(() => subscribeAgentAttention((event) => {
    if (!enabledRef.current || !("Notification" in window) || Notification.permission !== "granted") return;
    if (scopeRef.current === null) return;
    if (scopeRef.current === "favorites") {
      const favorites = readFavoriteIds();
      setFavoritesUnreadable(favorites === null);
      if (favorites === null || event.project_id == null || !favorites.includes(event.project_id)) return;
    }
    const project = projectsRef.current.find((item) => item.id === event.project_id);
    if (!project || project.main_path === null) return;
    const path = project.main_path;
    try {
      const notification = new Notification(`${agentStateLabel(event.status)} · ${project.name}`, {
        body: [event.decision?.question, event.branch, event.summary].filter((value) => value != null).join("\n"),
        tag: event.event_id,
      });
      notification.onclick = () => {
        window.focus();
        const params = new URLSearchParams({ path, tab: "lanes" });
        const lane = agentReportLaneId(project.id, event, reposRef.current);
        if (lane !== null) params.set("lane", lane);
        router.push(`/project?${params}`);
        notification.close();
      };
    } catch { setMessage("通知を表示できませんでした。"); }
  }), [router, subscribeAgentAttention]);

  const changeScope = (value: string) => {
    if (value !== "all" && value !== "favorites") return;
    scopeRef.current = value;
    setScope(value);
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, value);
      setScopeIssue("");
    } catch { setScopeIssue("通知対象の設定を保存できませんでした。この画面でのみ適用します。"); }
  };

  const toggle = async () => {
    if (pending) return;
    setMessage("");
    let active = false;
    if (!enabled) {
      setPending(true);
      try {
        active = (await Notification.requestPermission()) === "granted";
        if (!active) setMessage("通知は許可されていません。ブラウザのサイト設定で変更できます。");
      } catch { setMessage("通知の許可を取得できませんでした。"); }
      finally { setPending(false); }
    }
    enabledRef.current = active;
    setEnabled(active);
    try { localStorage.setItem(STORAGE_KEY, String(active)); }
    catch { setMessage("通知設定を保存できませんでした。この画面でのみ適用します。"); }
  };

  return <div className="desktop-notifications">
    <button type="button" className="agent-timeline-pause" disabled={!available || pending} aria-pressed={enabled} onClick={() => void toggle()}>{pending ? "通知の許可を確認中…" : enabled ? "通知を無効にする" : "通知を有効にする"}</button>
    <label>通知対象 <select value={scope === null ? "" : scope} onChange={(event) => changeScope(event.currentTarget.value)}>
      {scope === null && <option value="" disabled>通知対象を選択</option>}
      <option value="all">全プロジェクト</option>
      <option value="favorites">お気に入りのみ</option>
    </select></label>
    {!available && <span>この環境ではデスクトップ通知を利用できません。</span>}
    {message && <span role="status">{message}</span>}
    {scopeIssue && <span role="status">{scopeIssue}</span>}
    {scope === "favorites" && favoritesUnreadable && <span role="status">お気に入りの設定を読み込めませんでした。デスクトップ通知を停止しています。</span>}
  </div>;
}
