import { randomBytes } from "node:crypto";

// Compact, sortable-ish, collision-resistant id. cuid-shaped for readability.
export function id(prefix = "c"): string {
  const t = Date.now().toString(36);
  const r = randomBytes(8).toString("hex");
  return `${prefix}${t}${r}`.slice(0, 25);
}
