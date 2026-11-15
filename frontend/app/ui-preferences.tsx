"use client";
import { validCodeSize, validPaneWidth, clampPaneWidth } from "./ui-preference-tools.mjs";
import { useEffect, useState, type CSSProperties } from "react";

export function usePreference<T>(key: string, initial: T, valid: (value: unknown) => value is T) {
  const [value, setValue] = useState(initial);
  useEffect(() => { try { const raw = localStorage.getItem(key); if (raw !== null) { const saved: unknown = JSON.parse(raw); if (valid(saved)) setValue(saved); } } catch {} }, [key, valid]);
  const update = (next: T) => { setValue(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch {} };
  return [value, update] as const;
}
const validSize = (v: unknown): v is string => validCodeSize(v);
export function CodeSizeControl() {
  const [size, setSize] = usePreference("gitdash.code-size", "medium", validSize);
  useEffect(() => { document.documentElement.style.setProperty("--code-font-size", ({small:"11px",medium:"13px",large:"16px"} as Record<string,string>)[size]); }, [size]);
  return <div className="theme-control"><label><span>コード文字サイズ</span><select value={size} onChange={e => setSize(e.target.value)}><option value="small">小</option><option value="medium">中</option><option value="large">大</option></select></label></div>;
}
const validWidth = (v: unknown): v is number => validPaneWidth(v);
export function usePaneWidth(key: string, initial: number) { return usePreference(key, initial, validWidth); }
export function PaneSeparator({width, onChange, label, minimum}: {width:number; onChange:(n:number)=>void; label:string; minimum:number}) {
  const change = (n:number) => onChange(clampPaneWidth(n, minimum));
  return <div className="pane-separator" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={900} aria-valuenow={width} tabIndex={0}
    onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); change(width + (e.key === "ArrowLeft" ? 20 : -20)); } }}
    onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.startX = String(e.clientX); e.currentTarget.dataset.startWidth = String(width); }}
    onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) change(Number(e.currentTarget.dataset.startWidth) + Number(e.currentTarget.dataset.startX) - e.clientX); }}
    onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} />;
}
export function paneStyle(name: string, width: number): CSSProperties { return {[name]: `${width}px`} as CSSProperties; }
