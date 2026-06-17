"use client";
import type { CSSProperties, ReactNode } from "react";

// A submit button that asks for confirmation before letting its form submit.
// Used to guard destructive server actions (e.g. clearing a whole budget).
export function ConfirmSubmit({
  message, children, className, style,
}: {
  message: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="submit"
      className={className}
      style={style}
      onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}
    >
      {children}
    </button>
  );
}
