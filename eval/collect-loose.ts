/**
 * Add a loose folder of rent roll files to the eval corpus, deduped by content
 * hash against everything already in the manifest. New ids continue after the
 * highest existing id.
 *
 * Usage: npx tsx eval/collect-loose.ts "/path/to/folder"
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const CORPUS_DIR = path.join(__dirname, 'corpus');
const MANIFEST_PATH = path.join(__dirname, 'corpus-manifest.json');

interface ManifestEntry {
  id: string;
  originalFilename: string;
  project: string;
  sha256: string;
  note: string | null;
  excluded?: string;
}

function main() {
  const srcDir = process.argv[2];
  if (!srcDir || !fs.existsSync(srcDir)) {
    console.error('Usage: npx tsx eval/collect-loose.ts <folder>');
    process.exit(1);
  }

  const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const seenHashes = new Map<string, string>();
  for (const m of manifest) {
    if (m.id) seenHashes.set(m.sha256, m.id);
  }
  let nextId = Math.max(
    ...manifest.filter(m => m.id).map(m => parseInt(m.id.split('__')[0], 10))
  ) + 1;

  const files = fs.readdirSync(srcDir)
    .filter(f => /\.(pdf|xlsx|xls|xlsm)$/i.test(f) && !f.startsWith('~$'))
    .sort();

  for (const f of files) {
    const buffer = fs.readFileSync(path.join(srcDir, f));
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    if (seenHashes.has(hash)) {
      console.log(`DUP (of ${seenHashes.get(hash)}): ${f}`);
      manifest.push({ id: '', originalFilename: f, project: srcDir, sha256: hash, note: null, excluded: `duplicate of ${seenHashes.get(hash)}` });
      continue;
    }
    const base = f.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const id = `${String(nextId).padStart(2, '0')}__${base}`;
    nextId++;
    seenHashes.set(hash, id);
    fs.copyFileSync(path.join(srcDir, f), path.join(CORPUS_DIR, id));
    manifest.push({ id, originalFilename: f, project: srcDir, sha256: hash, note: null });
    console.log(`ADDED: ${id}`);
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest now has ${manifest.filter(m => m.id).length} included files`);
}

main();
