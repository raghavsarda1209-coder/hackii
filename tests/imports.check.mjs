// Static check: every named import must actually be exported by the target module.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.js') || n.endsWith('.mjs')) files.push(p);
  }
})(ROOT);

function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    m[1].split(',').forEach((part) => {
      const bits = part.split(/\s+as\s+/).map((s) => s.trim());
      names.add((bits[1] || bits[0]).trim());
    });
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  return names;
}

const cache = new Map();
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // CDN import
    const target = resolve(dirname(f), spec);
    if (!cache.has(target)) cache.set(target, exportsOf(target));
    const avail = cache.get(target);
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!avail.has(name)) {
        bad++;
        console.log(`MISSING  ${relative(ROOT, f)}\n    imports "${name}" from ${spec}  -> not exported`);
      }
    }
  }
}
console.log(bad ? `\n${bad} broken import(s)` : `\nAll imports resolve (${files.length} files checked)`);
process.exit(bad ? 1 : 0);
