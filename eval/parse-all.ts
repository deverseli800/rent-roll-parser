/**
 * Parse every corpus file with the current parser and cache results in
 * eval/runs/latest/<id>.json (same cache format run-eval.ts uses).
 *
 * Usage: npx tsx eval/parse-all.ts [--fresh] [--concurrency N] [prefix ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

import { parseRentRoll } from '../src/lib/parsers';

const CORPUS_DIR = path.join(__dirname, 'corpus');
const RUN_DIR = path.join(__dirname, 'runs', 'latest');

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 3;
  const prefixes = args.filter((a, i) => !a.startsWith('--') && (concIdx === -1 || i !== concIdx + 1));

  fs.mkdirSync(RUN_DIR, { recursive: true });
  let targets = fs.readdirSync(CORPUS_DIR).sort();
  if (prefixes.length > 0) targets = targets.filter(t => prefixes.some(p => t.startsWith(p)));

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const id = targets[idx++];
      const cachePath = path.join(RUN_DIR, id + '.json');
      if (!fresh && fs.existsSync(cachePath)) { console.log(`cached: ${id}`); continue; }
      const start = Date.now();
      try {
        const parsed = await parseRentRoll(fs.readFileSync(path.join(CORPUS_DIR, id)), id);
        fs.writeFileSync(cachePath, JSON.stringify({
          corpusId: id,
          units: parsed.units,
          statedUnitCount: parsed.statedUnitCount,
          sourceFormat: parsed.sourceFormat,
          modelUsed: parsed.modelUsed,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          processingTimeMs: Date.now() - start,
        }, null, 2));
        console.log(`ok (${((Date.now() - start) / 1000).toFixed(1)}s, ${parsed.units.length} units): ${id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        fs.writeFileSync(cachePath, JSON.stringify({
          corpusId: id, units: [], statedUnitCount: null, modelUsed: '—',
          inputTokens: 0, outputTokens: 0, processingTimeMs: Date.now() - start, error: msg,
        }, null, 2));
        console.log(`ERROR: ${id}: ${msg.slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log('DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
