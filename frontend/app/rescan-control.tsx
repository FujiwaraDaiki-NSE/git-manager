"use client";

import { useRef, useState } from "react";

export default function RescanControl({ scanning }: { scanning: boolean }) {
  const requestPending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ message: string; error: boolean } | null>(null);
  const rescan = async () => {
    if (requestPending.current || scanning) return;
    requestPending.current = true;
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/rescan", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as { started: boolean; reason?: string };
      if (value.started === true) setResult({ message: "走査を受け付けました。検出した状態を順次反映します。", error: false });
      else if (value.started === false && typeof value.reason === "string") setResult({ message: value.reason, error: false });
      else throw new Error("invalid response");
    } catch {
      setResult({ message: "走査の受付を確認できませんでした。接続状態を確認してから再試行してください。", error: true });
    } finally {
      requestPending.current = false;
      setSubmitting(false);
    }
  };
  return <div className="rescan-control">
    <button className="rescan-button" disabled={scanning || submitting} aria-busy={scanning || submitting} type="button" onClick={() => void rescan()}>{submitting ? "要求中…" : scanning ? "走査中…" : "再走査"}</button>
    {result && <span className={result.error ? "rescan-feedback is-error" : "rescan-feedback"} role={result.error ? "alert" : "status"}>{result.message}</span>}
  </div>;
}
