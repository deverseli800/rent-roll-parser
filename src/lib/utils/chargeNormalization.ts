import type { ChargeCategory, UnitCharge, ChargeCategorySummary } from '../types';

/**
 * The contract rent itself. Dropped from `chargeSummary` entirely: the rent
 * totals already carry these amounts, and at rent-scale magnitudes they swamp
 * every ancillary line. (A Yardi export whose "RENT-Rent" code fell through
 * categorization into `other` reported ancillary income of $123,503 instead of
 * $3,633 — a 34x overstatement — because this exclusion never fired.)
 */
export const RENT_CLASS_CATEGORIES: ReadonlySet<ChargeCategory> = new Set<ChargeCategory>([
  'base_rent', 'subsidy',
]);

/**
 * Reductions and losses against rent. Kept VISIBLE in `chargeSummary` — a
 * document may itemize concessions only as charge lines, and dropping them
 * would make them invisible — but excluded from `totalChargesAmount`, which
 * means ancillary income. So the summary rows do not all sum to that total.
 */
export const RENT_ADJUSTMENT_CATEGORIES: ReadonlySet<ChargeCategory> = new Set<ChargeCategory>([
  'concession', 'reimbursed_credit', 'loss_to_lease', 'vacancy_loss',
]);

/**
 * The categories that DECIDE MONEY: getting one of these wrong moves
 * `monthlyRent`, which feeds a lender-facing value conclusion. They are held to
 * a different standard than the rest — the AI classifier may correct them (see
 * chargeClassifier.ts), and they are worth reconciling against the document's
 * own printed totals.
 *
 * Everything NOT in this set is an ancillary-income flavour. Those distinctions
 * (pet vs parking vs storage) change no number the engine produces; they exist
 * so a consumer can aggregate across documents. A mistake there is a rollup
 * annoyance, not a valuation error.
 */
export const RENT_DECIDING_CATEGORIES: ReadonlySet<ChargeCategory> = new Set<ChargeCategory>([
  'base_rent', 'subsidy', 'concession', 'reimbursed_credit', 'loss_to_lease', 'vacancy_loss',
]);

/** Every value the AI classifier is allowed to return (schema + validation). */
export const CHARGE_CATEGORIES: readonly ChargeCategory[] = [
  'base_rent', 'subsidy', 'pet', 'parking', 'storage', 'utility', 'trash',
  'pest_control', 'internet', 'admin_fee', 'deposit_waiver', 'credit_builder',
  'mtm_fee', 'damages', 'tax_recovery', 'other_income', 'concession',
  'reimbursed_credit', 'loss_to_lease', 'vacancy_loss', 'other',
] as const;

/**
 * Split a `CODE-Description` charge string into its parts.
 *
 * Property-management exports rarely emit a bare English label — Yardi/RealPage
 * write "RENT-Rent", "MLIW-Mandatory Liability Insurance Waiver",
 * "PACK-Parcel Locker". Matching the raw string meant an exact test like
 * `c === 'rent'` could never fire, so base rent fell through to `other` and
 * escaped the summary's rent exclusion. Match the description separately.
 *
 * The split is a GUESS, so both the description and the untouched raw string are
 * returned and every keyword test runs against both. That matters because the
 * head-token heuristic cannot tell a code prefix from a hyphenated English word:
 * "Month-to-Month Fee" splits into abbrev "month" + desc "to-month fee", and
 * "trash-pu" into "trash" + "pu". Testing the raw string too makes those
 * mis-splits harmless instead of silently losing the code.
 */
function splitCode(rawCode: string): { raw: string; abbrev: string | null; desc: string } {
  const raw = rawCode.toLowerCase().trim().replace(/\s+/g, ' ');
  const m = raw.match(/^([a-z0-9]{2,8})\s*[-:]\s*(.+)$/);
  if (!m) return { raw, abbrev: null, desc: raw };
  return { raw, abbrev: m[1], desc: m[2].trim() };
}

/**
 * Substring matching is the default and must stay that way: real codes squash
 * words together with no separators at all ("petrent", "PESTCTRL", "cableint",
 * "VTRASH", "AMENITYFEE", "parkres"), and plurals/suffixes are everywhere
 * ("Recurring credits", "Repairs & Maintenance"). A whole-word rule silently
 * dropped 16 such codes across the eval corpus into `other`.
 *
 * The narrow problem whole-word matching was introduced to solve — "waive"
 * matching inside "waiver", booking an insurance-waiver FEE as a rent
 * concession — is fixed instead by removing that keyword and routing
 * insurance/liability explicitly, which is what it always needed.
 */
