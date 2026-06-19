// Theme registry shared by the root layout (server) and the theme picker (client).
// Each theme key maps to a CSS class in globals.css (the dark "charcoal" theme is the
// :root default, so its class simply inherits :root). `bg`/`brand` drive the swatches
// shown in the picker.
export type ThemeDef = { key: string; label: string; dark: boolean; bg: string; brand: string };

export const THEMES: ThemeDef[] = [
  { key: "light", label: "Light", dark: false, bg: "#f6f6f8", brand: "#a87d2e" },
  { key: "sand", label: "Sand", dark: false, bg: "#f5f0e8", brand: "#b05f3c" },
  { key: "ocean", label: "Ocean", dark: false, bg: "#eef3f5", brand: "#1f7a8c" },
  { key: "forest", label: "Forest", dark: false, bg: "#eef3ee", brand: "#3d7a4e" },
  { key: "charcoal", label: "Charcoal", dark: true, bg: "#0a0a0f", brand: "#d4a853" },
  { key: "midnight", label: "Midnight", dark: true, bg: "#0a1020", brand: "#5a9bd4" },
  { key: "slate", label: "Slate", dark: true, bg: "#10131a", brand: "#8b7fd4" },
];

export const THEME_KEYS = THEMES.map((t) => t.key);
export const DEFAULT_THEME = "light";

// Normalise a stored cookie value (incl. the legacy "dark"/"light" values) to a key.
export function normalizeTheme(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_THEME;
  if (raw === "dark") return "charcoal"; // legacy toggle value
  return THEME_KEYS.includes(raw) ? raw : DEFAULT_THEME;
}
