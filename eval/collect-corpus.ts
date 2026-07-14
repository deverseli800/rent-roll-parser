/**
 * Collect rent-roll classified files from the appraisal source repo appraisal projects
 * into eval/corpus/, deduped by content hash. Excludes DHCR docs and blank templates.
 *
 * Usage: npx tsx eval/collect-corpus.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const APPRAISALS_DIR = './data/source-documents';
const CORPUS_DIR = path.join(__dirname, 'corpus');
const MANIFEST_PATH = path.join(__dirname, 'corpus-manifest.json');

interface DocEntry {
  filename: string;
  types: string[];
  note?: string;
}

interface ManifestEntry {
  id: string;            // corpus filename
  originalFilename: string;
  project: string;
  sha256: string;
  note: string | null;
  excluded?: string;     // reason if excluded
}

function isDHCR(filename: string, note: string | null): boolean {
  const s = `${filename} ${note ?? ''}`.toLowerCase();
  return s.includes('dhcr') || s.includes('registration rent roll');
}

function isBlankTemplate(note: string | null): boolean {
  const s = (note ?? '').toLowerCase();
  return s.includes('blank') && s.includes('template');
}

function main() {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const seenHashes = new Map<string, string>(); // hash -> corpus id
  const manifest: ManifestEntry[] = [];

  const projects = fs.readdirSync(APPRAISALS_DIR).filter(p =>
    fs.statSync(path.join(APPRAISALS_DIR, p)).isDirectory() && p !== 'tmp'
  );

  for (const project of projects) {
    const projectDir = path.join(APPRAISALS_DIR, project);
    let idxPath = path.join(projectDir, 'document-index.json');
    if (!fs.existsSync(idxPath)) {
      idxPath = path.join(projectDir, 'due-diligence', 'document-index.json');
    }
    if (!fs.existsSync(idxPath)) continue;

    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    const docs: DocEntry[] = idx.documents ?? [];

    for (const doc of docs) {
      if (!doc.types.includes('rent-roll')) continue;
      const note = doc.note ?? null;
      const ext = path.extname(doc.filename).toLowerCase();
      if (!['.pdf', '.xlsx', '.xls', '.xlsm'].includes(ext)) continue;

      const srcPath = path.join(projectDir, 'due-diligence', doc.filename);
      if (!fs.existsSync(srcPath)) {
        console.log(`  MISSING: ${project}/${doc.filename}`);
        continue;
      }

      const buffer = fs.readFileSync(srcPath);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      let excluded: string | undefined;
      if (isDHCR(doc.filename, note)) excluded = 'DHCR document (per instructions)';
      else if (isBlankTemplate(note)) excluded = 'blank template';
      else if (seenHashes.has(hash)) excluded = `duplicate of ${seenHashes.get(hash)}`;

      let id = '';
      if (!excluded) {
        // Build a stable, filesystem-friendly corpus id
        const base = doc.filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
        id = `${manifest.filter(m => !m.excluded).length.toString().padStart(2, '0')}__${base}`;
        seenHashes.set(hash, id);
        fs.copyFileSync(srcPath, path.join(CORPUS_DIR, id));
      }

      manifest.push({
        id,
        originalFilename: doc.filename,
        project,
        sha256: hash.slice(0, 16),
        note,
        ...(excluded ? { excluded } : {}),
      });
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const included = manifest.filter(m => !m.excluded);
  console.log(`\nIncluded: ${included.length} files`);
  for (const m of included) console.log(`  ${m.id}  [${m.project}]`);
  console.log(`\nExcluded: ${manifest.length - included.length}`);
  for (const m of manifest.filter(x => x.excluded)) {
    console.log(`  ${m.originalFilename} [${m.project}]: ${m.excluded}`);
  }
}

main();
