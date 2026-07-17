import * as XLSX from 'xlsx';
import type { GenericRentRollUnit, StatedSummaryStats } from '../types';
import { extractStructured, MODELS, sumUsage, type AIUsage } from './aiClient';
import { tryFastPath } from './excelFastPath';
import {
  EXTRACTION_RULES,
  extractStatedPreview,
  runExtractionLadder,
  toGenericRentRollUnits,
  toStatedSummaryStats,
  type ChunkingOptions,
  type ExtractionResult,
  type PreviewData,
  type ProgressReporter,
} from './extractionCore';
import type Anthropic from '@anthropic-ai/sdk';
import { estimateCostUSD } from '../utils/aiCost';

/**
 * Excel parser v2.
 *
 * Approach:
 * 1. Read ALL sheets (multi-property/proforma workbooks have one rent roll per
 *    building plus summary/lookup sheets).
 * 2. Triage which sheets contain unit-level rent data (heuristic; AI for
 *    ambiguous multi-sheet workbooks).
 * 3. Full AI extraction per sheet with structured outputs (Sonnet 5).
 * 4. Self-verify against totals stated in the sheet; escalate failed sheets to
 *    Opus 4.8 with feedback, keep the better attempt.
 */

const MAX_COLS = 80; // hard ceiling; actual width adapts to populated columns
const MAX_ROWS_PER_CALL = 6000;
// Sheets below this size skip the stated-summary preview pass: extraction is
// fast enough that early feedback adds little, and the grid may fall under the
// prompt-cache minimum (making the extra call cost 2x instead of ~1.35x).
const PREVIEW_MIN_ROWS = 150;

/** Find the last column that actually holds data (sheets often claim huge ranges). */
function lastPopulatedCol(sheet: XLSX.WorkSheet, range: XLSX.Range): number {
  let maxCol = range.s.c;
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.e.c; c > maxCol; c--) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
        maxCol = c;
        break;
      }
    }
  }
  return maxCol;
}

interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
  text: string;      // full grid text
  preview: string;   // first rows only, for triage
  sheet: XLSX.WorkSheet;
}

/** Serialize a sheet into a compact grid with row numbers. Excel dates become ISO strings. */
function sheetToGrid(sheet: XLSX.WorkSheet, maxRows?: number): { text: string; rows: number; cols: number } {
  const ref = sheet['!ref'];
  if (!ref) return { text: '', rows: 0, cols: 0 };
  const range = XLSX.utils.decode_range(ref);
  const endCol = Math.min(lastPopulatedCol(sheet, range), range.s.c + MAX_COLS - 1);
  const endRow = maxRows !== undefined
    ? Math.min(range.e.r, range.s.r + maxRows - 1)
    : range.e.r;

  const lines: string[] = [];
  for (let r = range.s.r; r <= endRow; r++) {
    const cells: string[] = [];
    let hasContent = false;
    for (let c = range.s.c; c <= endCol; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      let value = '';
      if (cell) {
        if (cell.t === 'n' && cell.v !== undefined && looksLikeExcelDate(cell)) {
          value = excelSerialToISO(cell.v as number) ?? String(cell.v);
        } else if (cell.v !== undefined && cell.v !== null) {
          value = String(cell.v).trim();
        }
      }
      if (value !== '') hasContent = true;
      cells.push(value);
    }
    if (hasContent) {
      // trim trailing empty cells
      let last = cells.length - 1;
      while (last >= 0 && cells[last] === '') last--;
      lines.push(`R${r + 1}: ${cells.slice(0, last + 1).join(' | ')}`);
    }
  }
  return {
    text: lines.join('\n'),
    rows: range.e.r - range.s.r + 1,
    cols: range.e.c - range.s.c + 1,
  };
}

