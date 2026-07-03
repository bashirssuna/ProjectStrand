// In-repo line-icon set — one consistent 24×24 stroke system (currentColor,
// 1.6 stroke, round caps) used across the nav, module hubs and tool cards.
// No external icon dependency: every glyph is hand-drawn SVG so it themes with
// the CSS variables and ships offline. Reference icons by name via <Icon name=…>.
import type { ReactNode } from "react";

export type IconName =
  | "dashboard" | "projects" | "flask" | "trial" | "subaward" | "collab"
  | "finance" | "hr" | "procurement" | "inventory" | "building" | "access"
  | "modules" | "admin" | "user" | "bell" | "home" | "clock" | "leave"
  | "id" | "list" | "journal" | "statements" | "grant" | "revenue"
  | "invoice" | "receipt" | "reserves" | "asset" | "audit" | "whistle"
  | "compliance" | "voucher" | "slip" | "petty" | "forecast" | "reconcile"
  | "currency" | "fx" | "calendar" | "arrow" | "plus" | "sun" | "moon"
  | "search" | "download" | "check";

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>),
  projects: (<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 10h18" /></>),
  flask: (<><path d="M9 3h6" /><path d="M10 3v6.5L5.2 17a2 2 0 0 0 1.8 3h10a2 2 0 0 0 1.8-3L14 9.5V3" /><path d="M7.5 14h9" /></>),
  trial: (<><path d="M3 12h3.5l2-5 3 10 2.5-7 1.5 2H21" /></>),
  subaward: (<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.2 7.3 15.8 11M15.8 13 8.2 16.7" /></>),
  collab: (<><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.5a3 3 0 0 1 0 6" /><path d="M17.5 14.5A5.5 5.5 0 0 1 21 20" /></>),
  finance: (<><path d="M3 9 12 4l9 5" /><path d="M4 9v9M9 9v9M15 9v9M20 9v9" /><path d="M3 21h18" /></>),
  hr: (<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.6 5.6 0 0 1 11 0" /><circle cx="17.5" cy="9" r="2.3" /><path d="M15 20a4 4 0 0 1 6.5-3.1" /></>),
  procurement: (<><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /><path d="M2.5 3.5H5l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.1a1.5 1.5 0 0 0 1.5-1.2L21 7H6" /></>),
  inventory: (<><path d="M3.3 7.2 12 3l8.7 4.2M3.3 7.2 12 11.5l8.7-4.3M3.3 7.2v9.6L12 21m8.7-13.8v9.6L12 21m0-9.5V21" /></>),
  building: (<><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /><path d="M10 21v-3h4v3" /></>),
  access: (<><path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.6 4-1.2 7-5.2 7-9.6V6Z" /><path d="m9.2 12 2 2 3.6-3.8" /></>),
  modules: (<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  admin: (<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.6M12 18.9v2.6M4.2 7.2l2.2 1.3M17.6 15.5l2.2 1.3M4.2 16.8l2.2-1.3M17.6 8.5l2.2-1.3" /></>),
  user: (<><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>),
  bell: (<><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  home: (<><path d="M4 11 12 4l8 7" /><path d="M6 10v9h12v-9" /></>),
  clock: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  leave: (<><path d="M12 3v3M12 20v1M4 12H3M21 12h-1" /><path d="M12 6a6 6 0 0 0-6 6h12a6 6 0 0 0-6-6Z" /><path d="M12 12v5a2 2 0 0 0 4 0" /></>),
  id: (<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="11" r="2" /><path d="M5.8 16a3 3 0 0 1 5.4 0M14 9.5h4M14 13h3" /></>),
  list: (<><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>),
  journal: (<><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5Z" /><path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" /><path d="M9 7h6" /></>),
  statements: (<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 15v-3M12 15v-6M16 15v-4" /></>),
  grant: (<><path d="M6 3h8l4 4v9M6 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h9" /><path d="M14 3v4h4" /><path d="m14.5 18.5 1.6 1.6 3.4-3.6" /></>),
  revenue: (<><path d="M21 12a9 9 0 1 1-9-9v9Z" /><path d="M12 3a9 9 0 0 1 9 9h-9Z" opacity=".55" /></>),
  invoice: (<><path d="M6 2.5h9l3 3V21l-2-1.2L14 21l-2-1.2L10 21l-2-1.2L6 21Z" /><path d="M9 8h6M9 11.5h6M9 15h4" /></>),
  receipt: (<><path d="M5 3.5h14V21l-2.3-1.4L14.3 21 12 19.6 9.7 21 7.3 19.6 5 21Z" /><path d="M8.5 8h7M8.5 12h7" /></>),
  reserves: (<><path d="M4 8.5C4 6 7.6 4 12 4s8 2 8 4.5-3.6 4.5-8 4.5S4 11 4 8.5Z" /><path d="M4 8.5v7C4 18 7.6 20 12 20s8-2 8-4.5v-7" /><path d="M4 12c0 2.5 3.6 4.5 8 4.5s8-2 8-4.5" /></>),
  asset: (<><rect x="3.5" y="8" width="17" height="12" rx="1.5" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /><path d="M12 12v3" /></>),
  audit: (<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5V4" /><path d="m8.8 13 1.8 1.8 3.8-4" /></>),
  whistle: (<><path d="M3 11a5 5 0 0 1 5-5h3l6-3v16l-6-3H8a5 5 0 0 1-5-5Z" /><path d="M8 16v2.5a1.5 1.5 0 0 0 3 0V16" /></>),
  compliance: (<><path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.6 4-1.2 7-5.2 7-9.6V6Z" /><path d="M12 8v4M12 15h.01" /></>),
  voucher: (<><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5V14a2 2 0 0 0 0-4Z" /><path d="M13 8v8" strokeDasharray="1.4 2.2" /></>),
  slip: (<><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.4" /><path d="M6 10v4M18 10v4" /></>),
  petty: (<><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4.5A1.5 1.5 0 0 1 3 16.5Z" /><path d="M3 8.5V7a2 2 0 0 1 2-2h9" /><circle cx="16.5" cy="12.5" r="1.2" /></>),
  forecast: (<><path d="M3 20V4M3 20h18" /><path d="m6 15 4-4 3 3 5-6" /><path d="M18 8h3v3" /></>),
  reconcile: (<><path d="m3 8 3-3 3 3M6 5v14M21 16l-3 3-3-3M18 19V5" /></>),
  currency: (<><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.5a2.5 2.5 0 0 1 4.3-.6M9.5 14.5a2.5 2.5 0 0 0 4.3.6M8 11h6M8 13h6" /></>),
  fx: (<><path d="M4 8h13l-2.5-2.5M20 16H7l2.5 2.5" /></>),
  calendar: (<><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>),
  arrow: (<><path d="M5 12h14M13 6l6 6-6 6" /></>),
  plus: (<><path d="M12 5v14M5 12h14" /></>),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: (<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />),
  search: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>),
  download: (<><path d="M12 3v11M8 10l4 4 4-4" /><path d="M5 20h14" /></>),
  check: (<path d="m5 12.5 4.5 4.5L19 7" />),
};

export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.6,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
