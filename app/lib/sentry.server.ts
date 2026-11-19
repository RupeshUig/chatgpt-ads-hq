import * as Sentry from "@sentry/node";

let isInitialized = false;

/**
 * Initializes Sentry server-side error tracking.
 * If SENTRY_DSN is absent or empty, Sentry is not initialized and the app runs normally.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  if (isInitialized) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });

  isInitialized = true;
}

/**
 * Returns whether Sentry has been initialized.
 */
export function isSentryActive(): boolean {
  return isInitialized;
}

/**
 * Captures an exception to Sentry if initialized, otherwise safely no-ops.
 */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!isInitialized) {
    return;
  }
  Sentry.captureException(error, extra ? { extra } : undefined);
}

/**
 * Captures a message to Sentry if initialized, otherwise safely no-ops.
 */
export function captureMessage(message: string, extra?: Record<string, unknown>): void {
  if (!isInitialized) {
    return;
  }
  Sentry.captureMessage(message, extra ? { extra } : undefined);
}
