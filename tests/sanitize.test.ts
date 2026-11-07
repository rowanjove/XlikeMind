import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  sanitizeUrl,
  markdownDestination,
  escapeYamlString,
  escapeHtml,
  markdownLink,
} from '../src/domain/sanitize';

describe('Sanitization Utilities', () => {
  describe('sanitizeFilename', () => {
    it('removes path traversal sequences and backslashes', () => {
      const malicious = '../../../../etc/passwd';
      const clean = sanitizeFilename(malicious);
      expect(clean).not.toContain('..');
      expect(clean).not.toContain('/');
      expect(clean).not.toContain('\\');
    });

    it('removes invalid Windows filename characters', () => {
      const input = 'my<post>:title"with*wildcard?and|pipe';
      const clean = sanitizeFilename(input);
      expect(clean).toBe('my_post__title_with_wildcard_and_pipe');
    });

    it('falls back to "untitled" if empty or only dots', () => {
      expect(sanitizeFilename('...')).toBe('untitled');
      expect(sanitizeFilename('')).toBe('untitled');
    });

    it('guards against Windows reserved device names', () => {
      expect(sanitizeFilename('aux')).toBe('_aux');
      expect(sanitizeFilename('CON')).toBe('_CON');
      expect(sanitizeFilename('prn.txt')).toBe('_prn.txt');
      expect(sanitizeFilename('nul.md')).toBe('_nul.md');
      expect(sanitizeFilename('com1')).toBe('_com1');
    });
  });

  describe('sanitizeUrl', () => {
    it('allows valid http and https urls', () => {
      expect(sanitizeUrl('https://x.com/tech')).toBe('https://x.com/tech');
      expect(sanitizeUrl('http://example.org/path?query=1')).toBe('http://example.org/path?query=1');
    });

    it('blocks dangerous protocols like javascript: and data:', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBe('');
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
      expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
    });

    it('returns empty string for invalid URL format', () => {
      expect(sanitizeUrl('not-a-url')).toBe('');
      expect(sanitizeUrl('')).toBe('');
    });

    it('keeps markdown link labels from closing the link early', () => {
      expect(markdownLink('看](https://evil.test)这里', 'https://x.com/i/status/1')).toBe(
        '[看 (https://evil.test)这里](https://x.com/i/status/1)'
      );
      expect(markdownLink('原文', 'javascript:alert(1)')).toBe('原文');
    });

    it('rejects markdown destinations that can break out of a link', () => {
      expect(markdownDestination('https://example.com/a)b')).toBe('');
      expect(markdownDestination('javascript:alert(1)')).toBe('');
      expect(markdownDestination('https://example.com/ok')).toBe('https://example.com/ok');
    });
  });

  describe('escapeYamlString', () => {
    it('safely escapes double quotes and backslashes', () => {
      const text = 'He said "Hello\\World"';
      const escaped = escapeYamlString(text);
      expect(escaped).toBe('"He said \\"Hello\\\\World\\""');
    });

    it('handles newlines safely within double quotes', () => {
      const multiline = 'Line 1\nLine 2\r\nLine 3';
      const escaped = escapeYamlString(multiline);
      expect(escaped).toBe('"Line 1\\nLine 2\\nLine 3"');
    });

    it('returns unquoted null when passed null or undefined', () => {
      expect(escapeYamlString(null)).toBe('null');
      expect(escapeYamlString(undefined)).toBe('null');
    });
  });

  describe('escapeHtml', () => {
    it('escapes &, <, >, ", and single quotes', () => {
      const raw = '<script>alert("XSS & harm")</script>';
      const safe = escapeHtml(raw);
      expect(safe).toBe('&lt;script&gt;alert(&quot;XSS &amp; harm&quot;)&lt;/script&gt;');
    });
  });
});
