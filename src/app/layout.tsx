import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project Strand",
  description: "Grant & research project management — plans, budgets, requisitions, and reporting.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("strand_theme")?.value;
  return (
    <html lang="en" className={theme === "light" ? "light" : ""} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
