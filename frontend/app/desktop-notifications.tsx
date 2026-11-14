"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRepoStream } from "./repo-stream";
import { agentStateLabel } from "./agent-overview.mjs";

const STORAGE_KEY = "gitdash.desktop-notifications";

export default function DesktopNotifications() {
  const { subscribeAgentAttention, projectSummaries } = useRepoStream();
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const enabledRef = useRef(false);
  const projectsRef = useRef(projectSummaries);
  projectsRef.current = projectSummaries;

  useEffect(() => {
    setAvailable("Notification" in window && window.isSecureContext);
    try {
      const active = localStorage.getItem(STORAGE_KEY) === "true" && "Notification" in window && Notification.permission === "granted";
      enabledRef.current = active;
      setEnabled(active);
    } catch { setMessage("通知設定を読み込めませんでした。"); }
  }, []);

  useEffect(() => subscribeAgentAttention((event) => {
    if (!enabledRef.current || !("Notification" in window) || Notification.permission !== "granted") return;
    const project = projectsRef.current.find((item) => item.id === event.project_id);
    if (!project || project.main_path === null) return;
    const path = project.main_path;
    try {
      const notification = new Notification(`${agentStateLabel(event.status)} · ${project.name}`, {
        body: `${event.branch}\n${event.summary === null ? "" : event.summary}`,
        tag: event.event_id,
      });
      notification.onclick = () => {
        window.focus();
        const params = new URLSearchParams({ path, tab: "lanes" });
        if (event.branch !== null) params.set("lane", `branch:${event.branch}`);
        router.push(`/project?${params}`);
        notification.close();
      };
    } catch { setMessage("通知を表示できませんでした。"); }
  }), [router, subscribeAgentAttention]);

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
    {!available && <span>この環境ではデスクトップ通知を利用できません。</span>}
    {message && <span role="status">{message}</span>}
  </div>;
}
