import type Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import type { GenericRentRollUnit, StatedSummaryStats } from '../types';
import { extractStructured, MODELS, modelLabel, type AIUsage } from './aiClient';
import { estimateCostUSD } from '../utils/aiCost';
import {
  EXTRACTION_SCHEMA,
  extractStatedPreview,
  normalizeStatedSentinels,
  pickBetterAttempt,
  reconcileRentWithChargeLines,
  toGenericRentRollUnits,
  toStatedSummaryStats,
  unitNumberMultiset,
  verifyAgainstStated,
  type ExtractedUnit,
  type ExtractionResult,
  type PreviewData,
  type ProgressReporter,
  type VerificationOutcome,
} from './extractionCore';
import { PDF_PROMPT } from './pdfV2';

/**
 * Parallel page-level PDF extraction.
 *
 * The whole-document call is output-bound: one stream of ~500 output tokens
 * per unit, so a 250-unit roll takes 10-25 minutes however strong the model.
 * Splitting the PDF into pages and extracting every page concurrently turns
 * that into the time of the slowest page (~30s), at the same accuracy.
 *
 * Each worker receives the page before and after its own as CONTEXT (column
 * headers live on every page in most reports, and a unit's charge block can
 * straddle a page break) and is told to output only the units whose
 * unit-number row is on its own page. The document's stated totals are read
 * by the existing whole-document preview call, which runs alongside.
 *
 * The hazard of parallel workers is consistency, not coverage: they make the
 * rent rules' judgment calls independently (net out a concession or not; 0 or
 * null for a vacant). Charge lines are captured verbatim by every worker, so
 * after stitching the rent figure is re-derived document-wide from them when
 * they reconcile to the stated total (reconcileRentWithChargeLines). The
 * stitched result then passes through the same self-verification gate and
 * model ladder as the single-call path.
 *
 * Measured on a few-hundred-unit charge-block roll: about half a minute on
 * Sonnet 5.5 at 99.9%+ field agreement with the whole-document Opus result,
 * which took tens of minutes.
 */

/** Single-page PDFs go through the whole-document path unchanged. */
const PARALLEL_MIN_PAGES = 2;
/** Concurrent page workers. Each is one streaming call of modest size. */
const PAGE_CONCURRENCY = Math.max(1, parseInt(process.env.PDF_PAGE_CONCURRENCY ?? '32', 10) || 32);
/** Per-page output ceiling: a dense simple roll fits ~100 units a page. */
const PAGE_MAX_TOKENS = 64000;
/** One retry on the same model before a page failure is recorded. */
const PAGE_RETRIES = 1;

/** Split a PDF into one single-page PDF per page (pdf-lib, pure JS). */
export async function splitPdfPages(buffer: Buffer): Promise<Buffer[]> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  const pages: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    pages.push(Buffer.from(await doc.save()));
  }
  return pages;
}

function pagePrompt(page: number, pageCount: number, feedback?: string): string {
  const attached: string[] = [];
  if (page > 1) attached.push(`page ${page - 1} (CONTEXT ONLY)`);
  attached.push(`page ${page} (IN SCOPE)`);
  if (page < pageCount) attached.push(`page ${page + 1} (CONTEXT ONLY)`);
  return `${PDF_PROMPT}

PAGE SCOPE: this ${pageCount}-page rent roll is being extracted page-by-page in parallel. The attached documents are, in order: ${attached.join(', ')}.
Extract ONLY the units whose row bearing the UNIT NUMBER is printed on page ${page} (the IN SCOPE page). A unit belongs to this page when its unit-number row is on it; include its full details even if its charge rows continue onto the following context page — look at the TOP of the next context page for continuation charge lines (RENT and fees) of the LAST unit on your page and include them in that unit's charges[]. Rows at the top of page ${page} that are charge-line continuations of a unit whose unit-number row is on the preceding context page belong to ANOTHER worker — do NOT output that unit. Never output units from the context pages.
A unit printed as Vacant / Vacant-Leased whose block also carries an "Applicant" sub-row (a future resident who has not moved in as of the report date): the unit's CURRENT occupancy is vacant — status vacant, tenantName null, rent/dates null, leaseStatus the vacant label as printed; do NOT put the applicant's charge lines in charges[] (they are future charges, typically starred as "not included in detail totals"); instead pass the applicant through in sourceColumns as {"header":"Applicant","value":<name>} and {"header":"Applicant Rent","value":<rent as printed>}.
If the page header (or a context page's header) names a property, building or address, set building to that label for EVERY unit on the page even though you see only one property: the other pages of this document may cover other buildings that reuse the same unit numbers, and the label is what keeps them apart. Leave building null only when no such identifier is printed.
Report propertyName if it is visible. Report -1 for statedTotalUnits and for every statedSummary field: the document's totals are read separately from the whole document (a single page cannot tell a section subtotal from the document total).
The final recount rule applies only to unit rows on page ${page}.${feedback ? `\n\n${feedback}` : ''}`;
}

