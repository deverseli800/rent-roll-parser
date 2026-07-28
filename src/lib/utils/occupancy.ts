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
  /** |stated − physical| */
  diff: number;
  /** Human-readable reconciliation, e.g. "210 occupied + 17 notice = 227; stated 228 is within the 2 model/down/applicant units" */
  explanation: string;
}

/**
 * Reconcile a document's stated occupied count against extracted status
 * counts. Passes when the difference is fully explained by ambiguous
 * non-revenue units (with a floor of 1 for snapshot/rounding noise).
 */
export function reconcileOccupiedCount(
  stated: number,
  counts: StatusCounts
): OccupiedReconciliation {
  const physical = physicallyOccupiedCount(counts);
  const slack = counts.model + counts.down + counts.applicant;
  const diff = Math.abs(stated - physical);
  const ok = diff <= Math.max(1, slack);

  const parts = [`${counts.occupied} occupied`];
  if (counts.notice > 0) parts.push(`${counts.notice} notice`);
  const breakdown = `${parts.join(' + ')} = ${physical}`;

  let explanation: string;
  if (diff === 0) {
    explanation = `${breakdown}, matches stated ${stated}`;
  } else if (ok) {
    explanation = slack > 0
      ? `${breakdown}; stated ${stated} is within the ${slack} model/down/applicant unit${slack === 1 ? '' : 's'} the document may count as occupied`
      : `${breakdown}; stated ${stated} differs by ${diff} (within snapshot tolerance)`;
  } else {
    explanation = `${breakdown} vs stated ${stated} (diff ${diff}, exceeds the ${slack} ambiguous model/down/applicant units)`;
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

export interface RentReconciliation {
  ok: boolean;
  /** stated equals tenant rent exactly (within $1) — no explanation needed */
  exact: boolean;
  /** the difference is exactly the rent booked on non-tenant units */
  reconciledByNonTenantRent: boolean;
  diff: number;
  /** Human-readable reconciliation, e.g. "$476,705 tenant rent + $2,409 charged to model/down units = stated $479,114" */
  explanation: string;
}

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
  nonTenantRent: number | null | undefined
): RentReconciliation {
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const diff = Math.abs(stated - tenantRent);

  if (diff <= 1) {
    return {
      ok: true, exact: true, reconciledByNonTenantRent: false, diff,
      explanation: `${fmt(tenantRent)} matches stated ${fmt(stated)}`,
    };
  }

  const nonTenant = nonTenantRent ?? 0;
  const residual = Math.abs(stated - (tenantRent + nonTenant));
  if (nonTenant > 0 && residual <= Math.max(5, stated * 0.005)) {
    return {
      ok: true, exact: false, reconciledByNonTenantRent: true, diff,
      explanation: `The document's stated total includes ${fmt(nonTenant)} booked to non-tenant units (model/down/vacant), which the calculated total excludes: ${fmt(tenantRent)} tenant rent + ${fmt(nonTenant)} = ${fmt(stated)} stated`,
    };
  }

  if (diff <= stated * 0.01) {
    return {
      ok: true, exact: false, reconciledByNonTenantRent: false, diff,
      explanation: `${fmt(tenantRent)} vs stated ${fmt(stated)} — the ${fmt(diff)} difference is under 1% and not attributable to specific units (possibly other income or rounding in the document's total)`,
    };
  }

  return {
    ok: false, exact: false, reconciledByNonTenantRent: false, diff,
    explanation: `${fmt(tenantRent)} vs stated ${fmt(stated)} (diff ${fmt(diff)})`,
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
