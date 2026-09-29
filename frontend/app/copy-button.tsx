"use client";

import { useEffect, useRef, useState } from "react";

export default function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "success" | "error">("idle");
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setStatus("idle");
    return () => { request.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, [value]);
  const copy = async () => {
    const id = ++request.current;
    if (timer.current) clearTimeout(timer.current);
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(value);
      if (request.current !== id) return;
      setStatus("success");
      timer.current = setTimeout(() => setStatus("idle"), 2500);
    } catch {
      if (request.current === id) setStatus("error");
    }
  };
  return <span className="copy-control">
    <button className="copy-button" type="button" disabled={status === "copying"} onClick={() => void copy()} aria-label={label} title={label}><span aria-hidden="true">{status === "success" ? "✓" : "⧉"}</span><span>{label}</span></button>
    <span className={`copy-feedback${status === "error" ? " is-error" : ""}`} role={status === "error" ? "alert" : "status"}>{status === "success" ? "コピーしました" : status === "error" ? "コピーできません。表示された文字列を選択してコピーしてください。" : ""}</span>
  </span>;
}
