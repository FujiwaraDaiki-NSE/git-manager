import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "./theme-control";

export const metadata: Metadata = {
  title: "gitdash",
  description: "PC内のGitリポジトリの状態一覧",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("gitdash.theme");if(t==="light"||t==="dark"||t==="system")document.documentElement.dataset.theme=t}catch{}` }} /></head>
      <body><ThemeProvider><a className="skip-link" href="#main-content">メインコンテンツへ移動</a>{children}</ThemeProvider></body>
    </html>
  );
}
