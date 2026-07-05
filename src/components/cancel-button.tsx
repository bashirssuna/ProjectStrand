"use client";

// Closes the nearest <details> popover (e.g. the "Edit" editor panels) without
// submitting anything — a Cancel affordance for inline edit forms.
export function CancelButton({ className, children = "Cancel" }: { className?: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => { (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open"); }}
    >
      {children}
    </button>
  );
}
