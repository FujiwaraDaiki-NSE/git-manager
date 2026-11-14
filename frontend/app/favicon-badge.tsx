"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export default function FaviconBadge({ waiting }: { waiting: number | null }) {
  const pathname = usePathname();
  const projectPath = useSearchParams().get("path");
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon === null) return;
    const originalHref = icon.href;
    const originalType = icon.type;
    let disposed = false;
    if (waiting !== null && waiting > 0) {
      const image = new Image();
      image.onload = () => {
        if (disposed) return;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const context = canvas.getContext("2d");
        if (context === null) return;
        context.drawImage(image, 0, 0, 64, 64);
        const label = String(waiting);
        const width = label.length === 1 ? 36 : 48;
        context.fillStyle = "#b91c1c";
        context.beginPath();
        context.roundRect(64 - width, 0, width, 36, 18);
        context.fill();
        let fontSize = 28;
        context.font = `700 ${fontSize}px sans-serif`;
        while (context.measureText(label).width > width - 6 && fontSize > 8) {
          context.font = `700 ${--fontSize}px sans-serif`;
        }
        context.fillStyle = "#fff";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, 64 - width / 2, 19);
        icon.type = "image/png";
        icon.href = canvas.toDataURL("image/png");
      };
      image.src = "/favicon.svg";
    } else {
      icon.type = "image/svg+xml";
      icon.href = "/favicon.svg";
    }
    return () => {
      disposed = true;
      icon.href = originalHref;
      icon.type = originalType;
    };
  }, [waiting, pathname, projectPath]);
  return null;
}
