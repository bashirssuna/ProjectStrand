"use client";

import { useRef } from "react";

// A centered overlay built on <details> (so it's never clipped by table scroll).
// The form uses the server action DIRECTLY (React's optimized server-action form
// path — updates inline without a flash). The modal owns its footer: a Cancel
// button (closes without submitting) and a Save button. Both opening and the
// Cancel are reversible, so an accidental open/click never mutates anything.
export function EditorModal({
  trigger,
  primary,
  title,
  subtitle,
  submitLabel = "Save",
  action,
  children,
}: {
  trigger: string;
  primary?: boolean;
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  action: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute("open");
  return (
    <details className="editor inline-block" ref={ref}>
      <summary className={"btn btn-sm" + (primary ? " btn-primary" : "")}>{trigger}</summary>
      <div className="editor-panel card p-4">
        {title && <div className="font-display text-base font-semibold">{title}</div>}
        {subtitle && <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{subtitle}</p>}
        <form action={action} onSubmit={() => setTimeout(close, 0)} className="space-y-2 mt-2">
          {children}
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn btn-sm flex-1" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-sm btn-primary flex-1">{submitLabel}</button>
          </div>
        </form>
      </div>
    </details>
  );
}
