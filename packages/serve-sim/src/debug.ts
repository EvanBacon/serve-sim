import createDebug from "debug";

// Namespaces are scoped under `serve-sim:*` so `DEBUG=serve-sim*` enables all
// of them. The most common stream-died debugging path is:
//   serve-sim:state    — state file lifecycle (helper alive? sim booted?)
//   serve-sim:helper   — helper spawn / readiness / exit
//   serve-sim:mw       — middleware state selection + stale-helper recycling
//   serve-sim:cli      — top-level command dispatch
export const debugCli = createDebug("serve-sim:cli");
export const debugHelper = createDebug("serve-sim:helper");
export const debugState = createDebug("serve-sim:state");
export const debugMw = createDebug("serve-sim:mw");
