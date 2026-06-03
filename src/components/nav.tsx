"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function NavLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  return (
    <Link href={href} className={cn("navlink", active && "navlink-active")}>
      {children}
    </Link>
  );
}

export function TabLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className="px-3 py-2 text-sm rounded-md whitespace-nowrap transition-colors"
      style={active
        ? { background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--brand)", fontWeight: 600 }
        : { color: "var(--muted)" }}
    >
      {children}
    </Link>
  );
}
