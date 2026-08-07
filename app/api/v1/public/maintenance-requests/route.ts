// v1 intentionally delegates to the established public-request handler so the
// unversioned endpoint remains backward-compatible while new integrations can
// pin their contract to a stable API version.
export { OPTIONS, POST } from "@/app/api/public/maintenance-requests/route";
