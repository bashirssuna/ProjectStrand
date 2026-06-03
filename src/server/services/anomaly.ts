import "server-only";
// Server-only wrapper around the plain core (the core is also imported by the
// seed script, which runs outside the React/server-only runtime).
export { evaluateProject } from "@/server/services/anomaly-core";