function looksLikeExcelDate(cell: XLSX.CellObject): boolean {
  // Number formatted as date, or plausible serial range with date format
  const fmt = (cell as { z?: string }).z ?? '';
  if (typeof cell.v !== 'number') return false;
  if (/[dmy]/i.test(fmt) && !/\[|#|0\.0|%|\$/.test(fmt)) return true;
  return false;
}

function excelSerialToISO(serial: number): string | null {
  if (serial < 1000 || serial > 80000) return null;
  // UTC-based to avoid timezone off-by-one
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Heuristic: does this sheet plausibly contain a unit-level rent table? */
function sheetHeuristicScore(info: SheetInfo): number {
  if (info.rows < 3) return 0;
  const t = info.preview.toLowerCase();
  let score = 0;
  for (const kw of ['unit', 'apt', 'apartment', 'tenant', 'resident', 'lessee']) {
    if (t.includes(kw)) { score += 2; break; }
  }
  for (const kw of ['rent', 'charge', 'lease']) {
    if (t.includes(kw)) { score += 2; break; }
  }
  // currency-ish numbers
  const numMatches = info.text.match(/\b\d{3,5}(\.\d{2})?\b/g);
  if (numMatches && numMatches.length >= 5) score += 1;
  // obvious non-data sheets
  if (/^(dropdowns?|valuelists?|lookups?|_|common sic)/i.test(info.name)) score -= 5;
  if (/(demographic|market|costar|reis|axio|photo|map)/i.test(info.name)) score -= 5;
  return score;
}

const TRIAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['sheets'],
  properties: {
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'hasUnitLevelRentData'],
        properties: {
          name: { type: 'string' },
          hasUnitLevelRentData: { type: 'boolean' },
        },
      },
    },
  },
};

async function triageSheets(candidates: SheetInfo[]): Promise<{ selected: string[]; usage: AIUsage[] }> {
  if (candidates.length === 1) return { selected: [candidates[0].name], usage: [] };

  const previews = candidates
    .map(s => `=== SHEET "${s.name}" (${s.rows} rows) ===\n${s.preview}`)
    .join('\n\n');

  const prompt = `Below are previews (first rows) of the sheets in an Excel workbook related to a real-estate rent roll. Decide for EACH sheet whether it contains UNIT-LEVEL rent roll data: one row (or block) per individual apartment/commercial unit with rents/tenants.

Sheets that are summaries, pro-forma aggregates, lookup/dropdown lists, market data, report parameters, instructions, or reference tables do NOT count, even if they mention rent. A "summary" sheet aggregating buildings is NOT unit-level. A per-building sheet listing every unit IS. A small sheet that merely re-lists a few units from another sheet as updates/renewal notes (a change log) is NOT a rent roll.

If MULTIPLE sheets present the SAME property's units in different formats (a formatted view, a pivot/table view, a raw-data tab, or a manually "extracted"/normalized copy), mark ONLY the most authoritative and complete ONE as unit-level (prefer the original/source view over derived copies) and mark the others false. When choosing between duplicate views, prefer the sheet whose rows carry ACTUAL current rents — tenant-paid and/or subsidy amounts that vary by unit — over views showing only scheduled/market/zeroed rent figures. Different sheets covering DIFFERENT buildings/properties should all be marked true.

${previews}`;

  try {
    const { data, usage } = await extractStructured<{ sheets: { name: string; hasUnitLevelRentData: boolean }[] }>({
      model: MODELS.fast,
      content: [{ type: 'text', text: prompt }],
      schema: TRIAGE_SCHEMA,
      maxTokens: 16000, // adaptive thinking shares this budget; 2k starved it
    });
    const byName = new Map(data.sheets.map(s => [s.name, s.hasUnitLevelRentData]));
    const selected = candidates.filter(s => byName.get(s.name) === true).map(s => s.name);
    return { selected, usage: [usage] };
  } catch (e) {
    // Triage is an optimization — never let it kill the parse. Fall back to
    // extracting every heuristic candidate; downstream dedupe handles overlap.
    console.warn('[excelV2] sheet triage failed, extracting all candidates:', e instanceof Error ? e.message : e);
    return { selected: candidates.map(c => c.name), usage: [] };
  }
}

