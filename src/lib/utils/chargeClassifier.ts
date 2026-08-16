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

/**
 * The one category distinction the keyword prior is allowed to be overruled on.
 * See the rationale at the override site below.
 */
const REDUCTION_PAIR: ReadonlySet<ChargeCategory> = new Set<ChargeCategory>([
  'concession', 'reimbursed_credit',
]);

/**
 * Whether the model's proposal for a code is allowed to stand.
 *
 *   accept  — take the model's category
 *   decline — keep the keyword category, record the disagreement
 *   noop    — nothing to do (the two agree, or neither knows)
 *
 * Two rules, for two different kinds of category (see RENT_DECIDING_CATEGORIES
 * in chargeNormalization.ts):
 *
 * 1. The keyword layer abstained ('other') -> the model fills it in. This is
 *    the bulk of the value: cryptic PMS abbreviations no fixed list can cover.
 *
 * 2. The keyword layer answered -> the model may NOT overrule it, with one
 *    exception: concession <-> reimbursed_credit.
 *
 * The lockout exists because letting the model overrule keyword matches
 * measurably degraded results (9 documents, 69 codes — see the note above). But
 * every failure in that evidence was an ancillary-income bucket: "Service Fee"
 * moving off admin_fee, "comm" flip-flopping between files. Those change no
 * number the engine produces.
 *
 * The reduction pair is categorically different. It decides whether a reduction
 * comes out of the OWNER's pocket, which moves monthlyRent and through it a
 * value conclusion — and it is a distinction a keyword table provably cannot
 * make, because both sides read as a discount on the tenant's bill. Only the
 * sign, magnitude, neighbouring codes and program name separate them, and the
 * model sees all four. Holding the prior final here is what pushed consumers
 * into string-matching the raw code instead.
 */
export function gateProposal(from: ChargeCategory, to: ChargeCategory): 'accept' | 'decline' | 'noop' {
  if (from === to) return 'noop';
  if (from === 'other') return to === 'other' ? 'noop' : 'accept';
  if (REDUCTION_PAIR.has(from) && REDUCTION_PAIR.has(to)) return 'accept';
  return 'decline';
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
  concession         a reduction the OWNER absorbs — the owner collects less.
                     Preferential rent (the legal/registered rent reduced by
                     agreement), discounts, free-rent amortization, courtesy credits.
  reimbursed_credit  a reduction the owner is MADE WHOLE for by a third party —
                     the tenant pays less, the owner still ends up with the full
                     rent. Senior/disability rent-increase exemption programs
                     (SCRIE, DRIE and equivalents elsewhere), credits funded by an
                     agency, reductions offset by a tax abatement.
  loss_to_lease      gain/loss to lease vs market (often a matched +/- pair, e.g. LTOR/LTOL)
  vacancy_loss       vacancy loss/credit booked against a vacant unit's rent

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
- CONCESSION vs REIMBURSED_CREDIT — ask WHO ABSORBS THE REDUCTION, not who benefits. Both look identical to the tenant. If nothing in the code or the document suggests a third party makes the owner whole, it is a concession. Named exemption/abatement programs are reimbursed_credit even though they read as a discount. This is the only choice here that changes a rent figure, so weigh it carefully — and when the evidence is genuinely balanced, prefer concession, since claiming reimbursement that does not exist overstates what the owner collects.
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
    const from = normalizeChargeCode(s.code);
    const to = assigned.get(s.code);
    if (to) {
      switch (gateProposal(from, to)) {
        case 'accept':
          overrides.set(s.code, to);
          changed.push({ code: s.code, from, to });
          continue;
        case 'decline':
          declined.push({ code: s.code, kept: from, proposed: to });
          continue;
        case 'noop':
          break;
      }
    }
    // No override to apply from the model — but a NAMED-PROGRAM keyword answer
    // still has to reach the charge lines.
    //
    // Charge lines do not always start at the keyword category. On the
    // charge-COLUMN fast path the category comes from the column's ROLE, and a
    // negative column the mapper called a concession lands on every line as
    // 'concession'. If the keyword prior recognises the code as a named
    // exemption program, that sheet-derived label is wrong — and the loop above
    // will not fix it, because when the model AGREES with the keyword the gate
    // returns 'noop' and records no override. Two correct answers were
    // producing a wrong one (observed: a real SCRIE column staying 'concession',
    // understating rent by the credit on every affected unit).
    //
    // Only the reduction pair is propagated this way: the keyword list for it is
    // deliberately narrow (named programs only), so it is high-confidence enough
    // to overrule a column role, which carries no information about who is
    // reimbursed.
    if (REDUCTION_PAIR.has(from)) overrides.set(s.code, from);
  }
  for (const u of units) {
    for (const c of u.charges ?? []) {
      const to = overrides.get(c.code);
      if (!to) continue;
      // Only lines still categorized 'other' take the override: a charge may
      // carry a category the keyword layer did not assign (the fast-path
      // mapper classifies charge COLUMNS from the sheet itself), and that
      // sheet-derived category outranks a codes-only reclassification.
      //
      // The reduction pair is again the exception, in both directions: the
      // sheet-derived category comes from a column KIND, which carries no
      // information about who is reimbursed either.
      if (c.category === 'other' || (REDUCTION_PAIR.has(c.category) && REDUCTION_PAIR.has(to))) {
        c.category = to;
      }
    }
  }
  return { classified: overrides.size, changed, declined };
}
