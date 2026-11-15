"use client";
import { scrollEdges } from "./ui-preference-tools.mjs";
import { useEffect, useRef, useState, type ReactNode } from "react";
export default function ScrollShadow({children, className, label}: {children:ReactNode; className:string; label:string}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({left:false,right:false});
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setEdges(scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
    const resize = new ResizeObserver(update); resize.observe(el); for (const child of el.children) resize.observe(child);
    const mutation = new MutationObserver(update); mutation.observe(el,{subtree:true,childList:true,characterData:true});
    el.addEventListener("scroll",update); update();
    return () => {resize.disconnect(); mutation.disconnect(); el.removeEventListener("scroll",update);};
  }, []);
  return <div className="scroll-shadow-frame" data-left={edges.left} data-right={edges.right}><div ref={ref} className={className} role="region" tabIndex={0} aria-label={label} style={{overflowX:"auto"}}>{children}</div></div>;
}
