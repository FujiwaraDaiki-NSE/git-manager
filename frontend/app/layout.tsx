import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gitdash",
  description: "PC内のGitリポジトリの状態一覧",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
