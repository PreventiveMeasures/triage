// The sync-protocol mode a server advertises — shared by the server (which
// emits it) and the client (which parses + caches it) so a change to the
// shape surfaces as a compile error on BOTH sides, the same single-source
// discipline as ./save-error-reason.ts.
//
// Delivered to the client as the first `server-info` frame on a sync
// connection (the WS plane and the SSE+POST fallback share one send path).
// A client uses it to detect whether a deployment speaks the end-to-end
// (`e2e`, zero-knowledge) protocol or the trusted `managed` protocol, cache
// the answer, and refuse a cross-mode switch.

export type ServerMode = 'e2e' | 'managed'

// Managed-mode entry points the server advertises; null for an e2e server.
export interface ManagedServerInfo {
  loginPath: string
  cookieName: string
}

// The `server-info` frame payload (the `type` discriminant is added at the
// send site). `managed` is null unless `mode === 'managed'`.
export interface ServerInfo {
  mode: ServerMode
  managed: ManagedServerInfo | null
}

// The mode-probe route. A client GETs this to learn a server's protocol up
// front — a managed server has no WS plane to carry the connect frame — and
// the response body is the same `ServerInfo` shape emitted as that frame.
export const CONFIG_PATH = '/api/config'