/** Small edit distance for tenant-name comparison (names are short). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Page-order dedupe. Two workers can emit the same unit in two situations
 * with very different priors:
 *
 * - ADJACENT pages: the unit's block straddles the split and both workers
 *   claimed it. Same number with the same tenant (both blank counts) or the
 *   same rent is the same unit, whatever either worker put in `building`.
 * - NON-ADJACENT pages: the document repeats its units in a later billing or
 *   arrears section (the whole-document rules say extract each unit once from
 *   the rent roll section, but a page worker cannot see which section it is
 *   in). That is only a repeat when the TENANT matches — allowing the
 *   glyph-level spelling drift a second section introduces. A blank tenant
 *   proves nothing here: a two-property roll prints the same unit numbers
 *   twice, and a vacant 22 in one building is not the occupied 22 in the other
 *   (measured: four vacants merged away on a two-property roll before
 *   this rule). The building label is deliberately NOT compared: workers
 *   label the same building differently from page to page ("Bldg 12" on one,
 *   the owner's name on the next), and two buildings sharing a unit number
 *   AND a tenant name does not happen.
 *
 * The first copy is kept (the rent roll section leads), upgraded to a later
 * copy only when that one captured more charge lines (it saw the continuation).
 */
function stitch(
  pages: { page: number; units: ExtractedUnit[] }[]
): { units: ExtractedUnit[]; pageOf: number[]; dropped: number } {
  const numberKey = (u: ExtractedUnit) => String(u.unitNumber).toUpperCase().replace(/[#\s.,_/\\-]+/g, '');
  const tenant = (u: ExtractedUnit) => (u.tenantName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const tenantsMatch = (a: ExtractedUnit, b: ExtractedUnit, allowBlank: boolean) => {
    const t1 = tenant(a);
    const t2 = tenant(b);
    if (!t1 && !t2) return allowBlank;
    if (!t1 || !t2) return false;
    if (t1 === t2) return true;
    return editDistance(t1, t2) <= Math.max(1, Math.floor(Math.min(t1.length, t2.length) / 6));
  };
  const sameRent = (a: ExtractedUnit, b: ExtractedUnit) =>
    a.monthlyRent !== null && a.monthlyRent !== undefined && a.monthlyRent === b.monthlyRent;
  const isRepeat = (prev: { u: ExtractedUnit; page: number }, u: ExtractedUnit, page: number) => {
    if (Math.abs(prev.page - page) <= 1) return tenantsMatch(prev.u, u, true) || sameRent(prev.u, u);
    return tenantsMatch(prev.u, u, false);
  };
  const kept: { u: ExtractedUnit; page: number }[] = [];
  const byNumber = new Map<string, number[]>(); // unit number -> indices into kept
  let dropped = 0;
  for (const { page, units } of pages) {
    for (const u of units) {
      const key = numberKey(u);
      const idxs = byNumber.get(key) ?? [];
      const dupIdx = idxs.find(i => isRepeat(kept[i], u, page));
      if (dupIdx !== undefined) {
        dropped++;
        if ((u.charges?.length ?? 0) > (kept[dupIdx].u.charges?.length ?? 0)) kept[dupIdx] = { u, page };
        continue;
      }
      idxs.push(kept.length);
      byNumber.set(key, idxs);
      kept.push({ u, page });
    }
  }
  return { units: kept.map(k => k.u), pageOf: kept.map(k => k.page), dropped };
}

/**
 * Do these building labels all name one property? Workers spell the same
 * header differently ("Maple Court", "Acme Mgmt - Maple Court", "Building 12"
 * / "12"), so equality is too strict: the labels name one property when every
 * one of them contains the shortest. Two genuinely different buildings
 * ("124 Main St" / "126 Main St") fail that test.
 */
export function isSingleProperty(labels: (string | null | undefined)[]): boolean {
  const norm = [...new Set(labels.map(l => (l ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))];
  if (norm.length <= 1) return true;
  const shortest = norm.reduce((a, b) => (b.length < a.length ? b : a));
  return norm.every(l => l.includes(shortest));
}

interface Attempt {
  result: ExtractionResult;
  verification: VerificationOutcome;
  model: string;
  pageOf: number[];
}

/**
 * Parse a multi-page PDF page-by-page in parallel. Returns null when the
 * document is single-page or cannot be split, so the caller can fall back to
 * the whole-document parser.
 */
export async function parsePDFParallel(buffer: Buffer, report?: ProgressReporter): Promise<{
  units: GenericRentRollUnit[];
  statedUnitCount: number | null;
  statedSummaryStats: StatedSummaryStats | null;
  propertyName: string | null;
  format: string;
  pageCount: number | null;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
} | null> {
  let pages: Buffer[];
  try {
    pages = await splitPdfPages(buffer);
  } catch (e) {
    report?.('reading', 'preparing PDF', {
      kind: 'info',
      message: `Could not split the PDF into pages (${e instanceof Error ? e.message.slice(0, 80) : String(e)}) — extracting it as one document`,
    });
    return null;
  }
  const pageCount = pages.length;
  if (pageCount < PARALLEL_MIN_PAGES) return null;

  report?.('reading', 'preparing PDF', {
    kind: 'info',
    message: `Split the ${pageCount}-page PDF (${Math.round(buffer.length / 1024)}KB) into pages — extracting them in parallel, each page with its neighbours as context`,
  });

  const usages: AIUsage[] = [];
  // Each page is sent up to three times per attempt (own + two neighbours);
  // encode once.
  const pagesBase64 = pages.map(p => p.toString('base64'));
  const pageBlock = (p: number): Anthropic.ContentBlockParam => ({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pagesBase64[p - 1] },
  });

  // Stated totals: the existing whole-document preview, started now so it
  // overlaps the first attempt. No cache_control — nothing else sends the
  // whole document, so there is nothing for a cache write to serve.
  const previewP: Promise<PreviewData | null> = extractStatedPreview(
    [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }],
    usages, report, 'the PDF'
  );

  let attemptNo = 0;
  const attempt = async (model: string, feedback?: string): Promise<Attempt> => {
    attemptNo++;
    const label = `attempt ${attemptNo} (${modelLabel(model)})`;
    report?.('extracting', `${label} — extracting ${pageCount} pages in parallel`, {
      kind: 'attempt',
      message: `${modelLabel(model)} extracting ${pageCount} pages in parallel (attempt ${attemptNo})`,
    });

    let done = 0;
    let unitsSoFar = 0;
    const failures: string[] = [];
    const perPage: { page: number; units: ExtractedUnit[]; data: ExtractionResult | null }[] =
      Array.from({ length: pageCount }, (_, i) => ({ page: i + 1, units: [], data: null }));

    const extractPage = async (page: number) => {
      const content: Anthropic.ContentBlockParam[] = [];
      if (page > 1) content.push(pageBlock(page - 1));
      content.push(pageBlock(page));
      if (page < pageCount) content.push(pageBlock(page + 1));
      content.push({ type: 'text', text: pagePrompt(page, pageCount, feedback) });
      for (let tries = 0; ; tries++) {
        try {
          const { data, usage } = await extractStructured<ExtractionResult>({
            model, content, schema: EXTRACTION_SCHEMA, maxTokens: PAGE_MAX_TOKENS,
          });
          usages.push(usage);
          normalizeStatedSentinels(data);
          perPage[page - 1] = { page, units: data.units, data };
          unitsSoFar += data.units.length;
          return;
        } catch (e) {
          if (tries < PAGE_RETRIES) continue;
          failures.push(`page ${page}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
          return;
        }
      }
    };

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PAGE_CONCURRENCY, pageCount) }, async () => {
        while (next < pageCount) {
          const page = ++next;
          await extractPage(page);
          done++;
          report?.('extracting', `${label} — ${done}/${pageCount} pages done, ${unitsSoFar} unit${unitsSoFar === 1 ? '' : 's'} extracted so far`);
        }
      })
    );

    const { units, pageOf, dropped } = stitch(perPage);
    // Workers label every unit with the building named in their page header
    // (so two buildings that reuse unit numbers stay apart). When every label
    // in the document normalises to the same thing it is one property, and the
    // contract says building is null for single-property documents.
    if (isSingleProperty(units.map(u => u.building))) for (const u of units) u.building = null;
    // Stated totals come from the whole-document preview ONLY. A page worker
    // cannot tell a property/section subtotal from the document total, and a
    // wrong anchor costs a full trip up the model ladder (measured: a
    // two-property roll escalated to Fable 5.1 over one worker's section
    // total). With no preview the verification simply has no anchors, which
    // the ladder handles with a second opinion rather than a failure.
    const preview = await previewP;
    const s = preview?.statedSummaryStats ?? null;
    const result: ExtractionResult = {
      propertyName: preview?.propertyName ?? perPage.map(p => p.data?.propertyName).find(Boolean) ?? null,
      statedTotalUnits: preview?.statedUnitCount ?? null,
      statedSummary: {
        totalMonthlyRent: s?.totalMonthlyRent ?? null,
        totalMarketRent: s?.totalMarketRent ?? null,
        totalSqft: s?.totalSqft ?? null,
        occupancyRate: s?.occupancyRate ?? null,
        occupiedUnits: s?.occupiedUnits ?? null,
        vacantUnits: s?.vacantUnits ?? null,
      },
      units,
    };

    const reconciled = reconcileRentWithChargeLines(result);
    report?.('extracting', undefined, {
      kind: 'info',
      message:
        `Stitched ${units.length} units from ${pageCount} pages` +
        (dropped ? ` (${dropped} repeated unit${dropped === 1 ? '' : 's'} merged — page-boundary or second-section copies)` : '') +
        (reconciled ? `; ${reconciled}` : '') +
        (failures.length ? `; ${failures.length} page${failures.length === 1 ? '' : 's'} failed` : ''),
    });

    const verification = verifyAgainstStated(result);
    for (const f of failures) verification.issues.push(`extraction failed on ${f}`);
    if (failures.length) { verification.ok = false; verification.hasStatedAnchors = true; }
    report?.('verifying', label, verification.ok
      ? {
          kind: 'verify_pass',
          message: verification.hasStatedAnchors
            ? `${modelLabel(model)} extracted ${units.length} units — verified against the document's stated totals`
            : `${modelLabel(model)} extracted ${units.length} units — document states no totals to verify against`,
        }
      : {
          kind: 'verify_fail',
          message: `${modelLabel(model)}'s result failed self-verification: ${verification.issues.slice(0, 2).map(i => i.split(' — ')[0]).join('; ')}${verification.issues.length > 2 ? ` (+${verification.issues.length - 2} more)` : ''}`,
        });
    return { result, verification, model, pageOf };
  };

  const feedbackFor = (v: VerificationOutcome) =>
    `IMPORTANT — a previous extraction attempt over the WHOLE document had these problems (your scope is one page of it; fix what applies to your page):\n${v.issues.map(i => `- ${i}`).join('\n')}`;

  // Same ladder as runExtractionLadder: fast -> strong with feedback -> max
  // with feedback when the document states totals; a strong second opinion
  // when it states none.
  let best = await attempt(MODELS.fast);
  if (!best.verification.ok) {
    report?.('escalating', undefined, {
      kind: 'escalation',
      message: `Escalating to ${modelLabel(MODELS.strong)} with feedback about what went wrong`,
    });
    const retry = await attempt(MODELS.strong, feedbackFor(best.verification));
    best = pickBetterAttempt(best, retry) as Attempt;
    report?.('extracting', undefined, {
      kind: 'decision',
      message: best === retry
        ? `Keeping ${modelLabel(MODELS.strong)}'s result${best.verification.ok ? '' : ' (better of the two, but still imperfect)'}`
        : `${modelLabel(MODELS.strong)} did not improve on ${modelLabel(MODELS.fast)} — keeping the earlier result`,
    });
    if (!best.verification.ok && best.verification.hasStatedAnchors) {
      report?.('escalating', undefined, {
        kind: 'escalation',
        message: `Still failing verification — escalating to ${modelLabel(MODELS.max)} (most capable model)`,
      });
      const retry2 = await attempt(MODELS.max, feedbackFor(best.verification));
      const prev = best;
      best = pickBetterAttempt(best, retry2) as Attempt;
      report?.('extracting', undefined, {
        kind: 'decision',
        message: best === retry2
          ? `Keeping ${modelLabel(MODELS.max)}'s result${best.verification.ok ? '' : ' (best available, some checks still unresolved)'}`
          : `${modelLabel(MODELS.max)} did not improve — keeping the earlier result${prev.verification.ok ? '' : ' (some checks still unresolved)'}`,
      });
    }
  } else if (!best.verification.hasStatedAnchors) {
    report?.('verifying', undefined, {
      kind: 'info',
      message: `No stated totals to verify against — asking ${modelLabel(MODELS.strong)} for an independent second opinion`,
    });
    const second = await attempt(MODELS.strong);
    if (unitNumberMultiset(best.result.units) !== unitNumberMultiset(second.result.units)) {
      best = second.verification.issues.length <= best.verification.issues.length ? second : best;
      report?.('extracting', undefined, {
        kind: 'decision',
        message: `The two models disagreed on the unit list — keeping ${modelLabel(best.model)}'s version`,
      });
    } else {
      report?.('extracting', undefined, {
        kind: 'decision',
        message: 'Both models independently extracted the same unit list — high agreement',
      });
    }
  }

  if (best.result.units.length === 0 && best.verification.issues.some(i => i.startsWith('extraction failed'))) {
    throw new Error(best.verification.issues.find(i => i.startsWith('extraction failed')));
  }

  const r = best.result;
  const units = toGenericRentRollUnits(r.units);
  units.forEach((u, i) => { u.sourcePage = best.pageOf[i]; });
  const usage = usages.reduce(
    (s, u) => ({ inputTokens: s.inputTokens + u.inputTokens, outputTokens: s.outputTokens + u.outputTokens }),
    { inputTokens: 0, outputTokens: 0 }
  );
  return {
    units,
    statedUnitCount: r.statedTotalUnits ?? null,
    statedSummaryStats: toStatedSummaryStats(r),
    propertyName: r.propertyName ?? null,
    format: `ai-extraction-v2 (pdf, ${pageCount} pages in parallel, ${attemptNo} attempt${attemptNo === 1 ? '' : 's'})`,
    pageCount,
    modelUsed: best.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUSD: estimateCostUSD(usages),
  };
}
