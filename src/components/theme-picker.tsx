"use client";
import { useEffect, useRef, useState } from "react";
import { THEMES, THEME_KEYS, DEFAULT_THEME } from "@/lib/themes";

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(DEFAULT_THEME);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.documentElement;
    setActive(THEME_KEYS.find((k) => el.classList.contains(k)) ?? DEFAULT_THEME);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(key: string) {
    const el = document.documentElement;
    THEME_KEYS.forEach((k) => el.classList.remove(k));
    el.classList.add(key);
    setActive(key);
    try { document.cookie = `strand_theme=${key}; path=/; max-age=31536000`; } catch {}
    setOpen(false);
  }

  const current = THEMES.find((t) => t.key === active) ?? THEMES[0];

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="btn btn-sm" aria-label="Change theme" title="Change theme" aria-haspopup="menu" aria-expanded={open}>
        <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: current.brand, border: "1px solid var(--border-strong)", verticalAlign: "-1px", marginRight: 6 }} />
        Theme
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-50 card p-2" style={{ minWidth: 184, boxShadow: "var(--shadow)" }}>
          <div className="text-xs px-1 pb-1 mb-1" style={{ color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>Theme</div>
          {THEMES.map((t) => (
            <button key={t.key} role="menuitemradio" aria-checked={t.key === active} onClick={() => pick(t.key)}
              className="w-full flex items-center gap-2 text-sm rounded-md px-2 py-1.5 text-left"
              style={{ background: t.key === active ? "color-mix(in srgb, var(--brand) 14%, transparent)" : "transparent", color: "var(--fg)" }}>
              <span style={{ display: "inline-flex", flexShrink: 0, width: 22, height: 16, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-strong)" }}>
                <span style={{ width: "60%", background: t.bg }} />
                <span style={{ width: "40%", background: t.brand }} />
              </span>
              <span className="flex-1">{t.label}</span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>{t.dark ? "dark" : "light"}</span>
              {t.key === active && <span style={{ color: "var(--brand)" }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
