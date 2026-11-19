import { captureException, captureMessage, isSentryActive } from "./sentry.server";

const REDACTED_KEYS = new Set([
  "apikey",
  "api_key",
  "key",
  "token",
  "accesstoken",
  "password",
  "email",
  "phone",
  "address",
]);

/**
 * Recursively strips sensitive keys from objects and arrays.
 * Replaces matching values with "[REDACTED]".
 */
export function sanitize(data: unknown, seen = new WeakSet<object>()): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== "object") {
    return data;
  }

  if (seen.has(data)) {
    return "[Circular]";
  }
  seen.add(data);

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item, seen));
  }

  const result: Record<string, unknown> = {};

  if (data instanceof Error) {
    result.name = data.name;
    result.message = data.message;
    result.stack = data.stack;
  }

  for (const [key, value] of Object.entries(data)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitize(value, seen);
    }
  }

  return result;
}

export const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.info(`[INFO] ${message}`, sanitize(context));
    } else {
      console.info(`[INFO] ${message}`);
    }
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (context) {
      console.warn(`[WARN] ${message}`, sanitize(context));
    } else {
      console.warn(`[WARN] ${message}`);
    }
  },

  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== "production") {
      if (context) {
        console.debug(`[DEBUG] ${message}`, sanitize(context));
      } else {
        console.debug(`[DEBUG] ${message}`);
      }
    }
  },

  error(errorOrMessage: unknown, context?: Record<string, unknown>): void {
    const sanitizedContext = context ? (sanitize(context) as Record<string, unknown>) : undefined;

    if (errorOrMessage instanceof Error) {
      const sanitizedError = sanitize(errorOrMessage);
      console.error(`[ERROR] ${errorOrMessage.message}`, sanitizedError, sanitizedContext ?? "");
      if (isSentryActive()) {
        captureException(errorOrMessage, sanitizedContext);
      }
    } else {
      const message = typeof errorOrMessage === "string" ? errorOrMessage : JSON.stringify(sanitize(errorOrMessage));
      console.error(`[ERROR] ${message}`, sanitizedContext ?? "");
      if (isSentryActive()) {
        captureMessage(message, sanitizedContext);
      }
    }
  },
};