function matcher(targets: string[]) {
  return (...words: string[]) => words.some(w => targets.some(t => t.includes(w)));
}

/**
 * Normalize a raw charge code to a standard category.
 *
 * This is the deterministic FALLBACK/prior. `classifyChargeCodes` (see
 * utils/chargeClassifier.ts) asks the model to categorize the document's own
 * code vocabulary and overrides these results — no keyword list can keep up
 * with every PMS's abbreviations. What lives here is only the high-confidence
 * core, so a failed or skipped classification still degrades sensibly.
 */
export function normalizeChargeCode(rawCode: string): ChargeCategory {
  const { raw, abbrev, desc } = splitCode(rawCode);
  // Test the description AND the raw string (see splitCode): the prefix split is
  // a guess, and a mis-split must not lose the code.
  const has = matcher(desc === raw ? [raw] : [desc, raw]);
  const a = abbrev ?? '';

  // Rent adjustments first: their labels contain words ("credit", "loss") that
  // the broader income/concession tests would otherwise claim.
  if (has('loss to lease', 'gain to lease', 'loss to old lease', 'gain to old lease', 'losstolease') ||
      a === 'ltol' || a === 'ltor' || a === 'gtl' || a === 'ltl') {
    return 'loss_to_lease';
  }
  if (has('vacancy loss', 'vacancy', 'vacant') || a === 'vac') {
    return 'vacancy_loss';
  }

  // Rent. Subsidy is tested FIRST because it is the more specific claim: a code
  // like "RENT-HUD Rent" would otherwise be caught by the base-rent abbreviation
  // clause below and lose the subsidy distinction.
  if (has('hud', 'hap', 'subsidy', 'housing assistance', 'voucher', 'section 8') ||
      a === 'hudr' || a === 'hap') {
    return 'subsidy';
  }
  // Base rent stays an EXACT test on the description: "rent" is a substring of
  // half the fee codes in this file ("petrent", "Pet Rent", "PARKRENT"), so a
  // loose match here would swallow them and — worse — exclude them from the
  // ancillary income summary as though they were contract rent.
  // The abbreviation clause deliberately tests `desc`, NOT `has()`: the raw
  // string always contains its own prefix, so `a === 'rent' && has('rent')`
  // reduced to `a === 'rent'` and claimed every RENT-* code — booking
  // "Rent-NSF/PR" and "Rent-Refunded" as contract rent, which then dropped them
  // from the charge summary entirely.
  if (desc === 'rent' || desc === 'base rent' || desc === 'market rent' || desc === 'lease rent' ||
      desc === 'monthly rent' || desc === 'scheduled rent' || (a === 'rent' && desc.includes('rent'))) {
    return 'base_rent';
  }

  // Ancillary income — specific buckets before generic ones.
  if (has('pet', 'animal')) return 'pet';
  if (has('parking', 'garage', 'carport', 'park')) return 'parking';
  if (has('storage', 'locker', 'parcel', 'stor') || /(^|[^a-z])st\d+/.test(desc)) {
    // "Parcel Locker" is package-room income, not a storage unit, but both are
    // ancillary income and no consumer distinguishes them today.
    return 'storage';
  }
  if (has('wifi', 'wi-fi', 'internet', 'cable', 'broadband')) return 'internet';
  if (has('trash', 'garbage', 'waste', 'refuse')) return 'trash';
  if (has('pest', 'exterminator')) return 'pest_control';
  if (has('water', 'sewer', 'electric', 'gas', 'utility', 'utilities', 'convergent', 'rubs')) {
    return 'utility';
  }
  // Before the concession test, which would otherwise claim these for "credit".
  if (has('credit builder', 'creditbuilder', 'credit report', 'creditreport')) {
    return 'credit_builder';
  }
  if (has('deposit waiver', 'surety', 'rhino', 'deposit alternative')) return 'deposit_waiver';
  if (has('admin', 'service fee', 'resident service', 'amenity', 'move-in', 'move in', 'application')) {
    return 'admin_fee';
  }
  if (has('mtm', 'month-to-month', 'month to month')) return 'mtm_fee';
  if (has('damage', 'repair', 'charge back', 'chargeback')) return 'damages';
  if (has('real estate tax', 'property tax', 'tax recovery', 'tax reimbursement', 'realestatetax')) {
    return 'tax_recovery';
  }
  // An insurance/liability WAIVER is a FEE billed to the resident, not a
  // concession. This is the bug the whole exercise started from: the old rule
  // matched "waive" inside "waiver" and booked the revenue as a rent reduction.
  // Routing insurance/liability explicitly here — and dropping "waive"/"waiver"
  // from the concession list below — is the targeted fix.
  if (has('insurance', 'liability', 'pdlw')) return 'other_income';

  // Reimbursed credits BEFORE concessions: a rent-exemption credit reads as a
  // discount to the tenant, so the concession test below would claim every one
  // of them. The distinction is who absorbs the reduction — here a third party
  // does, so the owner's collectible rent is unchanged. "abatement" moved off
  // the concession list for exactly this reason: an exemption credit IS a tax
  // abatement, and calling it a concession asserts the owner ate a cost the
  // city actually reimbursed.
  //
  // Deliberately NARROW. Only named programs and unambiguous "reimbursed by a
  // third party" wording land here; anything vaguer is left to the per-document
  // classifier, which can see the sign, magnitude and neighbouring codes. A
  // false positive here silently RAISES rent, so the prior must be conservative.
  if (has('scrie', 'drie', 'senior citizen rent increase', 'disability rent increase',
          'rent increase exemption', 'tax abatement', 'abatement credit', 'j-51', 'j51')) {
    return 'reimbursed_credit';
  }

  // Concessions last. "waive"/"waiver" deliberately absent (see above);
  // "credit" is claimed earlier when it means credit reporting.
  if (has('concession', 'discount', 'credit', 'free', 'courtesy', 'preferential')) {
    return 'concession';
  }

  return 'other';
}

