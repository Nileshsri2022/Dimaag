/**
 * Sensitive-page guardrail (pure function, URL-only — never page-content
 * inspection in v1; privacy: don't read the page just to decide).
 *
 * The UI (Task 14) consumes this for the warn + one-tap confirm flow.
 */

/** Hostname starts with one of these subdomain-like prefixes. */
const MAIL_HOST_PREFIXES = ["mail.", "inbox.", "outlook.", "gmail."];

/** Hostname labels that alone flag a sensitive host (covers app.paypal.com). */
const SENSITIVE_LABELS = ["mail", "wallet", "paypal"];

/** Substrings searched in the URL pathname (credential-ish / transactional paths). */
const SENSITIVE_PATH_PATTERNS = [
  "login",
  "signin",
  "signup",
  "auth",
  "password",
  "token",
  "payment",
  "billing",
];

/**
 * true if the URL (or its hostname) looks like a banking/email/auth page.
 *
 * - `bank` matches the hostname only, so content pages about banking
 *   (e.g. en.wikipedia.org/wiki/Bank) do NOT warn.
 * - credential-ish path words (login/signin/signup/auth/password/token/
 *   payment/billing) match the full pathname, so they warn even on harmless hosts.
 * - Invalid URLs and non-http/https schemes return false (never warn).
 */
export function isSensitive(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.includes("bank")) return true;
  if (MAIL_HOST_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return true;
  }
  const labels = hostname.split(".");
  if (labels.some((label) => SENSITIVE_LABELS.includes(label))) {
    return true;
  }

  const pathname = parsed.pathname.toLowerCase();
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pathname.includes(pattern));
}
