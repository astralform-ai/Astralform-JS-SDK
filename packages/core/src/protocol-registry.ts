// =============================================================================
// Protocol adapter registry — pluggable UI protocol layer
// =============================================================================
//
// The SDK is framework-agnostic: it never renders. But when the backend
// emits an MCP-style embedded resource (A2UI today, other protocols
// tomorrow) the consumer needs to hand the payload to a renderer. This
// file defines the contract between those two sides:
//
//   • `ProtocolAdapter` — an opaque, framework-specific handle that
//     claims a MIME type. The SDK stores it; the consumer narrows the
//     type when reading it back out.
//
//   • `ProtocolRegistry` — a MIME-keyed map of adapters. One lives on
//     each `ChatSession` so its lifecycle matches the session: clearing
//     on disconnect, swapping on reconnect with a different project.
//
// The consumer decides _whether_ to register an adapter — typically by
// consulting `session.projectStatus.uiComponents` after `connect()`.
// The SDK never auto-registers anything; it just stores what it's told.
// =============================================================================

/**
 * Minimal adapter contract. Frontends extend this with a `render()`
 * method (or equivalent) returning their framework's view type.
 */
export interface ProtocolAdapter {
  /** IANA-style MIME type this adapter handles (e.g. ``application/json+a2ui``). */
  readonly mimeType: string;
}

/**
 * MIME-keyed adapter map, generic on the adapter subtype so consumers
 * can register richer shapes without casting on every read.
 */
export class ProtocolRegistry<T extends ProtocolAdapter = ProtocolAdapter> {
  private adapters = new Map<string, T>();

  /** Register or replace the adapter for a MIME type. */
  register(adapter: T): void {
    this.adapters.set(adapter.mimeType, adapter);
  }

  /** Remove the adapter for a MIME type. No-op if not registered. */
  unregister(mimeType: string): void {
    this.adapters.delete(mimeType);
  }

  /** Returns the adapter for a MIME type, or ``null`` if none is registered. */
  get(mimeType: string): T | null {
    return this.adapters.get(mimeType) ?? null;
  }

  has(mimeType: string): boolean {
    return this.adapters.has(mimeType);
  }

  /** Drop every adapter. Called when a session disconnects. */
  clear(): void {
    this.adapters.clear();
  }

  listMimeTypes(): string[] {
    return Array.from(this.adapters.keys());
  }
}
