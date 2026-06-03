"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);
  function toggle() {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    try { document.cookie = `strand_theme=${next ? "light" : "dark"}; path=/; max-age=31536000`; } catch {}
  }
  return (
    <button onClick={toggle} className="btn btn-sm" aria-label="Toggle theme" title="Toggle theme">
      {light ? "☀" : "☾"}
    </button>
  );
}
