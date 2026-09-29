"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; change: (theme: Theme) => void; storageIssue: boolean } | null>(null);
const storageKey = "gitdash.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [storageIssue, setStorageIssue] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === null) return;
      if (saved !== "system" && saved !== "light" && saved !== "dark") { setStorageIssue(true); return; }
      setTheme(saved);
      document.documentElement.dataset.theme = saved;
    } catch { setStorageIssue(true); }
  }, []);
  const change = (value: Theme) => {
    setTheme(value);
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem(storageKey, value); setStorageIssue(false); }
    catch { setStorageIssue(true); }
  };
  return <ThemeContext.Provider value={{ theme, change, storageIssue }}>{children}</ThemeContext.Provider>;
}

export default function ThemeControl() {
  const context = useContext(ThemeContext);
  if (!context) return null;
  return <div className="theme-control"><label><span aria-hidden="true">◐</span><span className="sr-only">表示テーマ</span><select value={context.theme} onChange={(event) => context.change(event.target.value as Theme)}><option value="system">自動</option><option value="light">ライト</option><option value="dark">ダーク</option></select></label>{context.storageIssue && <span className="theme-storage-issue" role="status">表示設定の保存データを利用できません。</span>}</div>;
}
