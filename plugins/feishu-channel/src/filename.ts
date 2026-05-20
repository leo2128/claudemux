/**
 * Sanitizing attacker-controlled inbound file names.
 *
 * Feishu delivers `file_name` straight from the sender, and the channel uses
 * it to build a path inside the inbox directory. An unsanitized name could
 * contain path separators or `..` and escape that directory, so every inbound
 * name is forced through `sanitizeInboundFileName` first.
 */

/** Longest sanitized name we keep. */
export const MAX_FILENAME_LENGTH = 80

/**
 * Reduce an arbitrary string to a safe single path component: no separators,
 * no leading dots (so it can never be `.`, `..`, or hidden), only portable
 * file-name characters, non-empty, and length-bounded.
 */
export function sanitizeInboundFileName(name: string): string {
  // Keep only the final path component — drop any directory parts.
  const lastComponent = name.split(/[/\\]/).pop() ?? ''
  // Replace anything outside a conservative safe set.
  let cleaned = lastComponent.replace(/[^A-Za-z0-9._-]/g, '_')
  // Strip leading dots so the result is never '.', '..', or a hidden file.
  cleaned = cleaned.replace(/^\.+/, '')
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_FILENAME_LENGTH)
  }
  return cleaned.length > 0 ? cleaned : 'file'
}