/** Detect which optional columns the sheet clearly provides, from header text */
function detectColumnHints(sheetText: string): string {
  const head = sheetText.slice(0, 8000).toLowerCase();
  const hints: string[] = [];
  if (/(lease\s*(start|from|begin)|lease\s*dates)/.test(head)) hints.push('leaseStartDate');
  if (/(lease\s*(end|to|exp)|expir)/.test(head)) hints.push('leaseEndDate');
  if (/move[\s-]*in/.test(head)) hints.push('moveInDate');
  if (/move[\s-]*out/.test(head)) hints.push('moveOutDate');
  if (/(sq\.?\s*ft|sqft|square\s*(feet|footage)|\bsf\b)/.test(head)) hints.push('unitSqft');
  if (/(unit\s*type|floor\s*plan|floorplan|bd\/ba|bed|type:)/.test(head)) hints.push('unitType');
  if (hints.length === 0) return '';
  return `\n\nCOLUMNS PRESENT IN THIS SHEET: the header region includes columns for ${hints.join(', ')}. Populate these fields for EVERY unit that shows a value — do not leave them null.`;
}

/** First/middle/last row sample for the structure mapper. */
function sampleGrid(fullText: string): string {
  const lines = fullText.split('\n');
  if (lines.length <= 130) return fullText;
  const first = lines.slice(0, 50);
  const midStart = Math.floor(lines.length / 2) - 8;
  const middle = lines.slice(midStart, midStart + 16);
  const last = lines.slice(-60);
  return [...first, '... (rows omitted) ...', ...middle, '... (rows omitted) ...', ...last].join('\n');
}

/** Summary-shaped sheets that triage rejected for unit extraction: small, and
 * carrying totals/occupancy language. "Details + Summary" report exports
 * (RealPage etc.) put the unit count and occupancy on these, not on the detail
 * sheet — they are the only place those stated anchors exist. */
function findSummarySheets(infos: SheetInfo[], selectedNames: string[]): SheetInfo[] {
  return infos.filter(i =>
    !selectedNames.includes(i.name) &&
    i.rows <= 80 &&
    /total|summar|occupan|#\s*units|unit\s*status|averages/i.test(i.text)
  );
}

/** One cheap stated-summary read over the workbook's summary sheets. */
async function harvestSummaryStated(
  summaries: SheetInfo[],
  usages: AIUsage[],
  report?: ProgressReporter
): Promise<PreviewData | null> {
  if (summaries.length === 0) return null;
  let text = summaries
    .map(s => `=== SUMMARY SHEET "${s.name}" ===\n${s.text}`)
    .join('\n\n');
  if (text.length > 24000) text = text.slice(0, 24000);
  report?.('extracting', 'reading workbook summary sheets', {
    kind: 'info',
    message: `Workbook has summary sheet${summaries.length === 1 ? '' : 's'} ${summaries.map(s => `"${s.name}"`).join(', ')} — reading stated totals (unit count, occupancy) from ${summaries.length === 1 ? 'it' : 'them'}`,
  });
  return extractStatedPreview(
    [{ type: 'text', text: `Below are the SUMMARY sheets of an Excel rent roll workbook (the unit detail lives on another sheet). Read the totals they state:\n\n${text}` }],
    usages,
    report,
    'summary sheets'
  );
}

