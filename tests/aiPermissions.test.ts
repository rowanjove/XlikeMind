import { describe, expect, it } from 'vitest';
import { apiOriginPattern, manifestCoversApi, requestApiAccess } from '../src/ai/permissions';

describe('API origin permission', () => {
  it('covers localhost from the install manifest and asks for other https origins', () => {
    expect(manifestCoversApi('http://localhost:11434/v1')).toBe(true);
    expect(manifestCoversApi('http://127.0.0.1:1234/v1')).toBe(true);
    expect(manifestCoversApi('https://api.openai.com/v1')).toBe(false);
    expect(apiOriginPattern('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
  });

  it('refuses cleartext cloud endpoints before any request', async () => {
    const result = await requestApiAccess('http://example.com/v1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('https');
  });

  it('allows a private-network http origin pattern', () => {
    expect(apiOriginPattern('http://192.168.1.8:1234/v1')).toBe('http://192.168.1.8:1234/*');
    expect(apiOriginPattern('http://172.16.0.4:11434/v1')).toBe('http://172.16.0.4:11434/*');
  });
});
