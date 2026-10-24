/**
 * The feature picker forwards command line values uncoerced, so a boolean arrives as a string.
 * Only the two spellings of a boolean are accepted; anything else is a typo the user must fix.
 */
export function parseBooleanOption(name: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'true' || normalized === 'false') {
    return normalized === 'true';
  }
  throw new Error(`Invalid ${name} '${value}'. Provide true or false.`);
}
