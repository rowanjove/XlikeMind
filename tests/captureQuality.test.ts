import { expect, it } from 'vitest';
import { countCaptureQuality, emptyCaptureQuality, safeCaptureQuality } from '../src/domain/captureQuality';

it('counts gaps once per post and folds unknown labels into an anonymous bucket', () => {
  const result = emptyCaptureQuality();
  countCaptureQuality(result, { captureStatus: 'partial', missingFields: ['text', 'text', 'private-field', '__proto__'] });
  countCaptureQuality(result, { captureStatus: 'complete', missingFields: [] });
  expect(result.statuses).toEqual({ complete: 1, partial: 1, failed: 0, unknown: 0 });
  expect(result.missingFields.text).toBe(1);
  expect(result.missingFields.unknown).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/private-field|__proto__/);
});

it('exports only allowed counts even if the supplied health result is modified', () => {
  const result = emptyCaptureQuality();
  result.statuses.partial = -1;
  result.statuses.failed = Infinity;
  result.missingFields.text = Number.MAX_SAFE_INTEGER + 1;
  Object.assign(result.statuses, { privateStatus: 'secret' });
  Object.assign(result.missingFields, { privateField: 'secret' });
  const safe = safeCaptureQuality(result);
  expect(safe.statuses.partial).toBe(0);
  expect(safe.statuses.failed).toBe(0);
  expect(safe.missingFields.text).toBe(0);
  expect(JSON.stringify(safe)).not.toMatch(/private|secret/);
});
