// Build the GitHub Pages site into _site/: the web app at the site root, plus the
// browser-safe server modules it imports in browser mode (standalone.js).
//   node scripts/build-pages.mjs [outDir]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.argv[2] || '_site');
// Node-only or not needed in the browser.
const SKIP = [/\.test\.js$/, /\/fixtures(\/|$)/, /fixtures\.json$/, /LIVE_CHECK\.txt$/, /^server\/index\.js$/, /^server\/store\.js$/, /^server\/agent\/claude\.js$/];

const fail = (msg) => { console.error(`build-pages: ${msg}`); process.exit(1); };
const rel = (p) => relative(ROOT, p).split('\\').join('/');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
cpSync(join(ROOT, 'server'), join(OUT, 'server'), {
  recursive: true,
  filter: (src) => !SKIP.some((re) => re.test(rel(src))),
});

// standalone.js loads ../server/ from public/; on the site they sit side by side.
const standalonePath = join(OUT, 'standalone.js');
const standalone = readFileSync(standalonePath, 'utf8');
const rewritten = standalone.replace("const SERVER_BASE = '../server/';", "const SERVER_BASE = './server/';");
if (rewritten === standalone) fail('SERVER_BASE line not found in public/standalone.js');
writeFileSync(standalonePath, rewritten);

// Cache-bust the entry assets so a deploy isn't mixed with a stale cached copy.
let version = process.env.GITHUB_SHA?.slice(0, 7);
if (!version) { try { version = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { version = String(Date.now()); } }
const indexPath = join(OUT, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace(/(src|href)="(app\.js|standalone\.js|styles\.css)"/g, `$1="$2?v=${version}"`));
writeFileSync(join(OUT, '.nojekyll'), '');

// Every relative import in the shipped modules must resolve to a shipped file, and
// nothing reachable from standalone.js may statically import a Node built-in.
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const ENTRY_MODULES = [...standalone.matchAll(/mod\('([^']+)'\)/g)].map((m) => join(OUT, 'server', m[1]));
for (const json of ['ml/forecaster.json', 'ml/model.json']) if (!existsSync(join(OUT, 'server', json))) fail(`missing server/${json}`);
const seen = new Set();
const visit = (file, from) => {
  if (seen.has(file)) return;
  seen.add(file);
  if (!existsSync(file)) fail(`${rel(from)} imports ${relative(OUT, file)}, which is not in the build`);
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('.')) visit(resolve(dirname(file), spec), file);
    else fail(`${relative(OUT, file)} statically imports "${spec}", which browsers can't load`);
  }
};
if (!ENTRY_MODULES.length) fail('no mod(...) entry modules found in standalone.js');
for (const f of ENTRY_MODULES) visit(f, standalonePath);

const count = (dir) => readdirSync(dir).reduce((n, f) => n + (statSync(join(dir, f)).isDirectory() ? count(join(dir, f)) : 1), 0);
console.log(`build-pages: ${count(OUT)} files → ${rel(OUT) || OUT} (v=${version}, ${seen.size} browser modules checked)`);
