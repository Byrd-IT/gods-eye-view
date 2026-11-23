import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parsers } from 'prettier/plugins/babel.mjs';
import { createBrowserViteConfig } from '../../build/vite.js';

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(file);
    else if (/\.(?:js|mjs|vue)$/.test(file) && !/\.test\./.test(file))
      yield file;
  }
}

test('literal dynamic bare package imports are pre-bundled', async () => {
  const includes = createBrowserViteConfig().optimizeDeps.include;
  const missing = [];
  for await (const file of sources('src')) {
    const text = await readFile(file, 'utf8');
    const scripts = file.endsWith('.vue')
      ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(
          (match) => match[1],
        )
      : [text];
    for (const script of scripts) {
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (
          node.type === 'ImportExpression' &&
          node.source?.type === 'StringLiteral'
        ) {
          const name = node.source.value;
          if (
            !/^(?:\.|\/|#|node:|https?:)/.test(name) &&
            !/\.css(?:\?|$)/.test(name) &&
            !includes.includes(name)
          )
            missing.push(`${file}: ${name}`);
        }
        for (const [key, value] of Object.entries(node)) {
          if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
          if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === 'object') walk(value);
        }
      }
      walk(parsers.babel.parse(script));
    }
  }
  assert.deepEqual(missing, []);
});
