/** Presentation only: never authorizes resume, Save or portal writes. */
export function completedEntryReview(action?: string | null, message?: string | null, hasAttention = false): { count: number } | null {
  if (action !== "portal_autofill_review" || hasAttention || !message) return null;
  const match = message.match(/\b(\d+)\/(\d+) approved field\(s\) were entered and read back, but the return is not complete:/i);
  if (!match) return null;
  const entered = Number(match[1]), total = Number(match[2]);
  return Number.isSafeInteger(total) && total > 0 && entered === total ? { count: total } : null;
}
