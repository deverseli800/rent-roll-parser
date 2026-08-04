import { extractStructured, MODELS, type AIUsage } from '../parsers/aiClient';
import { CHARGE_CATEGORIES, normalizeChargeCode } from './chargeNormalization';
import type { ChargeCategory, GenericRentRollUnit } from '../types';

/**
 * Per-document charge-code classification.
 *
 * No keyword list can cover every property-management system's abbreviations
 * ("como", "rentcr", "MLIW", "PDLW", "CPCR"), so the vocabulary is classified
 * per document instead of matched against a fixed table. The unit of work is
 * the DISTINCT CODE, not the charge line: a 76-unit Yardi export had 449 charge
 * lines drawn from 12 codes, so this is one small call regardless of roll size.
 *
 * Which lines are RENT is a separate question the parsers already answer — the
 * fast-path mapper returns per-document `rentChargeCodes`/`subsidyChargeCodes`
 * and the full-AI path emits `monthlyRent`/`subsidyRent` directly. This only
 * decides how each code is BUCKETED for the property-level charge summary.
 *
 * Signed sums are the strongest signal available and are computed here rather
 * than asked for: a code totalling -31,957 is a credit whatever it is named.
 *
 * CALLERS: processExtraction.ts (web) and scripts/parse-rent-roll.ts (CLI, and
 * therefore the exported skill bundle). The eval harness deliberately does NOT
 * call this — it grades extraction, and charge categories are not scored — so
 * categories in eval/runs/* caches come from the `normalizeChargeCode` keyword
 * fallback alone. If charge-category grading is ever added to eval/score.ts,
 * wire this in there too or the eval will be grading the fallback rather than
 * production behavior.
 */

interface CodeStat {
  code: string;
  lines: number;
  sum: number;
}

// `category` is a plain string rather than an enum on purpose: constraining it
// to the 20 allowed values made structured-output grammar compilation flaky
// ("Grammar compilation timed out" 400s). The prompt lists and explains every
// category, and `classifyChargeCodes` discards any value outside
// CHARGE_CATEGORIES, so the enum bought nothing the validation does not.
const CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['codes'],
  properties: {
    codes: {
      type: 'array',
      description: 'One entry per charge code given, using the code string verbatim.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'category'],
        properties: {
          code: { type: 'string', description: 'The charge code, copied verbatim from the input list' },
          category: { type: 'string', description: `Exactly one of: ${CHARGE_CATEGORIES.join(', ')}` },
        },
      },
    },
  },
};

const PROMPT = `You are categorizing the charge codes of ONE multifamily rent roll so downstream code can total ancillary income correctly. Below is every distinct charge code in the document, with how many charge lines carry it and the SIGNED sum of those lines.

Assign each code exactly one category:

RENT (the contract rent itself — never ancillary income):
  base_rent      the unit's base/contract rent line
  subsidy        HUD/HAP/Section 8/voucher portion of the rent

RENT ADJUSTMENTS (reductions or losses against rent — never income):
  concession     recurring rent concession/discount/credit to the resident
  loss_to_lease  gain/loss to lease vs market (often a matched +/- pair, e.g. LTOR/LTOL)
  vacancy_loss   vacancy loss/credit booked against a vacant unit's rent

ANCILLARY INCOME (billed on top of rent):
  pet, parking, storage, utility, trash, pest_control, internet, admin_fee,
  deposit_waiver, credit_builder, mtm_fee, damages,
  tax_recovery   real estate/property tax billed back to the resident
  other_income   clearly ancillary income with no bucket above

  other          you genuinely cannot tell what it is

Rules:
- Codes are usually "ABBREV-Description". Read the description; use the abbreviation only as a hint.
- USE THE SIGN. A negative sum is a credit/reduction (concession, vacancy_loss, or the credit half of a loss_to_lease pair), never a fee. A positive sum billed to residents is income.
- A matched pair with equal and opposite sums (e.g. +31,957 and -31,957) is almost always loss_to_lease, not a concession.
- An insurance/liability WAIVER (e.g. "Mandatory Liability Insurance Waiver", "PDLW") is a FEE charged to the resident — other_income, NOT a concession. Only deposit-replacement products are deposit_waiver.
- Magnitude helps: a code whose sum is comparable to total rent is base_rent or subsidy; small per-unit amounts are fees.
- Prefer a specific category over other_income, and other_income over other. Use "other" only as a last resort.

Return one entry per code, with the code string copied verbatim.`;

