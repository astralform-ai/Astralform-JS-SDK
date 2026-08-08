export function sanitizeErrorText(text: string): string {
  return text.slice(0, 500).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Convert a snake_case string to camelCase.
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Transform all keys of an object from snake_case to camelCase.
 * Unknown fields pass through by default — a field the API adds and this
 * function does not name is still delivered to the consumer, just under its
 * camelCase name. Only values that need derivation (defaults, coercion,
 * filtering, nesting) should keep hand-mapping.
 *
 * @example
 * ```ts
 * const raw = { message_count: 5, created_at: "2026-01-01T00:00:00Z" };
 * const result = camelizeKeys(raw);
 * // → { messageCount: 5, createdAt: "2026-01-01T00:00:00Z" }
 * ```
 */
export function camelizeKeys<T>(
  obj: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[snakeToCamel(key)] = obj[key];
  }
  return result as T;
}
