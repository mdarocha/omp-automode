import type { ClassifierErrorKind } from "./types.ts";

const HTTP_STATUS_PATTERNS = [
  /^\s*(?:HTTP\s+)?([45]\d\d)\b/i,
  /\b(?:HTTP|status(?:\s+code)?)[:= ]+([45]\d\d)\b/i,
];
const RATE_LIMIT_PATTERN = /rate[_\s-]?limit|too many requests|quota/i;
const TIMEOUT_PATTERN = /timed out|timeout|ETIMEDOUT/i;
const SERVER_PATTERN = /overloaded|service unavailable|bad gateway|internal server error/i;
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|authentication|invalid[_\s]api[_\s]key/i;
const RETRY_AFTER_MS_PATTERN = /retry-after-ms[=:\s]+(\d+(?:\.\d+)?)/i;
const RETRY_AFTER_SECONDS_PATTERN = /retry-after(?!-ms)[=:\s]+(\d+(?:\.\d+)?)/i;

const HTTP_STATUS_RATE_LIMIT = 429;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_REQUEST_TIMEOUT = 408;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;
const MILLISECONDS_PER_SECOND = 1000;

function httpStatus(message: string): number | undefined {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(message);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Wait the provider asked for, from the `retry-after-ms=` / `retry-after=`
 * (seconds) suffix OMP appends to provider error messages. Undefined when the
 * message carries neither.
 */
export function parseRetryAfterMs(message: string): number | undefined {
  const milliseconds = RETRY_AFTER_MS_PATTERN.exec(message);
  if (milliseconds) {
    return Math.round(Number(milliseconds[1]));
  }
  const seconds = RETRY_AFTER_SECONDS_PATTERN.exec(message);
  if (seconds) {
    return Math.round(Number(seconds[1]) * MILLISECONDS_PER_SECOND);
  }
  return undefined;
}

/**
 * Classify a failed classifier model call from the provider's error message.
 * Only the typed kind and the retry hint leave this function; the message is
 * never logged or shown to the model.
 */
export function classifyProviderError(
  message: string | undefined,
  stopReason?: string,
): { kind: ClassifierErrorKind; retryAfterMs?: number } {
  const text = message ?? "";
  const retryAfterMs = parseRetryAfterMs(text);
  const withRetry = (kind: ClassifierErrorKind) =>
    retryAfterMs === undefined ? { kind } : { kind, retryAfterMs };

  const status = httpStatus(text);
  if (status === HTTP_STATUS_RATE_LIMIT || RATE_LIMIT_PATTERN.test(text)) {
    return withRetry("rate-limit");
  }
  if (status === HTTP_STATUS_REQUEST_TIMEOUT || TIMEOUT_PATTERN.test(text)) {
    return withRetry("timeout");
  }
  if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN || AUTH_PATTERN.test(text)) {
    return withRetry("auth");
  }
  if (
    (status !== undefined && status >= HTTP_STATUS_SERVER_ERROR_MIN) ||
    SERVER_PATTERN.test(text)
  ) {
    return withRetry("server");
  }
  if (stopReason === "aborted") {
    return withRetry("aborted");
  }
  // A response that ended abnormally without any provider error text (for
  // example `length`) is an unusable answer, not a provider failure.
  if (!text && stopReason !== undefined && stopReason !== "error") {
    return withRetry("invalid-response");
  }
  return withRetry("provider");
}
