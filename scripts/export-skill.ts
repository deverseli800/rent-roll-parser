/**
 * Package the rent-roll parser + its Claude skill into a self-contained bundle
 * that can be added to Claude Desktop / Claude Cowork (or run standalone on any
 * machine with Node).
 *
 * What it does:
 *  1. Starts from the CLI entry point (scripts/parse-rent-roll.ts) and walks the
 *     transitive closure of its LOCAL (relative) imports — so only the source
 *     files the pipeline actually needs get bundled, nothing from the web app.
 *  2. Collects the external npm packages those files import and pins each to the
 *     version this repo uses, producing a minimal package.json.
 *  3. Rewrites SKILL.md so it has no machine-specific absolute paths and carries
 *     setup instructions (npm install + ANTHROPIC_API_KEY) for a fresh sandbox.
 *  4. Emits a ready-to-run bundle directory and a .zip alongside it.
 *
 * Usage:
 *   npx tsx scripts/export-skill.ts
 *
 * Output:
 *   dist/skill/parse-rent-roll/        <- the bundle (SKILL.md at its root)
 *   dist/parse-rent-roll-skill.zip     <- zipped bundle (contains parse-rent-roll/)
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'parse-rent-roll.ts');
const SKILL_NAME = 'parse-rent-roll';
const SKILL_SRC = path.join(ROOT, '.claude', 'skills', SKILL_NAME, 'SKILL.md');

// `--with-key` embeds the repo's .env.local into the bundle so the key travels
// with the skill (for sandboxes with no secrets UI). Produces a *private* zip.
const WITH_KEY = process.argv.slice(2).includes('--with-key');
const REPO_ENV = path.join(ROOT, '.env.local');

const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'skill');
const BUNDLE = path.join(STAGE, SKILL_NAME);
const ZIP = path.join(DIST, `${SKILL_NAME}-skill${WITH_KEY ? '-private' : ''}.zip`);

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

/** Pull every module specifier out of a source file (import/export/require/import()). */
function specifiersOf(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g, // import/export ... from '...'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,             // dynamic + type import('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,            // require('...')
    /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g,           // bare side-effect import '...'
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Resolve a relative specifier to an on-disk .ts/.tsx file, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Bare specifier -> package name (@scope/name or name). */
function packageName(spec: string): string {
  const clean = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (NODE_BUILTINS.has(clean)) return '';
  const parts = clean.split('/');
  return clean.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

// ---- 1. Walk the import closure from the entry point ----------------------
const localFiles = new Set<string>();
const externals = new Set<string>();
const queue = [ENTRY];

while (queue.length) {
  const file = queue.pop()!;
  if (localFiles.has(file)) continue;
  localFiles.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const spec of specifiersOf(src)) {
    if (spec.startsWith('.')) {
      const resolved = resolveLocal(file, spec);
      if (resolved) queue.push(resolved);
      else console.warn(`  ! unresolved relative import "${spec}" in ${path.relative(ROOT, file)}`);
    } else {
      const pkg = packageName(spec);
      if (pkg) externals.add(pkg);
    }
  }
}

// ---- 2. Resolve external versions from the repo's package.json -------------
const repoPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const allRepoDeps: Record<string, string> = { ...repoPkg.dependencies, ...repoPkg.devDependencies };
const deps: Record<string, string> = {};
for (const pkg of [...externals].sort()) {
  deps[pkg] = allRepoDeps[pkg] ?? 'latest';
  if (!allRepoDeps[pkg]) console.warn(`  ! "${pkg}" not found in repo package.json — pinned to "latest"`);
}

// ---- 3. Stage the bundle --------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(BUNDLE, { recursive: true });

for (const file of localFiles) {
  const rel = path.relative(ROOT, file); // e.g. scripts/parse-rent-roll.ts, src/lib/...
  const dest = path.join(BUNDLE, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

// run.ts is the launcher (adds corporate-proxy CA trust, then spawns the entry).
// It reaches the entry via a runtime spawn, not an import, so the closure walk
// above doesn't see it — copy it explicitly.
fs.copyFileSync(path.join(ROOT, 'scripts', 'run.ts'), path.join(BUNDLE, 'scripts', 'run.ts'));

// package.json — runtime deps + tsx to execute the TS entry
const bundlePkg = {
  name: `${SKILL_NAME}-skill`,
  version: repoPkg.version ?? '0.1.0',
  private: true,
  description: 'Standalone rent-roll extraction pipeline packaged as a Claude skill.',
  scripts: {
    parse: 'tsx scripts/run.ts',
  },
  dependencies: deps,
  devDependencies: {
    tsx: '^4.19.2',
    typescript: allRepoDeps.typescript ?? '^5',
    '@types/node': allRepoDeps['@types/node'] ?? '^20',
  },
};
fs.writeFileSync(path.join(BUNDLE, 'package.json'), JSON.stringify(bundlePkg, null, 2) + '\n');

// tsconfig so tsx/editors resolve the CommonJS + __dirname entry cleanly
const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
  },
  include: ['scripts/**/*.ts', 'src/**/*.ts'],
};
fs.writeFileSync(path.join(BUNDLE, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

fs.writeFileSync(
  path.join(BUNDLE, '.env.local.example'),
  '# Copy to .env.local, or set ANTHROPIC_API_KEY in the environment instead.\nANTHROPIC_API_KEY=sk-ant-...\n'
);

fs.writeFileSync(
  path.join(BUNDLE, '.gitignore'),
  'node_modules/\n.env.local\n*.extraction.json\n'
);

// SKILL.md — portable rewrite of the repo skill
const description = (() => {
  const m = fs.existsSync(SKILL_SRC) ? fs.readFileSync(SKILL_SRC, 'utf8').match(/description:\s*(.+)/) : null;
  return m ? m[1].trim() : 'Extract structured unit data from a multifamily rent roll (Excel or PDF).';
})();

const skillMd = `---
name: ${SKILL_NAME}
description: ${description}
---

# Parse a rent roll

Run the full extraction pipeline (AI parse with model escalation ladder →
summary stats → validation → verification checks → mismatch explanations) on a
rent roll file and report the results. This bundle is self-contained — it does
not depend on the rent-roll-parser web app.

## Requires an ANTHROPIC_API_KEY — do not work around it

This skill only works with a valid \`ANTHROPIC_API_KEY\`; it calls the Anthropic
API to extract and verify the data. Before running, confirm a key is available
(an env var, or a \`.env.local\` file in this directory).

**If no key is available, STOP and ask the user to provide one. Do NOT read the
spreadsheet or PDF yourself as a substitute.** A manual/structural read of the
file bypasses the AI extraction, the model-escalation ladder, and the
verification checks that are the entire point of this skill — it silently
degrades accuracy on non-trivial Excel files and cannot handle PDFs or scans at
all. Report the missing key plainly and wait for it rather than producing an
unverified hand-parsed result.

## Setup (first run only)

From this skill's directory:

\`\`\`bash
npm install
\`\`\`

If the key is not already in the environment, copy \`.env.local.example\` to
\`.env.local\` and fill in \`ANTHROPIC_API_KEY\` (a \`.env.local\` may already be
present if this bundle was exported with the key embedded).

## Running it

From this skill's directory:

\`\`\`bash
npm run parse -- <path-to-file> [--out <path>] [--json]
# or:  npx tsx scripts/run.ts <path-to-file>
\`\`\`

Always run it through \`npm run parse\` / \`scripts/run.ts\` (not
\`scripts/parse-rent-roll.ts\` directly): the launcher makes the pipeline work
behind a corporate TLS-intercepting proxy by trusting the proxy's CA before the
API call. It is a no-op where there is no such proxy.

- Accepts \`.xlsx\`, \`.xls\`, \`.xlsm\`, and \`.pdf\` (vision extraction — scanned
  PDFs work).
- **Corporate proxy / TLS errors:** the launcher auto-detects a proxy CA at
  \`/usr/local/share/ca-certificates/mitm-proxy-ca.crt\` (and the system CA
  bundle). If you still hit a certificate error (\`self-signed certificate\`,
  \`unable to get local issuer certificate\`), set \`NODE_EXTRA_CA_CERTS\` to your
  proxy's CA \`.crt\` path and re-run — do not disable TLS verification.
- **Timing:** small documents finish in under a minute; large documents take
  5–25 minutes. Run it in the background and monitor rather than blocking on it.
  Progress streams to stderr, including "N units extracted so far" heartbeats —
  if those are advancing, it is not stuck. The model ladder
  (Sonnet 5 → Opus 4.8 → Fable 5) may legitimately restart extraction on a
  bigger model when self-verification fails.
- **Early summary — relay it immediately.** Within ~20 seconds, stderr prints a
  line starting with "Document summary —" giving the totals the document states
  about itself (unit count, occupancy, monthly rent). On documents that will
  take minutes, tell the user those stated totals as soon as the line appears
  instead of staying silent until the full extraction finishes — note they are
  the document's own claims, which the per-unit extraction then verifies.
- Full structured output is written to \`<file>.extraction.json\` next to the
  input (or \`--out <path>\`); a markdown summary prints to stdout. Use \`--json\`
  to dump the full JSON to stdout instead.

## Reporting results

Relay the stdout summary: property name, unit count (vs the document's stated
count), status breakdown, occupancy, total rent, and the verification verdict
(N/M checks passed, confidence level).

- If verification checks failed, the summary includes an AI explanation and
  root cause per check. \`category_mismatch\` root causes are definitional
  differences (e.g. the document counts applicant units as vacant), not
  extraction errors — say so plainly rather than presenting them as problems.
- If the user wants the actual unit data, read it from the \`units\` array in
  the \`.extraction.json\` file (fields: unitNumber, status, monthlyRent,
  tenantName, unitSqft, unitType, lease/move dates).
- On failure (non-zero exit), report the stderr error; the most common causes
  are a missing/invalid \`ANTHROPIC_API_KEY\` and unsupported file types. If it is
  the key, ask the user for it — do not fall back to reading the file by hand.
`;
fs.writeFileSync(path.join(BUNDLE, 'SKILL.md'), skillMd);

// Human-facing install note for Claude Desktop / Cowork
const readme = `# ${SKILL_NAME} — Claude skill bundle

Self-contained rent-roll extraction pipeline, packaged as a Claude skill.

## Add to Claude Desktop / Claude Cowork

1. Unzip \`${SKILL_NAME}-skill.zip\` (this folder).
2. In Claude Desktop/Cowork, add it as a skill (Settings → Capabilities →
   Skills, or drag the folder / upload the zip depending on your build). The
   skill root is the folder containing \`SKILL.md\`.
3. Provide an \`ANTHROPIC_API_KEY\` — export it in the environment or copy
   \`.env.local.example\` to \`.env.local\` and fill it in.
4. On first run the skill runs \`npm install\` to fetch its dependencies.

## Run standalone (no Claude)

\`\`\`bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run parse -- /path/to/rent-roll.xlsx
\`\`\`

Regenerate this bundle from the source repo with:
\`npx tsx scripts/export-skill.ts\`
`;
fs.writeFileSync(path.join(BUNDLE, 'README.md'), readme);

// ---- 4. Embed the key (opt-in) -------------------------------------------
let embeddedKey = false;
if (WITH_KEY) {
  if (!fs.existsSync(REPO_ENV)) {
    console.error(`--with-key: no .env.local found at ${path.relative(ROOT, REPO_ENV)} — nothing to embed.`);
    process.exit(1);
  }
  fs.copyFileSync(REPO_ENV, path.join(BUNDLE, '.env.local'));
  embeddedKey = true;
}

// ---- 5. Zip --------------------------------------------------------------
fs.rmSync(ZIP, { force: true });
execSync(`zip -r -q "${ZIP}" "${SKILL_NAME}"`, { cwd: STAGE });

// ---- 6. Report -----------------------------------------------------------
const fileCount = [...localFiles].length;
const zipKB = Math.round(fs.statSync(ZIP).size / 1024);
console.log(`\nSkill bundle created:`);
console.log(`  ${path.relative(ROOT, BUNDLE)}/`);
console.log(`  ${path.relative(ROOT, ZIP)}  (${zipKB}KB)`);
console.log(`\nBundled ${fileCount} source file(s).`);
console.log(`Runtime deps: ${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(', ')}`);
if (embeddedKey) {
  console.log(`\n⚠  This bundle has your ANTHROPIC_API_KEY embedded in .env.local.`);
  console.log(`   Treat the -private.zip as a secret: do not share it or commit it.`);
} else {
  console.log(`\nNo key embedded. Set ANTHROPIC_API_KEY in the sandbox, or re-run`);
  console.log(`with --with-key to embed the repo's .env.local into a private bundle.`);
}
