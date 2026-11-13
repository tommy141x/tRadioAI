/** Normalize a frequency to 4 decimal places, the way tRadio keys them. Throws on invalid input. */
export function normalizeFrequency(frequency: string | number): number {
  const value = typeof frequency === "string" ? Number.parseFloat(frequency) : frequency;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid frequency: ${frequency}. Frequency must be a valid number.`);
  }
  // Checked on the result as well: `value * 10000` overflows to Infinity for a
  // large finite input, which would otherwise poison a Map key.
  const normalized = Math.round(value * 10000) / 10000;
  if (!Number.isFinite(normalized)) {
    throw new Error(`Invalid frequency: ${frequency}. Frequency is out of representable range.`);
  }
  return normalized;
}
