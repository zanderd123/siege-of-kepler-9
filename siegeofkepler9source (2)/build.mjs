/**
 * Builds a single self-contained HTML file containing the whole game —
 * markup, styles, three.js and all game code inlined.
 *
 * The output has no imports and no external requests, so it runs by
 * double-clicking it (file://) as well as from a web server, and can be
 * emailed or dropped on any static host as one file.
 *
 *   node build.mjs   ->  dist/siege-of-kepler-9.html
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const tmp = join(root, '.build-bundle.js');

// IIFE, not ESM: inline module scripts still count as modules, and we want the
// file to work straight off the filesystem without a server.
execFileSync('npx', [
  '--yes', 'esbuild@0.24.0', 'src/main.js',
  '--bundle', '--format=iife', '--minify',
  `--outfile=${tmp}`,
  '--alias:three=./vendor/three.module.js',
  '--log-level=warning',
], { cwd: root, stdio: 'inherit' });

const js = readFileSync(tmp, 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
rmSync(tmp, { force: true });

// Lift the page body out of index.html so the markup has a single source of
// truth — the standalone build must never drift from the served version.
const body = html.slice(
  html.indexOf('<body>') + '<body>'.length,
  html.lastIndexOf('</body>'),
)
  .replace(/<script type="module"[\s\S]*?<\/script>/g, '')
  .trim();

const out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Siege of Kepler-9 — Space Fleet Command</title>
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
const dest = join(root, 'dist', 'siege-of-kepler-9.html');
writeFileSync(dest, out);
console.log(`built ${dest} — ${(statSync(dest).size / 1024 / 1024).toFixed(2)} MB`);
