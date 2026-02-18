export type DraftAttributeValue = { value_name?: string; value_id?: string };

export function parseUserAttributeValue(raw: string): DraftAttributeValue | null {
  const v = raw.trim();
  if (!v) return null;

  const lower = v.toLowerCase();
  if (v.startsWith('@')) {
    const id = v.slice(1).trim();
    if (id) return { value_id: id };
  }

  const prefixes: Array<[string, 'value_id' | 'value_name']> = [
    ['value_id:', 'value_id'],
    ['id:', 'value_id'],
    ['value_name:', 'value_name'],
    ['name:', 'value_name'],
  ];
  for (const [pfx, kind] of prefixes) {
    if (lower.startsWith(pfx)) {
      const rest = v.slice(pfx.length).trim();
      if (!rest) return null;
      return kind === 'value_id' ? { value_id: rest } : { value_name: rest };
    }
  }

  return { value_name: v };
}

export function hasAttributeValue(v: DraftAttributeValue | undefined): boolean {
  if (!v) return false;
  return Boolean((v.value_id && v.value_id.trim()) || (v.value_name && v.value_name.trim()));
}

