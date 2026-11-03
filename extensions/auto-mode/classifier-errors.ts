import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ClassifierErrorKind, ClassifierFailure } from "./types.ts";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_AUTH_STATUSES = new Set([401, 402, 403]);
const HTTP_REJECTED_REQUEST_STATUSES = new Set([400, 404, 422]);
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/** OMP appends the provider's delay to error messages as `retry-after-ms=<n>`. */
const RETRY_AFTER_MS_PATTERN = /retry-after-ms[=:]\s*(\d+(?:\.\d+)?)/i;
/** The standard header form: `retry-after: 120` (seconds). */
const RETRY_AFTER_SECONDS_PATTERN = /retry-after[=:]\s*(\d+(?:\.\d+)?)/i;
const STATUS_PATTERNS = [
  /^\s*(\d{3})\b/,
  /\bHTTP\s*(?:status\s*)?(\d{3})\b/i,
  /\bstatus(?: code)?[=: ]+(\d{3})\b/i,
];

const TIMEOUT_PATTERN = /timed?[ -]?out|timeout|deadline exceeded|etimedout/i;
const RATE_LIMIT_PATTERN =
  /rate[ _-]?limit|too many requests|quota|usage limit|resource[ _-]?exhausted/i;
const AUTH_PATTERN =
  /unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication|permission denied|no api key|billing|insufficient[ _-]?(?:credit|funds)|credential/i;
const REJECTED_REQUEST_PATTERN =
  /unsupported parameter|invalid[ _-]?request|bad request/i;
const CONTEXT_LIMIT_PATTERN = /context (?:length|window)|maximum context|too long/i;

/** Delay the provider asked for, from the message OMP and Pi AI produce for failed requests. */
export function parseRetryAfterMs(message: string): number | undefined {
  const millis = RETRY_AFTER_MS_PATTERN.exec(message)?.[1];
  if (millis !== undefined) {
    return Math.round(Number(millis));
  }
  const seconds = RETRY_AFTER_SECONDS_PATTERN.exec(message)?.[1];
  return seconds === undefined
    ? undefined
    : Math.round(Number(seconds) * MS_PER_SECOND);
}

/** A `Retry-After` response header holding a number of seconds. HTTP-date values are ignored. */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * MS_PER_SECOND)
    : undefined;
}

function statusFromMessage(message: string): number | undefined {
  for (const pattern of STATUS_PATTERNS) {
    const status = pattern.exec(message)?.[1];
    if (status !== undefined) {
      return Number(status);
    }
  }
  return undefined;
}

function kindFromStatus(status: number): ClassifierErrorKind | undefined {
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return "rate-limit";
  }
  if (status === HTTP_REQUEST_TIMEOUT) {
    return "timeout";
  }
  if (HTTP_AUTH_STATUSES.has(status)) {
    return "auth";
  }
  if (status === HTTP_PAYLOAD_TOO_LARGE) {
    return "context-limit";
  }
  if (HTTP_REJECTED_REQUEST_STATUSES.has(status)) {
    return "invalid-response";
  }
  if (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX) {
    return "server";
  }
  return undefined;
}

function kindFromText(message: string): ClassifierErrorKind {
  if (TIMEOUT_PATTERN.test(message)) {
    return "timeout";
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return "rate-limit";
  }
  if (AUTH_PATTERN.test(message)) {
    return "auth";
  }
  if (CONTEXT_LIMIT_PATTERN.test(message)) {
    return "context-limit";
  }
  if (REJECTED_REQUEST_PATTERN.test(message)) {
    return "invalid-response";
  }
  // Overload, 5xx, dropped connections, and anything unrecognized: a retry or
  // another candidate may succeed, and nothing says the request itself is bad.
  return "server";
}

/** Type a provider or transport error from its HTTP status (when known) and message. */
export function classifyProviderError(
  message: string,
  status: number | undefined = statusFromMessage(message),
): ClassifierFailure {
  const kind = (status === undefined ? undefined : kindFromStatus(status)) ??
    kindFromText(message);
  const retryAfterMs = kind === "rate-limit" || kind === "server"
    ? parseRetryAfterMs(message)
    : undefined;
  return {
    kind,
    message,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function statusOfError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** Type an error thrown by a classifier request. `parentSignal` is the caller's cancellation signal. */
export function failureFromThrown(
  error: unknown,
  parentSignal: AbortSignal | undefined,
): ClassifierFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (parentSignal?.aborted) {
    return { kind: "aborted", message };
  }
  return classifyProviderError(message, statusOfError(error));
}

/** Type a response whose `stopReason` is not a clean stop. */
export function failureFromResponse(
  response: AssistantMessage,
  message: string,
  parentSignal: AbortSignal | undefined,
): ClassifierFailure {
  if (response.stopReason === "aborted") {
    return parentSignal?.aborted
      ? { kind: "aborted", message }
      : { kind: "server", message };
  }
  if (response.stopReason === "error") {
    return classifyProviderError(response.errorMessage || message);
  }
  // `length`, a stray `toolUse`: the model ran but gave no usable output.
  return { kind: "invalid-response", message };
}

const KIND_LABELS: Record<ClassifierErrorKind, string> = {
  "rate-limit": "rate limited",
  timeout: "timed out",
  server: "provider error",
  auth: "authentication failed",
  "invalid-response": "invalid response",
  "context-limit": "context limit",
  "no-classifier": "no classifier model",
  aborted: "cancelled",
};

/** `53m`, `2h 5m`, `45s`: coarse, for reasons read by humans. */
export function formatDuration(ms: number): string {
  if (ms < 90 * MS_PER_SECOND) {
    return `${Math.max(1, Math.round(ms / MS_PER_SECOND))}s`;
  }
  if (ms < 90 * MS_PER_MINUTE) {
    return `${Math.round(ms / MS_PER_MINUTE)}m`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms - hours * MS_PER_HOUR) / MS_PER_MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

const DETAIL_MAX_CHARS = 160;
/** Failures whose cause the user or maintainer must see, because retrying will not clear them. */
const DETAILED_KINDS: Partial<Record<ClassifierErrorKind, true>> = {
  auth: true,
  "invalid-response": true,
  "context-limit": true,
  "no-classifier": true,
};

function failureLabel(failure: ClassifierFailure): string {
  const label = KIND_LABELS[failure.kind];
  return DETAILED_KINDS[failure.kind] && failure.message
    ? `${label}: ${failure.message.slice(0, DETAIL_MAX_CHARS)}`
    : label;
}

/**
 * Block reason when no classifier candidate could decide, e.g.
 * `classifier unavailable (rate limited, retry in 53m)`. `retryInMs` is the
 * soonest time any candidate is expected to accept requests again.
 */
export function unavailableReason(
  failures: ClassifierFailure[],
  retryInMs: number | undefined,
): string {
  const labels = [...new Set(failures.map(failureLabel))];
  const details = [
    ...(labels.length === 0 ? ["no candidate model"] : labels),
    ...(retryInMs === undefined ? [] : [`retry in ${formatDuration(retryInMs)}`]),
  ];
  return `classifier unavailable (${details.join(", ")})`;
}
