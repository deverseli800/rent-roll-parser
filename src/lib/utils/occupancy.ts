/**
 * Single source of truth for reconciling extracted units against a
 * document's stated summary (occupied count, total rent, occupancy rate).
 *
 * Rent rolls virtually always roll notice-to-vacate units into their stated
 * "occupied" count (the tenant is still in place and paying), and property
 * management systems are inconsistent about whether model/down/admin units
 * count as occupied. The extraction deliberately keeps these as separate
 * statuses, so any comparison against a stated occupied count must:
 *
 *   1. count occupied + notice together ("physically occupied"), and
 *   2. treat model/down/applicant units as slack — a stated count that is
 *      within that many units of the physical count is fully explained by
 *      definitional differences, not extraction error.
 *
 * Consumers:
 *   - extractionCore.verifyAgainstStated  (model-escalation ladder)
 *   - validation/verification.ts          (UI "Verification Checks" panel)
 *   - validation/validators.ts            (summary-mismatch issues)
 *   - extraction page Summary Statistics  (stated vs calculated comparison)
 */

export interface UnitCountReconciliation {
  ok: boolean;
  /** Which reading of the stated count matched: every extracted row, unit rows
   * only (excluding non_unit_income lines), or residential units only. */
  interpretation: 'all' | 'counted_units' | 'residential_only' | null;
}

/**
 * A document's stated unit count doesn't always cover every extracted row:
 * mixed-use summaries often state the residential-only count ("41 units" plus
 * 4 stores extracted separately), and some totals exclude ancillary income
 * lines. Accept the stated count when it exactly matches one of those narrower
 * readings instead of failing — and re-extracting — a correct result.
 */
export function reconcileUnitCount(
  stated: number,
  units: { category?: string | null; includeInUnitCount?: boolean | null }[]
): UnitCountReconciliation {
  if (units.length === stated) return { ok: true, interpretation: 'all' };
  const counted = units.filter(u => u.includeInUnitCount !== false).length;
  if (counted === stated) return { ok: true, interpretation: 'counted_units' };
  const residential = units.filter(u => u.category === 'residential').length;
  if (residential > 0 && residential < units.length && residential === stated) {
    return { ok: true, interpretation: 'residential_only' };
  }
  return { ok: false, interpretation: null };
}

export interface StatusCounts {
  occupied: number;
  vacant: number;
  notice: number;
  model: number;
  down: number;
  applicant: number;
}

/** Count units per status. Accepts anything with a `status` field. */
export function countByStatus(units: { status: string }[]): StatusCounts {
  const counts: StatusCounts = { occupied: 0, vacant: 0, notice: 0, model: 0, down: 0, applicant: 0 };
  for (const u of units) {
    if (u.status in counts) counts[u.status as keyof StatusCounts]++;
  }
  return counts;
}

/** Occupied + notice: units with a tenant physically in place. */
export function physicallyOccupiedCount(counts: StatusCounts): number {
  return counts.occupied + counts.notice;
}

export interface OccupiedReconciliation {
  ok: boolean;
  /** occupied + notice */
  physical: number;
  /** model + down + applicant — units a document may or may not call occupied */
  slack: number;
  /** |stated − whichever accepted reading is closest| (see reconcileOccupiedCount) */
  diff: number;
  /** Human-readable reconciliation, e.g. "210 occupied + 17 notice = 227; stated 228 is within the 2 model/down/applicant units" */
  explanation: string;
}

/**
 * Reconcile a document's stated occupied count against extracted status
 * counts. Accepts either occupancy convention — occupied+notice, or occupied
 * alone with notice counted separately — and passes when the closer reading's
 * difference is fully explained by ambiguous non-revenue units (with a floor
 * of 1 for snapshot/rounding noise).
 */
