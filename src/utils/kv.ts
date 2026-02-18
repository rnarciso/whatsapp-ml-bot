export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeYesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (['sim', 's', 'yes', 'y', 'true', '1'].includes(v)) return true;
  if (['nao', 'não', 'n', 'no', 'false', '0'].includes(v)) return false;
  return null;
}

