import type { Config } from "tailwindcss";
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)", surface: "var(--surface)", panel: "var(--panel)",
        border: "var(--border)", muted: "var(--muted)", fg: "var(--fg)",
        brand: "var(--brand)", "brand-fg": "var(--brand-fg)",
        ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", info: "var(--info)",
      },
      fontFamily: { sans: ["ui-sans-serif","system-ui","-apple-system","Segoe UI","Roboto","Helvetica","Arial","sans-serif"], mono: ["ui-monospace","SFMono-Regular","Menlo","monospace"] },
    },
  },
  plugins: [],
};
export default config;