export function reconcileOccupiedCount(
  stated: number,
  counts: StatusCounts
): OccupiedReconciliation {
  const physical = physicallyOccupiedCount(counts);
  const slack = counts.model + counts.down + counts.applicant;
  // Documents disagree on whether on-notice units count as occupied. A
  // "Totals" line usually folds them in; an occupancy-status breakdown lists
  // "Occupied" strictly and gives On-Notice its own row. One document often
  // prints BOTH (e.g. a RealPage detail export stating 384 on the totals row
  // and 361 occupied + 19 + 4 on-notice in the summary block), so which figure
  // gets read back is arbitrary. Accept whichever reading the stated number
  // matches rather than assuming occupied+notice.
  const strictOnly = counts.notice > 0 ? counts.occupied : null;
  const diff = Math.min(
    Math.abs(stated - physical),
    strictOnly === null ? Infinity : Math.abs(stated - strictOnly)
  );
  const ok = diff <= Math.max(1, slack);
  const viaStrict = strictOnly !== null && Math.abs(stated - strictOnly) < Math.abs(stated - physical);

  const parts = [`${counts.occupied} occupied`];
  if (counts.notice > 0) parts.push(`${counts.notice} notice`);
  const breakdown = `${parts.join(' + ')} = ${physical}`;

  let explanation: string;
  if (diff === 0 && viaStrict) {
    explanation = `${counts.occupied} occupied, matches stated ${stated}; the ${counts.notice} notice unit${counts.notice === 1 ? ' is' : 's are'} counted separately by this document`;
  } else if (diff === 0) {
    explanation = `${breakdown}, matches stated ${stated}`;
  } else if (ok) {
    explanation = slack > 0
      ? `${breakdown}; stated ${stated} is within the ${slack} model/down/applicant unit${slack === 1 ? '' : 's'} the document may count as occupied`
      : `${breakdown}; stated ${stated} differs by ${diff} (within snapshot tolerance)`;
  } else {
    explanation = strictOnly === null
      ? `${breakdown} vs stated ${stated} (diff ${diff}, exceeds the ${slack} ambiguous model/down/applicant units)`
      : `neither ${strictOnly} occupied nor ${physical} occupied+notice matches stated ${stated} (closest diff ${diff}, exceeds the ${slack} ambiguous model/down/applicant units)`;
  }

  return { ok, physical, slack, diff, explanation };
}

export interface VacantReconciliation {
  ok: boolean;
  /** strictly vacant units */
  vacant: number;
  /** applicant + model + down — physically empty units a document may count as vacant */
  slack: number;
  /** |stated − vacant| */
  diff: number;
  /** Human-readable reconciliation, e.g. "12 vacant + 5 applicant = 17, matches stated 17" */
  explanation: string;
}

/**
 * Reconcile a document's stated vacant count against extracted status counts.
 * The mirror of reconcileOccupiedCount: documents usually roll units with
 * pending applicants (and sometimes model/down units) into their stated
 * "vacant" count — the unit is physically empty — while the extraction keeps
 * them as separate statuses.
 */
export function reconcileVacantCount(
  stated: number,
  counts: StatusCounts
): VacantReconciliation {
  const vacant = counts.vacant;
  const slack = counts.applicant + counts.model + counts.down;
  const diff = Math.abs(stated - vacant);
  const ok = diff <= Math.max(1, slack);

  let explanation: string;
  if (diff === 0) {
    explanation = `${vacant} vacant, matches stated ${stated}`;
  } else if (stated - vacant === counts.applicant && counts.applicant > 0) {
    explanation = `${vacant} vacant + ${counts.applicant} applicant = ${stated}, matches stated ${stated} — the document counts units with pending applicants as vacant`;
  } else if (ok) {
    explanation = slack > 0
      ? `${vacant} vacant; stated ${stated} is within the ${slack} applicant/model/down unit${slack === 1 ? '' : 's'} the document may count as vacant`
      : `${vacant} vacant; stated ${stated} differs by ${diff} (within snapshot tolerance)`;
  } else {
    explanation = `${vacant} vacant vs stated ${stated} (diff ${diff}, exceeds the ${slack} ambiguous applicant/model/down units)`;
  }

  return { ok, vacant, slack, diff, explanation };
}

// Defined in types.ts so the verification output can carry it; imported and
// re-exported here because reconcileTotalRent is the only thing that builds one.
import type { RentReconciliation } from '../types';
export type { RentReconciliation };

/**
 * Reconcile a document's stated total monthly rent against the calculated
 * tenant rent (occupied + notice). Stated totals often include bookkeeping
 * charges on non-tenant units (market rent booked to the model apartment,
 * admin units) — when the gap is exactly that, it's a definition difference,
 * not an extraction error.
 */