/** Distinct codes across all units, with line counts and signed sums. */
export function collectChargeCodes(units: GenericRentRollUnit[]): CodeStat[] {
  const map = new Map<string, CodeStat>();
  for (const u of units) {
    for (const c of u.charges ?? []) {
      if (!c?.code) continue;
      const e = map.get(c.code) ?? { code: c.code, lines: 0, sum: 0 };
      e.lines++;
      e.sum += typeof c.amount === 'number' ? c.amount : 0;
      map.set(c.code, e);
    }
  }
  return [...map.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
}

/**
 * Reclassify each unit's charges from a model-built map of the document's own
 * code vocabulary. Mutates `units` in place.
 *
 * Fails open in every direction — the keyword categories assigned at extraction
 * time stand when there is nothing to classify, when the call errors, or for any
 * individual code the model omits or mislabels. Returns the codes it changed so
 * callers can report them.
 */
export async function classifyChargeCodes(
  units: GenericRentRollUnit[],
  usages: AIUsage[]
): Promise<{
  classified: number;
  changed: { code: string; from: ChargeCategory; to: ChargeCategory }[];
  declined: { code: string; kept: ChargeCategory; proposed: ChargeCategory }[];
}> {
  const stats = collectChargeCodes(units);
  if (stats.length === 0) return { classified: 0, changed: [], declined: [] };

  const listing = stats
    .map(s => `- "${s.code}" — ${s.lines} charge line${s.lines === 1 ? '' : 's'}, signed sum ${s.sum.toFixed(2)}`)
    .join('\n');

  const valid = new Set<string>(CHARGE_CATEGORIES);
  let assigned = new Map<string, ChargeCategory>();
  // One retry: the observed failures here are transient server-side 400s, and a
  // single tiny call is cheap enough to repeat.
  for (let attempt = 1; attempt <= 2 && assigned.size === 0; attempt++) {
    try {
      const { data, usage } = await extractStructured<{ codes: { code: string; category: string }[] }>({
        model: MODELS.fast,
        content: [{ type: 'text', text: `${PROMPT}\n\nCHARGE CODES IN THIS DOCUMENT (${stats.length}):\n${listing}` }],
        schema: CLASSIFICATION_SCHEMA,
        maxTokens: 8000,
      });
      usages.push(usage);
      assigned = new Map(
        (data.codes ?? [])
          .filter(e => e?.code && valid.has(e.category))
          .map(e => [e.code, e.category as ChargeCategory])
      );
    } catch (e) {
      // A failed classification must never fail the extraction — the keyword
      // categories are already in place and remain valid.
      console.warn(
        `[chargeClassifier] attempt ${attempt} failed${attempt === 2 ? ', keeping keyword categories' : ', retrying'}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  if (assigned.size === 0) return { classified: 0, changed: [], declined: [] };

  // The model only fills in what the keyword layer ABSTAINED on ('other'); it
  // may not overrule a keyword match. Measured on 9 charge-block documents (69
  // real codes), letting it override produced worse answers and cross-document
  // inconsistency for identical codes: "Service Fee" was moved off admin_fee,
  // "comm" came back base_rent on two files and other_income on three, and
  // OCR fragments like "s" and "12" got confident categories. Restricting it to
  // the 'other' bucket keeps the entire benefit — the cryptic abbreviations no
  // list can cover ("rnt", "sec8", "pref", "dhcr", "valtsh", "sdw") are all
  // 'other' — while making the validated keyword results authoritative.
  const overrides = new Map<string, ChargeCategory>();
  const changed: { code: string; from: ChargeCategory; to: ChargeCategory }[] = [];
  const declined: { code: string; kept: ChargeCategory; proposed: ChargeCategory }[] = [];
  for (const s of stats) {
    const to = assigned.get(s.code);
    if (!to) continue;
    const from = normalizeChargeCode(s.code);
    if (from !== 'other') {
      if (from !== to) declined.push({ code: s.code, kept: from, proposed: to });
      continue;
    }
    if (to === 'other') continue;
    overrides.set(s.code, to);
    changed.push({ code: s.code, from, to });
  }
  for (const u of units) {
    for (const c of u.charges ?? []) {
      const to = overrides.get(c.code);
      if (to) c.category = to;
    }
  }
  return { classified: overrides.size, changed, declined };
}
