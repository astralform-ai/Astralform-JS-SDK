import { RateLimitError, type RateLimitErrorDetails } from "./errors.js";
import { sanitizeErrorText } from "./utils.js";

const DEFAULT_MESSAGE = "Rate limit exceeded";

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseJsonObject(rawText: string): Record<string, unknown> | undefined {
  if (!rawText) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors and fall back to text-only handling.
  }
  return undefined;
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const numeric = parseNumber(value);
  if (numeric !== undefined) {
    return Math.max(0, Math.ceil(numeric));
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const diffMs = asDate - Date.now();
    return Math.max(0, Math.ceil(diffMs / 1000));
  }

  return undefined;
}

function parseResetTimestamp(value: unknown): number | undefined {
  const numeric = parseNumber(value);
  if (numeric !== undefined) {
    if (numeric > 1_000_000_000_000) {
      return Math.floor(numeric);
    }
    return Math.floor(numeric * 1000);
  }

  const asString = parseString(value);
  if (!asString) {
    return undefined;
  }

  const asDate = Date.parse(asString);
  if (Number.isFinite(asDate)) {
    return asDate;
  }
  return undefined;
}

function pickFirst<T>(
  payload: Record<string, unknown>,
  keys: string[],
  parser: (value: unknown) => T | undefined,
): T | undefined {
  for (const key of keys) {
    const parsed = parser(payload[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function buildRateLimitDetails(
  payload: Record<string, unknown>,
  headers?: Headers,
): RateLimitErrorDetails {
  const headerRetryAfter = headers
    ? parseRetryAfterHeader(headers.get("retry-after"))
    : undefined;
  const bodyRetryAfter = pickFirst(
    payload,
    ["retry_after", "retryAfter", "retry_after_sec", "retryAfterSec"],
    parseNumber,
  );

  const retryAfterSec = bodyRetryAfter ?? headerRetryAfter;

  const headerReset = headers
    ? parseResetTimestamp(
        headers.get("x-ratelimit-reset") ?? headers.get("x-ratelimit-reset-at"),
      )
    : undefined;
  const bodyReset = parseResetTimestamp(
    payload.reset_at ?? payload.resetAt ?? payload.reset,
  );

  const resetAt =
    bodyReset ??
    headerReset ??
    (retryAfterSec !== undefined
      ? Date.now() + retryAfterSec * 1000
      : undefined);

  const limit =
    pickFirst(payload, ["limit", "rate_limit", "max"], parseNumber) ??
    (headers ? parseNumber(headers.get("x-ratelimit-limit")) : undefined);

  const remaining =
    pickFirst(payload, ["remaining", "rate_limit_remaining"], parseNumber) ??
    (headers ? parseNumber(headers.get("x-ratelimit-remaining")) : undefined);

  const scope =
    pickFirst(payload, ["scope", "limit_scope"], parseString) ??
    (headers ? parseString(headers.get("x-ratelimit-scope")) : undefined);

  const policyId =
    pickFirst(payload, ["policy_id", "policyId", "policy"], parseString) ??
    (headers
      ? parseString(
          headers.get("x-ratelimit-policy") ??
            headers.get("x-ratelimit-policy-id"),
        )
      : undefined);

  const requestId =
    pickFirst(payload, ["request_id", "requestId"], parseString) ??
    (headers
      ? parseString(
          headers.get("x-request-id") ?? headers.get("x-correlation-id"),
        )
      : undefined);

  return {
    retryAfterSec,
    resetAt,
    scope,
    policyId,
    limit,
    remaining,
    requestId,
  };
}

export function createRateLimitErrorFromPayload(
  payload: Record<string, unknown>,
  fallbackMessage = DEFAULT_MESSAGE,
): RateLimitError {
  const message = pickFirst(
    payload,
    ["message", "error_description"],
    parseString,
  );
  return new RateLimitError(
    message ?? fallbackMessage,
    buildRateLimitDetails(payload),
  );
}

export function createRateLimitErrorFromHttp(
  response: Response,
  rawText: string,
): RateLimitError {
  const payload = parseJsonObject(rawText) ?? {};
  const details = buildRateLimitDetails(payload, response.headers);

  const sanitizedText = sanitizeErrorText(rawText);
  const message =
    pickFirst(payload, ["message", "error_description"], parseString) ??
    (sanitizedText || DEFAULT_MESSAGE);

  return new RateLimitError(message, details);
}
