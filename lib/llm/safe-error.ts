/** Error reporting must never interrupt provider failover, even for hostile values. */
export function safeErrorMessage(error: unknown): string {
  try {
    // Both instanceof and message access can throw for proxies or accessors.
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unprintable thrown value";
  }
}
