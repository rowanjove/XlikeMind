/**
 * Sanitization utilities for security, XSS prevention,
 * YAML escaping, and filesystem safety.
 */

/**
 * Sanitize a string to be safely used as a filename on Windows / Unix.
 * Strips path traversal sequences (../, ..\) and illegal Windows characters: < > : " / \ | ? *
 */
export function sanitizeFilename(filename: string): string {
  // Remove path traversal and directory separators
  let clean = filename.replace(/[\/\\]/g, '_').replace(/\.\.+/g, '_');
  // Remove Windows invalid chars
  clean = clean.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  // Trim spaces, periods and underscores from ends
  clean = clean.replace(/^[\s._]+|[\s._]+$/g, '');
  // Guard against Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(clean)) {
    clean = `_${clean}`;
  }
  return clean || 'untitled';
}

/**
 * Ensure an external link is safe (http/https only).
 * Disallows javascript:, data:, vbscript:, etc.
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // invalid URL format
  }
  return '';
}

/** The post's own status URL is a permalink, not an outbound link. */
export function isOwnStatusPermalink(url: string, postId: string): boolean {
  if (!/^\d{1,25}$/.test(postId)) return false;
  const safe = sanitizeUrl(url);
  if (!safe) return false;
  try {
    const parsed = new URL(safe);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const onX =
      host === 'x.com' ||
      host === 'twitter.com' ||
      host.endsWith('.x.com') ||
      host.endsWith('.twitter.com');
    if (!onX) return false;
    const parts = parsed.pathname.split('/');
    const statusAt = parts.lastIndexOf('status');
    return statusAt >= 0 && parts[statusAt + 1] === postId;
  } catch {
    return false;
  }
}

/**
 * URL safe to place inside a Markdown link or image destination.
 * Rejects non-http(s) URLs and destinations that can break out of the link syntax.
 */
export function markdownDestination(url: string): string {
  const safe = sanitizeUrl(url);
  if (!safe || /[\s<>()]/.test(safe)) {
    return '';
  }
  return safe;
}

/** Markdown link whose label cannot break out of the destination. */
export function markdownLink(label: string, url: string): string {
  const dest = markdownDestination(url);
  const text = markdownText(label.replace(/[\[\]\r\n*]/g, ' ').replace(/\s+/g, ' ').trim());
  if (!dest) return text || '链接不可用';
  return `[${text || dest}](${dest})`;
}

/** Encode untrusted text before placing it in a Markdown document. */
export function markdownText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[\\[\]]/g, '\\$&');
}

/** http(s) image URL safe to put in an img src. Anything else stays blank. */
export function safeImageSrc(url: string | null | undefined): string {
  return sanitizeUrl(url || '');
}

/**
 * Escape a string for safe placement into YAML double-quoted frontmatter value.
 */
export function escapeYamlString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  // Replace backslashes and quotes, escape newlines
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Basic HTML escaping for safe text rendering in raw HTML contexts
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
