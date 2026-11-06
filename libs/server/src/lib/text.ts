export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return '••••';
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function extractJson<T>(raw: string): T | undefined {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const direct = tryParse<T>(cleaned);
  if (direct !== undefined) {
    return direct;
  }

  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    return undefined;
  }
  const start = Math.min(...starts);
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) {
    return undefined;
  }
  return tryParse<T>(cleaned.slice(start, end + 1));
}

function tryParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'will', 'should', 'must', 'have', 'has', 'are', 'was', 'were', 'you', 'your',
  'not', 'but', 'all', 'any', 'can', 'our', 'its', 'it', 'is', 'be', 'to',
  'of', 'in', 'on', 'or', 'as', 'at', 'by', 'an', 'a', 'we', 'they', 'them',
]);

/**
 * Pulls search terms out of prose: identifiers, file names, quoted phrases and
 * significant words. Used to locate the code that a wiki block describes.
 */
export function searchTerms(text: string, limit = 24): string[] {
  const terms = new Set<string>();

  for (const match of text.matchAll(/`([^`\n]{2,80})`/g)) {
    terms.add(match[1].trim());
  }
  for (const match of text.matchAll(/["“]([^"”\n]{2,80})["”]/g)) {
    terms.add(match[1].trim());
  }
  for (const match of text.matchAll(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|cs|css|html|yml|yaml)\b/g)) {
    terms.add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || lower.length < 4) {
      continue;
    }
    terms.add(word);
  }

  return Array.from(terms).slice(0, limit);
}
