/**
 * Rent roll parser eval runner. See eval/SPEC.md.
 *
 * Usage:
 *   npx tsx eval/run-eval.ts                 # run all files with ground truth
 *   npx tsx eval/run-eval.ts 02 07 11        # run only corpus ids with these prefixes
 *   npx tsx eval/run-eval.ts --cached        # rescore cached parse outputs (no API calls)
 *   npx tsx eval/run-eval.ts --fresh         # ignore cache, re-parse everything
 *   npx tsx eval/run-eval.ts --concurrency 4
 *
 * Parse outputs are cached in eval/runs/latest/<id>.json. Score report written to
 * eval/runs/latest/REPORT.md and REPORT.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

import { parseRentRoll } from '../src/lib/parsers';
import { scoreFile, type GroundTruth, type FileScore } from './score';
import type { GenericRentRollUnit } from '../src/lib/types';

const CORPUS_DIR = path.join(__dirname, 'corpus');
const GT_DIR = path.join(__dirname, 'groundtruth');
const RUN_DIR = process.env.EVAL_RUN_DIR
  ? path.resolve(process.env.EVAL_RUN_DIR)
  : path.join(__dirname, 'runs', 'latest');

interface CachedParse {
  corpusId: string;
  units: GenericRentRollUnit[];
  statedUnitCount: number | null;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  processingTimeMs: number;
  error?: string;
}

async function parseWithCache(corpusId: string, fresh: boolean): Promise<CachedParse> {
  const cachePath = path.join(RUN_DIR, corpusId + '.json');
  if (!fresh && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  const buffer = fs.readFileSync(path.join(CORPUS_DIR, corpusId));
  // Original filename determines parser path (extension); corpus id preserves it.
  const start = Date.now();
  let result: CachedParse;
  try {
    const parsed = await parseRentRoll(buffer, corpusId);
    result = {
      corpusId,
      units: parsed.units,
      statedUnitCount: parsed.statedUnitCount,
      modelUsed: parsed.modelUsed,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      processingTimeMs: Date.now() - start,
    };
  } catch (e) {
    result = {
      corpusId,
      units: [],
      statedUnitCount: null,
      modelUsed: '—',
      inputTokens: 0,
      outputTokens: 0,
      processingTimeMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const cachedOnly = args.includes('--cached');
  const fresh = args.includes('--fresh');
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx !== -1 ? parseInt(args[concIdx + 1], 10) : 4;
  const setIdx = args.indexOf('--set');
  let prefixes = args.filter((a, i) => !a.startsWith('--') && i !== concIdx + 1 && i !== setIdx + 1);
  if (setIdx !== -1) {
    const sets = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-sets.json'), 'utf-8'));
    const set = sets[args[setIdx + 1]];
    if (!set) { console.error(`Unknown eval set: ${args[setIdx + 1]}`); process.exit(1); }
    prefixes = [...prefixes, ...set];
  }

  const gtFiles = fs.readdirSync(GT_DIR).filter(f => f.endsWith('.json')).sort();
  let targets = gtFiles.map(f => f.replace(/\.json$/, ''));
  if (prefixes.length > 0) {
    targets = targets.filter(t => prefixes.some(p => t.startsWith(p)));
  }
  // Only score files that exist in corpus
  targets = targets.filter(t => fs.existsSync(path.join(CORPUS_DIR, t)));

  console.log(`Evaluating ${targets.length} files (concurrency ${concurrency}${cachedOnly ? ', cached only' : ''})\n`);

  const scores: FileScore[] = [];
  const parses: CachedParse[] = [];

  // simple concurrency pool
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const my = targets[idx++];
      const gt: GroundTruth = JSON.parse(fs.readFileSync(path.join(GT_DIR, my + '.json'), 'utf-8'));
      let parse: CachedParse;
      if (cachedOnly) {
        const cachePath = path.join(RUN_DIR, my + '.json');
        if (!fs.existsSync(cachePath)) { console.log(`SKIP (no cache): ${my}`); continue; }
        parse = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      } else {
        parse = await parseWithCache(my, fresh);
      }
      const score = scoreFile(gt, parse.units);
      scores.push(score);
      parses.push(parse);
      const pct = (score.accuracy * 100).toFixed(1);
      const flag = score.accuracy >= 0.95 ? '  ' : '✗ ';
      console.log(`${flag}${pct.padStart(5)}%  ${my}  (gt:${score.gtUnits} ex:${score.extractedUnits} match:${score.matchedUnits} miss:${score.missedUnits.length} hall:${score.hallucinatedUnits.length})${parse.error ? '  ERROR: ' + parse.error : ''}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  scores.sort((a, b) => a.corpusId.localeCompare(b.corpusId));

  const macro = scores.reduce((s, x) => s + x.accuracy, 0) / scores.length;
  const totalCells = scores.reduce((s, x) => s + x.totalCells, 0);
  const correctCells = scores.reduce((s, x) => s + x.correctCells, 0);
  const micro = correctCells / totalCells;

  // Aggregate field breakdown
  const agg: Record<string, { correct: number; total: number }> = {};
  for (const s of scores) {
    for (const [f, v] of Object.entries(s.fieldBreakdown)) {
      agg[f] = agg[f] || { correct: 0, total: 0 };
      agg[f].correct += v.correct;
      agg[f].total += v.total;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`MACRO accuracy (avg of file scores): ${(macro * 100).toFixed(2)}%  ${macro >= 0.95 ? '✅ >=95%' : '❌ <95%'}`);
  console.log(`MICRO accuracy (all cells):          ${(micro * 100).toFixed(2)}%`);
  console.log(`Files >=95%: ${scores.filter(s => s.accuracy >= 0.95).length}/${scores.length}`);
  console.log('\nField breakdown:');
  for (const [f, v] of Object.entries(agg)) {
    if (v.total === 0) continue;
    console.log(`  ${f.padEnd(15)} ${((v.correct / v.total) * 100).toFixed(1).padStart(6)}%  (${v.correct}/${v.total})`);
  }

  const totalTokens = parses.reduce((s, p) => s + p.inputTokens + p.outputTokens, 0);
  console.log(`\nTokens this run: ${totalTokens.toLocaleString()}`);

  // Write report
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const report = { timestamp: new Date().toISOString(), macro, micro, agg, scores };
  fs.writeFileSync(path.join(RUN_DIR, 'REPORT.json'), JSON.stringify(report, null, 2));

  const lines: string[] = [
    `# Eval Report`, '',
    `Macro: ${(macro * 100).toFixed(2)}% | Micro: ${(micro * 100).toFixed(2)}% | Files >=95%: ${scores.filter(s => s.accuracy >= 0.95).length}/${scores.length}`, '',
    `| File | Acc | GT | Ext | Miss | Hall | Worst fields |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const s of scores) {
    const worst = Object.entries(s.fieldBreakdown)
      .filter(([, v]) => v.total > 0 && v.correct < v.total)
      .sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total))
      .slice(0, 3)
      .map(([f, v]) => `${f} ${v.correct}/${v.total}`)
      .join(', ');
    lines.push(`| ${s.corpusId} | ${(s.accuracy * 100).toFixed(1)}% | ${s.gtUnits} | ${s.extractedUnits} | ${s.missedUnits.length} | ${s.hallucinatedUnits.length} | ${worst} |`);
  }
  fs.writeFileSync(path.join(RUN_DIR, 'REPORT.md'), lines.join('\n'));
  console.log(`\nReport: eval/runs/latest/REPORT.md`);
}

main().catch(e => { console.error(e); process.exit(1); });