export function reconcileTotalRent(
  stated: number,
  tenantRent: number,
  nonTenantRent: number | null | undefined,
  // Owner-borne reductions (negative) and the subsidy portion, when known.
  // Used to name a convention difference precisely instead of guessing at it.
  ownerBorneReductions?: number | null,
  subsidyRent?: number | null
): RentReconciliation {
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const diff = Math.abs(stated - tenantRent);
  const base = { exact: false, reconciledByNonTenantRent: false, diff };

  if (diff <= 1) {
    return {
      ...base, ok: true, exact: true, basis: 'exact', residual: 0, components: [],
      explanation: `${fmt(tenantRent)} matches stated ${fmt(stated)}`,
    };
  }

  const nonTenant = nonTenantRent ?? 0;
  const nonTenantResidual = Math.abs(stated - (tenantRent + nonTenant));
  if (nonTenant > 0 && nonTenantResidual <= Math.max(5, stated * 0.005)) {
    return {
      ...base, ok: true, reconciledByNonTenantRent: true, basis: 'non_tenant_rent',
      residual: r2(nonTenantResidual),
      components: [{ label: 'rent booked to non-tenant units (model/down/vacant)', amount: r2(nonTenant) }],
      explanation: `The document's stated total includes ${fmt(nonTenant)} booked to non-tenant units (model/down/vacant), which the calculated total excludes: ${fmt(tenantRent)} tenant rent + ${fmt(nonTenant)} = ${fmt(stated)} stated`,
    };
  }

  // Convention difference. The calculated figure is the rent the OWNER
  // COLLECTS, so owner-borne reductions are already out of it and third-party
  // subsidy is already in it. Documents commonly total the same underlying data
  // gross of those reductions, or as the tenant's share alone, or both. When one
  // of those reconstructions lands on the stated figure, the two agree and only
  // the framing differs — name which, rather than reporting an unexplained gap.
  //
  // Measured on a 15-document corpus: of 8 files whose totals stopped matching
  // exactly once monthlyRent became owner-collected, 7 were accounted for to the
  // CENT by one of these three reconstructions. Naming the reason is the whole
  // point — the previous fallback passed anything under 1% while guessing
  // "possibly other income or rounding", which was both unfalsifiable and, on
  // every one of those 7 files, wrong.
  const reductions = ownerBorneReductions ?? 0;
  const subsidy = subsidyRent ?? 0;
  const variants: { label: string; value: number; parts: { label: string; amount: number }[] }[] = [
    {
      label: 'gross of owner-borne concessions/discounts',
      value: tenantRent - reductions,
      parts: [{ label: 'owner-borne concessions/discounts added back', amount: r2(-reductions) }],
    },
    {
      label: "the tenant's share only (excludes subsidy)",
      value: tenantRent - subsidy,
      parts: [{ label: 'third-party subsidy removed', amount: r2(-subsidy) }],
    },
    {
      label: "the tenant's share, gross of owner-borne concessions/discounts",
      value: tenantRent - reductions - subsidy,
      parts: [
        { label: 'owner-borne concessions/discounts added back', amount: r2(-reductions) },
        { label: 'third-party subsidy removed', amount: r2(-subsidy) },
      ],
    },
  ];
  // BEST match, not the first: these reconstructions overlap, so a document
  // whose total is the tenant's share AND gross of reductions also lands within
  // tolerance of the gross-only variant. Taking the first would name the wrong
  // convention and leave the subsidy as an unexplained residual while still
  // reporting the gap as explained — which is exactly the vagueness this
  // decomposition exists to remove.
  const tol = Math.max(5, stated * 0.005);
  const hit = variants
    .filter(v => v.value !== tenantRent && Math.abs(stated - v.value) <= tol)
    .sort((a, b) => Math.abs(stated - a.value) - Math.abs(stated - b.value))[0];
  if (hit) {
    return {
      ...base, ok: true, basis: 'convention', residual: r2(Math.abs(stated - hit.value)),
      components: hit.parts,
      explanation: `${fmt(tenantRent)} owner-collected rent vs stated ${fmt(stated)} — the document quotes ${hit.label}, which reconciles (${fmt(hit.value)}). A convention difference, not a discrepancy; the reductions and subsidy are reported per unit.`,
    };
  }

  // Under tolerance but NOT accounted for. This still passes — the threshold is
  // load-bearing for documents whose totals carry rounding or income lines we do
  // not model — but it must not read like agreement. Everything above names a
  // reason; this one is explicitly an unexplained residual, so a reader can tell
  // a reconciled total from a merely tolerated one.
  if (diff <= stated * 0.01) {
    return {
      ...base, ok: true, basis: 'unexplained_in_tolerance', residual: r2(diff), components: [],
      explanation: `${fmt(tenantRent)} vs stated ${fmt(stated)} — a ${fmt(diff)} difference (${(100 * diff / stated).toFixed(2)}%) that is UNDER the 1% tolerance but NOT accounted for by non-tenant rent, concessions or subsidy. Passing on tolerance alone; the residual is unexplained.`,
    };
  }

  return {
    ...base, ok: false, basis: 'mismatch', residual: r2(diff), components: [],
    explanation: `${fmt(tenantRent)} vs stated ${fmt(stated)} (diff ${fmt(diff)}) — not accounted for by non-tenant rent, concessions or subsidy`,
  };
}

/**
 * Normalize a stated occupancy rate to a 0–100 percentage.
 *
 * Excel stores percent-formatted cells as fractions (92.31% -> 0.9231), so a
 * stated rate ≤ 1 is a fraction, not a sub-1% occupancy. (A genuinely ≤1%
 * occupied property would be an empty building — if that ever happens, the
 * occupied-count checks will surface it.)
 */
export function normalizeOccupancyRatePct(rate: number | null): number | null {
  if (rate === null) return null;
  return rate > 0 && rate <= 1 ? rate * 100 : rate;
}
