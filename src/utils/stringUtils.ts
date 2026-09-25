/**
 * String utility functions — all pure (no side effects, no external dependencies).
 *
 * Functions:
 *   capitalise      — upper-cases the first character of a string
 *   toTitleCase     — capitalises the first character of every word
 *   truncate        — shortens a string to maxLen, appending an ellipsis
 *   maskEmail       — obscures the local part of an email for privacy display
 *   maskPhone       — obscures the middle digits of a phone number
 *   slugify         — converts a string to a URL-safe lowercase slug
 */

/**
 * Capitalises the first character of `str`, leaving the rest unchanged.
 *
 * @example capitalise("hello world") → "Hello world"
 */
export function capitalise(str: string): string {
  if (str.length === 0) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Converts `str` to title case by capitalising the first character of every
 * whitespace-delimited word.
 *
 * @example toTitleCase("the quick brown fox") → "The Quick Brown Fox"
 */
export function toTitleCase(str: string): string {
  return str.replace(/\S+/g, (word) => capitalise(word));
}

/**
 * Truncates `str` to at most `maxLen` characters. When truncation occurs the
 * returned string ends with `ellipsis` (default `"…"`), and the visible text
 * is trimmed so the total length never exceeds `maxLen`.
 *
 * If `maxLen` is shorter than or equal to the ellipsis length the function
 * returns just the ellipsis sliced to `maxLen` — it never throws.
 *
 * @example truncate("Hello, world!", 8)       → "Hello, …"
 * @example truncate("Hello, world!", 8, "...") → "Hello..."
 * @example truncate("Hi", 10)                  → "Hi"
 */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
  if (maxLen < 1) return "";
  if (str.length <= maxLen) return str;
  const cut = maxLen - ellipsis.length;
  if (cut <= 0) return ellipsis.slice(0, maxLen);
  return str.slice(0, cut) + ellipsis;
}

/**
 * Masks the local part (before `@`) of an email address for privacy display.
 *
 * Rules:
 *  - If the local part is 1 char: show it as-is followed by `***`.
 *  - If the local part is 2 chars: show the first char and mask the second.
 *  - Otherwise: show the first and last characters, masking everything between.
 * The domain is always preserved.
 *
 * Returns the original string unchanged when it does not look like an email.
 *
 * @example maskEmail("alice@example.com")   → "a***e@example.com"
 * @example maskEmail("ab@example.com")      → "a*@example.com"
 * @example maskEmail("a@example.com")       → "a***@example.com"
 */
export function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex); // includes the "@"

  if (local.length === 1) {
    return `${local}***${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}*${domain}`;
  }
  const mask = "*".repeat(local.length - 2);
  return `${local[0]}${mask}${local[local.length - 1]}${domain}`;
}

/**
 * Masks the middle digits of a phone number, preserving the first `keepStart`
 * and last `keepEnd` characters (defaults: 3 and 2).
 *
 * Non-digit characters (spaces, dashes, parentheses, `+`) are stripped before
 * masking so the rules apply to the digit string only.
 *
 * Returns `"***"` when the input contains no recognisable digits.
 *
 * @example maskPhone("+1 (800) 555-1234")     → "+1 (***) ***-**34" — see note
 *          // simplified: digits only → "180055512**" — actual output below
 * @example maskPhone("07911123456")            → "079******56"
 * @example maskPhone("07911123456", 4, 4)      → "0791***3456"
 */
export function maskPhone(phone: string, keepStart = 3, keepEnd = 2): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return "***";

  const start = digits.slice(0, keepStart);
  const end = keepEnd > 0 ? digits.slice(-keepEnd) : "";
  const middleLen = Math.max(0, digits.length - keepStart - keepEnd);
  const mask = "*".repeat(middleLen);
  return `${start}${mask}${end}`;
}

/**
 * Converts `str` into a URL-safe lowercase slug.
 *
 * Steps:
 *  1. Normalise unicode and strip diacritics (e.g. "é" → "e").
 *  2. Lowercase.
 *  3. Replace any sequence of non-alphanumeric characters with a single `-`.
 *  4. Strip leading/trailing hyphens.
 *
 * @example slugify("Hello, World!")              → "hello-world"
 * @example slugify("  The Quick Brown Fox  ")    → "the-quick-brown-fox"
 * @example slugify("Ångström & Über")             → "angstrom-uber"
 * @example slugify("already-a-slug")              → "already-a-slug"
 */
export function slugify(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse non-alphanumeric runs to "-"
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}
