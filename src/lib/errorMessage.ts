/**
 * Shared helper: a user-displayable message for a caught value of any shape
 * (Error instances keep their message, everything else is stringified).
 * Hoisted here from router.ts / DataManagement.tsx per the Task 13 review's
 * carried-forward note.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
