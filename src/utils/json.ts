export function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in text');

  let inString = false;
  let escape = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        return JSON.parse(jsonStr);
      }
    }
  }

  throw new Error('Unterminated JSON object in text');
}

