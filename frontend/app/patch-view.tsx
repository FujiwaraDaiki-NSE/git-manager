"use client";

import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import { parsePatch } from "./parse-patch.mjs";

export default function PatchView({ patch }: { patch: string }) {
  const sections = useMemo(() => parsePatch(patch), [patch]);
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  if (!sections.length) return <p className="patch-empty">表示できるテキスト差分はありません。マージやバイナリの変更では、テキスト差分がない場合があります。</p>;
  return <section className="patch-view" aria-label="コミットの差分">
    <div className="patch-toolbar">
      <span className="patch-legend"><span>＋ 追加</span><span>− 削除</span></span>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>行を折り返す</button>
      {sections.length > 1 && <button type="button" onClick={() => setExpanded(expanded.size === sections.length ? new Set() : new Set(sections.map((_, index) => index)))}>{expanded.size === sections.length ? "すべて折りたたむ" : "すべて展開"}</button>}
      <CopyButton value={patch} label="差分をコピー" />
    </div>
    {sections.map((section, index) => <details className="patch-file" key={index} open={expanded.has(index)} onToggle={(event) => {
      const open = event.currentTarget.open;
      setExpanded((current) => {
        if (current.has(index) === open) return current;
        const next = new Set(current);
        if (open) next.add(index); else next.delete(index);
        return next;
      });
    }}>
      <summary title={section.title}><span>{section.title}</span></summary>
      {expanded.has(index) && <div className={`patch-lines${wrap ? " patch-wrap" : ""}`} tabIndex={0} role="region" aria-label={`${section.title} の差分（左: 変更前、右: 変更後の行番号）`}>
        <pre>{section.lines.map((line, row) => <span className={`patch-line patch-${line.kind}`} key={row}><span className="patch-number" aria-hidden="true">{line.oldLine}</span><span className="patch-number" aria-hidden="true">{line.newLine}</span><span className="patch-text">{line.text}{row < section.lines.length - 1 ? "\n" : ""}</span></span>)}</pre>
      </div>}
    </details>)}
  </section>;
}
