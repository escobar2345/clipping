/**
 * Retries an async operation up to `retries` times with exponential backoff.
 * Used for network calls to external APIs (Apify, NVIDIA, Deepgram, Buffer)
 * that may fail transiently.
 *
 * @param fn     The async operation to try.
 * @param retries Number of retry attempts (not counting the initial call).
 * @param delayMs Base delay in ms; actual delay doubles each attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number = 500
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = delayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
