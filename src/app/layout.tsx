import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Fraunces, Hanken_Grotesk } from "next/font/google";
import { normalizeTheme } from "@/lib/themes";
import "./globals.css";

// Distinctive institutional pairing: a characterful serif for display, a clean
// grotesque for body. Self-hosted by next/font (no runtime CDN).
const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});
const body = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Project Strand",
  description: "Grant & research project management — plans, budgets, requisitions, and reporting.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = normalizeTheme((await cookies()).get("strand_theme")?.value);
  return (
    <html lang="en" className={`${theme} ${display.variable} ${body.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
