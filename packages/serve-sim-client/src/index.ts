// serve-sim-client — device gateway client library

// High-level API
export { default, default as Gateway } from "./gateway";
export type { ConnectOptions, GatewayShell, StreamingExecOptions } from "./gateway";
export { ShellResult, ShellPromise, ShellError } from "./gateway";

// Low-level transport
export { GatewayTransport, createGatewayTransport } from "./transport";
export type { GatewayTransportOptions, HeartbeatConfig } from "./transport";

// Discovery
export { fetchGatewayStatus } from "./discovery";
export type { GatewayStatus, DiscoverOptions } from "./discovery";

// Protocol types
export type { ClientMessage, ServerMessage } from "./types";
