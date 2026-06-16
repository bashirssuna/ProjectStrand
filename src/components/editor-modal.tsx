"use client";

import { useRef } from "react";

// A centered overlay built on <details> (so it's never clipped by table scroll),
// that closes itself once its form's server action resolves. The server action is
// passed in from the (server) page and wrapped so we can close on success.
export function EditorModal({
  trigger,
  primary,
  title,
  subtitle,
  action,
  children,
}: {
  trigger: string;
  primary?: boolean;
  title?: string;
  subtitle?: string;
  action: (formData: FormData) => Promise<void>;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className="editor inline-block" ref={ref}>
      <summary className={"btn btn-sm" + (primary ? " btn-primary" : "")}>{trigger}</summary>
      <div className="editor-panel card p-4">
        {title && <div className="font-display text-base font-semibold">{title}</div>}
        {subtitle && <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{subtitle}</p>}
        <form
          action={async (fd) => {
            await action(fd);
            ref.current?.removeAttribute("open");
          }}
          className="space-y-2 mt-2"
        >
          {children}
        </form>
      </div>
    </details>
  );
}
