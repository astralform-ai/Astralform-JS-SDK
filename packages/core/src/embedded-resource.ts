// =============================================================================
// Embedded Resource detection — protocol-agnostic
// =============================================================================
//
// The backend can emit rich UI surfaces (A2UI, and future protocols) by
// wrapping a tool result in an MCP-style embedded resource:
//
//   {
//     "_embedded_resource": true,
//     "mime_type": "application/json+a2ui",
//     "uri": "a2ui://surface/<id>",
//     "payload": { ...protocol-specific... }
//   }
//
// The SDK stays protocol-agnostic: it exposes a detector/parser so
// frontends can route the payload to a registered renderer for the
// matching MIME type. The SDK itself never imports a renderer.
// =============================================================================

/**
 * Parsed shape of an MCP-style embedded resource, as emitted by the
 * backend's UI component tools (``render_surface``, ``update_surface``).
 */
export interface EmbeddedResource {
  /** IANA-style MIME type, e.g. "application/json+a2ui". */
  mimeType: string;
  /** Opaque URI (e.g. "a2ui://surface/my-form"). */
  uri: string;
  /** Protocol-specific payload — shape depends on ``mimeType``. */
  payload: Record<string, unknown>;
}

/**
 * Detect whether a value is an embedded resource wrapper. The check is
 * purposely loose — any object with ``_embedded_resource: true`` is
 * accepted, which matches the MCP convention and keeps the SDK
 * forward-compatible with future protocols.
 */
export function isEmbeddedResource(value: unknown): value is {
  _embedded_resource: true;
  mime_type?: string;
  uri?: string;
  payload?: Record<string, unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _embedded_resource?: unknown })._embedded_resource === true
  );
}

/**
 * Parse an embedded resource from arbitrary tool output. Returns
 * ``null`` when the value isn't an embedded resource or is malformed.
 *
 * Accepts either an object (the preferred wire format) or a JSON
 * string containing one (defense in depth — some transport layers
 * historically serialized tool results before sending).
 */
export function parseEmbeddedResource(value: unknown): EmbeddedResource | null {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    // Only try JSON.parse if it plausibly looks like a JSON object
    // starting with `{`. Avoids pathological input.
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isEmbeddedResource(candidate)) return null;
  const mimeType = candidate.mime_type;
  const uri = candidate.uri;
  const payload = candidate.payload;
  if (typeof mimeType !== "string" || !mimeType) return null;
  if (typeof uri !== "string" || !uri) return null;
  if (!payload || typeof payload !== "object") return null;
  return {
    mimeType,
    uri,
    payload: payload as Record<string, unknown>,
  };
}
