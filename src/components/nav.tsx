"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/icons";

export function NavLink({ href, children, icon, badge, exact = false }: { href: string; children: React.ReactNode; icon?: IconName; badge?: number; exact?: boolean }) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  return (
    <Link href={href} className={cn("navlink", active && "navlink-active")}>
      {icon && <Icon name={icon} size={18} className="shrink-0" />}
      <span className="truncate flex-1">{children}</span>
      {badge != null && badge > 0 && (
        <span className="text-[10px] font-semibold rounded-full px-1.5 shrink-0" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{badge}</span>
      )}
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
