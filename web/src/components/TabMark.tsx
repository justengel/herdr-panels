import { useEffect, useState } from "react";
import { contentUrl } from "../api";
import { TAB_ICONS } from "../tabIcons";

export function TabMark({ icon, className = "tab-mark" }: { icon?: string | null; className?: string }) {
  const value = icon?.trim() ?? "";
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [value]);
  if (!value) return null;
  if (value.startsWith("file:")) {
    if (broken) return null;
    return (
      <img
        className={`${className} is-file`}
        src={contentUrl(value.slice("file:".length))}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
      />
    );
  }
  const preset = TAB_ICONS[value];
  if (preset) {
    return (
      <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
        <path d={preset.d} />
      </svg>
    );
  }
  return <span className={`${className} is-text`}>{value}</span>;
}
