export const DEFAULT_SCAN_LIMIT = 100;
export const MAX_SCAN_LIMIT = 2000;

export function normalizeScanLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_SCAN_LIMIT, Math.floor(value)))
    : DEFAULT_SCAN_LIMIT;
}
