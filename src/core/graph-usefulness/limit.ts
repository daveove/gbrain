/**
 * Parse bounded `--limit` flags for DAV-6220 graph commands.
 */

export class InvalidGraphLimitError extends Error {
  constructor(raw: string) {
    super(`--limit must be a positive integer (got "${raw}")`);
    this.name = 'InvalidGraphLimitError';
  }
}

/** Returns undefined when `raw` is omitted; throws on NaN, zero, negative, or non-integer. */
export function parseOptionalPositiveLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new InvalidGraphLimitError(raw);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1) throw new InvalidGraphLimitError(raw);
  return n;
}
