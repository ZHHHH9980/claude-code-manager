import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const rootDir = new URL('../src/', import.meta.url);
const ALLOWED_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.css']);

const rules = [
  {
    id: 'fixed-large-height',
    regex: /min-h-\[(?:[6-9]\d{2}|1\d{3,})px\]/g,
    message: 'Large fixed min-height can break mobile viewport. Prefer responsive variants (md:min-h-...) or fluid sizing.',
  },
  {
    id: 'fixed-large-width',
    regex: /w-\[(?:[5-9]\d{2}|1\d{3,})px\]/g,
    message: 'Large fixed width can overflow on mobile. Prefer max-w-full + breakpoint-specific width.',
  },
  {
    id: 'legacy-vh',
    regex: /\b100vh\b/g,
    message: 'Use 100dvh over 100vh for mobile browser UI bars.',
  },
];

function walk(dirUrl, out = []) {
  const dirPath = dirUrl.pathname;
  for (const name of readdirSync(dirPath)) {
    const abs = join(dirPath, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(new URL(`${name}/`, dirUrl), out);
      continue;
    }
    if (ALLOWED_EXT.has(extname(name))) out.push(abs);
  }
  return out;
}

function lineAt(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

function hasVariantPrefix(text, idx) {
  const start = Math.max(
    text.lastIndexOf(' ', idx),
    text.lastIndexOf('\n', idx),
    text.lastIndexOf('"', idx),
    text.lastIndexOf('`', idx),
    text.lastIndexOf("'", idx),
    text.lastIndexOf('{', idx),
    text.lastIndexOf('}', idx),
    text.lastIndexOf('(', idx),
    text.lastIndexOf(')', idx),
  ) + 1;
  const segment = text.slice(start, idx);
  return segment.includes(':');
}

const files = walk(rootDir);
const warnings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  for (const rule of rules) {
    const matches = [...text.matchAll(rule.regex)];
    for (const match of matches) {
      const idx = match.index ?? 0;
      if ((rule.id === 'fixed-large-height' || rule.id === 'fixed-large-width') && hasVariantPrefix(text, idx)) {
        continue;
      }
      if (rule.id === 'legacy-vh') {
        const nearby = text.slice(Math.max(0, idx - 80), idx + 140);
        if (nearby.includes('100dvh')) continue;
      }

      warnings.push({
        file: relative(process.cwd(), file),
        line: lineAt(text, idx),
        token: match[0],
        message: rule.message,
      });
    }
  }
}

if (warnings.length === 0) {
  console.log('mobile-check: OK');
  process.exit(0);
}

console.error(`mobile-check: found ${warnings.length} potential mobile issues`);
for (const item of warnings) {
  console.error(`- ${item.file}:${item.line} \`${item.token}\` -> ${item.message}`);
}
process.exit(1);