async function extractSheet(
  info: SheetInfo,
  report?: ProgressReporter,
  external?: PreviewData | null
): Promise<{ result: ExtractionResult; usage: AIUsage[]; path: 'fast' | 'ai' }> {
  const usages: AIUsage[] = [];

  // Deterministic fast path: structure mapping + code walk, gated by
  // verification against the document's own stated totals.
  report?.('mapping', `sheet "${info.name}" — structure analysis`, {
    kind: 'info',
    message: `Analyzing the structure of sheet "${info.name}" (${info.rows} rows) for a deterministic fast-path read`,
  });
  const fast = await tryFastPath(info.sheet, sampleGrid(info.text), usages, external);
  if (fast) {
    report?.('extracting', `sheet "${info.name}" — fast path`, {
      kind: 'fastpath',
      message: `Fast path succeeded on "${info.name}" — ${fast.units.length} units read deterministically and verified against stated totals (no AI extraction needed)`,
    });
    return { result: fast, usage: usages, path: 'fast' };
  }
  report?.('extracting', `sheet "${info.name}" — full AI extraction`, {
    kind: 'fastpath',
    message: `Fast path not viable for "${info.name}" (layout unsupported or totals didn't reconcile) — using the AI model ladder`,
  });

  // The sheet grid leads and is cache-marked: the stated-summary preview call
  // writes it into the prompt cache; the full extraction (and same-model
  // retries with feedback) read it at ~0.1x input price.
  const docBlocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text: `Below is the full content of Excel sheet "${info.name}" from a rent roll workbook (cells separated by " | ", rows prefixed with their row number):\n\n${info.text}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  const instructions = `${EXTRACTION_RULES}${detectColumnHints(info.text)}`;
  const makeContent = (feedback?: string): Anthropic.ContentBlockParam[] => [
    ...docBlocks,
    { type: 'text', text: feedback ? `${instructions}\n\n${feedback}` : instructions },
  ];

  // Quick stated-summary read before the (slow) full extraction, so the UI has
  // the document's own totals within seconds. Skipped for small sheets, which
  // extract quickly anyway and sit below the prompt-cache minimum.
  let preview = external ?? null;
  if (info.rows >= PREVIEW_MIN_ROWS) {
    // Harvested summary-sheet totals ride along as the fallback: the sheet's
    // own stated values win, summary-sheet values fill the gaps (unit count
    // and occupancy usually only exist there on Details+Summary exports).
    preview = await extractStatedPreview(docBlocks, usages, report, `sheet "${info.name}"`, external);
  }

  // Chunked fallback for sheets whose units don't fit in one 128K response:
  // the ladder retries the same model on row ranges and merges. Row numbers
  // reference the R{n}: prefixes in the sheet text; the last prefix is the
  // true end row (sheets don't always start at R1).
  const lastRowLabel = info.text.match(/^R(\d+):/gm)?.pop();
  const endRow = lastRowLabel ? parseInt(lastRowLabel.slice(1), 10) : info.rows;
  const chunking: ChunkingOptions = {
    itemCount: endRow,
    itemLabel: 'rows',
    estimatedUnits: preview?.statedUnitCount ?? null,
    makeChunkContent: ({ start, end, index, total }, feedback) => [
      ...docBlocks,
      {
        type: 'text',
        text:
          `${instructions}\n\nCHUNK SCOPE (chunk ${index} of ${total}): this sheet is being extracted in ${total} row-range chunks because it is too large for one response. Extract ONLY the units whose unit number appears on sheet rows R${start} through R${end} (inclusive; row numbers are the R-prefixes in the sheet text above). Units on rows outside this range are handled by other chunks — do NOT output them. A unit belongs to this chunk when the row bearing its unit number is in range; include its full details even if its charge/detail rows continue past R${end}. Still report propertyName, statedTotalUnits, and statedSummary for the WHOLE document (they may appear anywhere in the sheet). The final recount rule applies only to unit rows within R${start}–R${end}.` +
          (feedback ? `\n\n${feedback}` : ''),
      },
    ],
  };

  // Only the summary-sheet harvest is injected as external verification
  // anchors: the full extraction re-reads this sheet's own text itself, but it
  // can never see the summary sheets. (external is null when none exist, so
  // behavior is unchanged for ordinary workbooks.)
  const result = await runExtractionLadder(makeContent, usages, report, `sheet "${info.name}"`, chunking, external);
  return { result, usage: usages, path: 'ai' };
}

export async function parseExcelV2(buffer: Buffer, report?: ProgressReporter): Promise<{
  units: GenericRentRollUnit[];
  statedUnitCount: number | null;
  statedSummaryStats: StatedSummaryStats | null;
  propertyName: string | null;
  format: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
}> {
  // cellNF/cellText populate cell.z (number format) and cell.w (display text),
  // which we need to detect date cells and render them as ISO dates.
  report?.('reading', 'parsing workbook', { kind: 'info', message: 'Reading the Excel workbook' });
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true, cellText: true });
  const allUsage: AIUsage[] = [];

  // Build sheet infos
  const infos: SheetInfo[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const grid = sheetToGrid(sheet, MAX_ROWS_PER_CALL);
    const previewGrid = sheetToGrid(sheet, 14);
    if (!grid.text) continue;
    infos.push({ name, rows: grid.rows, cols: grid.cols, text: grid.text, preview: previewGrid.text, sheet });
  }
  if (infos.length === 0) throw new Error('Workbook has no readable sheets');

  // Heuristic prefilter, then AI triage when ambiguous
  const scored = infos.map(i => ({ info: i, score: sheetHeuristicScore(i) }));
  let candidates = scored.filter(s => s.score > 0).map(s => s.info);
  if (candidates.length === 0) candidates = [scored.sort((a, b) => b.score - a.score)[0].info];

  let selectedNames: string[];
  if (candidates.length === 1) {
    selectedNames = [candidates[0].name];
    report?.('triaging', undefined, {
      kind: 'info',
      message: infos.length === 1
        ? `Workbook has one sheet: "${candidates[0].name}"`
        : `Identified "${candidates[0].name}" as the rent roll among ${infos.length} sheets`,
    });
  } else {
    report?.('triaging', `selecting rent roll sheets among ${candidates.length} candidates`, {
      kind: 'info',
      message: `${candidates.length} sheets look like they could be rent rolls — asking AI to triage`,
    });
    const triage = await triageSheets(candidates);
    allUsage.push(...triage.usage);
    selectedNames = triage.selected;
    if (selectedNames.length === 0) {
      // Fall back to the highest-scoring candidate
      selectedNames = [candidates[0].name];
    }
    report?.('triaging', undefined, {
      kind: 'decision',
      message: `Selected ${selectedNames.length} sheet${selectedNames.length === 1 ? '' : 's'} to extract: ${selectedNames.map(n => `"${n}"`).join(', ')}`,
    });
  }

  const selected = infos.filter(i => selectedNames.includes(i.name));

  // Details+Summary exports put the unit count/occupancy on summary sheets
  // that triage (correctly) rejects for unit extraction. Harvest their stated
  // totals so the preview, chunk sizing, and verification can use them. Only
  // for single-sheet extractions: workbook-level totals would be wrong anchors
  // for the per-building sheets of a multi-sheet workbook.
  let harvested: PreviewData | null = null;
  if (selected.length === 1) {
    const summaries = findSummarySheets(infos, selectedNames);
    const harvestUsage: AIUsage[] = [];
    harvested = await harvestSummaryStated(summaries, harvestUsage, report);
    allUsage.push(...harvestUsage);
  }

  // Extract sheets (sequentially to be gentle on rate limits; sheets are few)
  const results: ExtractionResult[] = [];
  const paths: string[] = [];
  for (const sheetInfo of selected) {
    const { result, usage, path } = await extractSheet(sheetInfo, report, harvested);
    allUsage.push(...usage);
    results.push(result);
    paths.push(`${sheetInfo.name}:${path}`);
  }

  // Drop update-log sheets: a smaller sheet that re-lists units ALREADY present
  // on another sheet WITH THE SAME TENANTS is a change log, not a building.
  // Unit numbers alone are not enough — sibling buildings in one workbook often
  // share identical unit layouts (2N/2S/.../STORE), so we require tenant-level
  // agreement before dropping anything.
  const normUnit = (s: string) => String(s).toUpperCase().replace(/[#\s.,_/\\-]+/g, '');
  const normTenant = (s: string | null | undefined) =>
    s ? String(s).toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
  const pairSet = (r: ExtractionResult) =>
    new Set(r.units.map(u => `${normUnit(u.unitNumber)}::${normTenant(u.tenantName)}`));
  const keep = results.map(() => true);
  for (let a = 0; a < results.length; a++) {
    for (let b = 0; b < results.length; b++) {
      if (a === b || !keep[b] || !keep[a] || results[b].units.length === 0) continue;
      // Drop b when smaller than a; for identical sizes (two views of the same
      // roll) drop the later sheet only.
      if (results[b].units.length > results[a].units.length) continue;
      if (results[b].units.length === results[a].units.length && b < a) continue;
      const tenantedB = results[b].units.filter(u => normTenant(u.tenantName) !== '');
      if (tenantedB.length === 0) continue; // can't confirm identity without tenants
      const setA = pairSet(results[a]);
      const matched = results[b].units.filter(u =>
        setA.has(`${normUnit(u.unitNumber)}::${normTenant(u.tenantName)}`)
      ).length;
      if (matched === results[b].units.length) keep[b] = false;
    }
  }

  const droppedNames = selected.filter((_, i) => !keep[i]).map(s => `"${s.name}"`);
  if (droppedNames.length > 0) {
    report?.('merging', undefined, {
      kind: 'decision',
      message: `Dropped ${droppedNames.join(', ')} — it re-lists units already extracted from another sheet (update log, not a separate building)`,
    });
  }

  // Merge results across sheets. Units are NOT deduped across sheets —
  // different buildings can share unit numbers.
  const kept = results.filter((_, i) => keep[i]);
  const units: GenericRentRollUnit[] = [];
  for (const r of kept) {
    units.push(...toGenericRentRollUnits(r.units));
  }
  units.forEach((u, i) => { u.sourceRow = i + 1; });

  // Merge stated totals: sum when multiple sheets state their own totals.
  const merged = mergeStated(kept);

  const usage = sumUsage(allUsage);
  return {
    units,
    statedUnitCount: merged.statedTotalUnits,
    statedSummaryStats: merged.stats,
    propertyName: kept.find(r => r.propertyName)?.propertyName ?? null,
    format: `excel-v2 (${paths.join(', ')})`,
    modelUsed: usage.modelUsed,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUSD: estimateCostUSD(allUsage),
  };
}

function mergeStated(results: ExtractionResult[]): {
  statedTotalUnits: number | null;
  stats: StatedSummaryStats | null;
} {
  if (results.length === 1) {
    return {
      statedTotalUnits: results[0].statedTotalUnits,
      stats: toStatedSummaryStats(results[0]),
    };
  }
  const sumOrNull = (vals: (number | null)[]): number | null => {
    const present = vals.filter((v): v is number => v !== null);
    return present.length > 0 ? Math.round(present.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };
  const statedTotalUnits = sumOrNull(results.map(r => r.statedTotalUnits));
  const stats: StatedSummaryStats = {
    totalUnits: statedTotalUnits,
    totalMonthlyRent: sumOrNull(results.map(r => r.statedSummary?.totalMonthlyRent ?? null)),
    totalMarketRent: sumOrNull(results.map(r => r.statedSummary?.totalMarketRent ?? null)),
    totalSqft: sumOrNull(results.map(r => r.statedSummary?.totalSqft ?? null)),
    occupancyRate: null, // averaging percentages across buildings is not meaningful
    occupiedUnits: sumOrNull(results.map(r => r.statedSummary?.occupiedUnits ?? null)),
    vacantUnits: sumOrNull(results.map(r => r.statedSummary?.vacantUnits ?? null)),
  };
  const hasAny = Object.values(stats).some(v => v !== null);
  return { statedTotalUnits, stats: hasAny ? stats : null };
}