/**
 * Create a UnitCharge object from raw code and amount
 */
export function createCharge(code: string, amount: number): UnitCharge {
  return {
    code,
    amount,
    category: normalizeChargeCode(code),
  };
}

/**
 * Aggregate charges across all units into a property-level summary
 */
export function aggregateCharges(
  units: Array<{ charges?: UnitCharge[] }>
): {
  summary: ChargeCategorySummary[];
  totalAmount: number;
} {
  const categoryMap = new Map<
    ChargeCategory,
    { totalAmount: number; unitCount: number; rawCodes: Set<string> }
  >();

  let totalAmount = 0;

  for (const unit of units) {
    if (!unit.charges) continue;

    // Track which categories this unit has (for unitCount)
    const unitCategories = new Set<ChargeCategory>();

    for (const charge of unit.charges) {
      // Rent lines are the rent totals' business, not the charge summary's.
      if (RENT_CLASS_CATEGORIES.has(charge.category)) continue;

      // Only KNOWN ancillary income counts toward the total. Rent adjustments
      // and `other` stay listed but are excluded:
      //  - adjustments are reductions against rent, not income;
      //  - `other` means "not identified", and summing unidentified codes into
      //    an income figure is the very error this function had. Measured on 9
      //    charge-block documents, unclassified codes included 344 lines of
      //    "rnt" ($365,522) and 28 of "comm" ($256,703) — base rent that would
      //    land in ancillary income purely for want of a category.
      // Failure mode is now a visible understatement (with the `other` row
      // right there in the summary) instead of a silent 15x overstatement.
      if (!RENT_ADJUSTMENT_CATEGORIES.has(charge.category) && charge.category !== 'other') {
        totalAmount += charge.amount;
      }
      unitCategories.add(charge.category);

      let entry = categoryMap.get(charge.category);
      if (!entry) {
        entry = { totalAmount: 0, unitCount: 0, rawCodes: new Set() };
        categoryMap.set(charge.category, entry);
      }

      entry.totalAmount += charge.amount;
      entry.rawCodes.add(charge.code);
    }

    // Increment unit count for each category this unit has
    for (const cat of unitCategories) {
      const entry = categoryMap.get(cat);
      if (entry) entry.unitCount++;
    }
  }

  // Convert to array and sort by total amount descending
  const summary: ChargeCategorySummary[] = Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      totalAmount: Math.round(data.totalAmount * 100) / 100,
      unitCount: data.unitCount,
      rawCodes: Array.from(data.rawCodes).sort(),
    }))
    .sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount));

  return {
    summary,
    totalAmount: Math.round(totalAmount * 100) / 100,
  };
}
