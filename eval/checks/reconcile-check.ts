/**
 * reconcileTotalRent: does it NAME the reason a total differs, or merely
 * tolerate it?
 *
 * The amounts are the real corpus figures the decomposition was built from, so
 * a regression here is a regression against observed documents rather than an
 * invented case.
 */
import { reconcileTotalRent } from '../../src/lib/utils/occupancy';

type Case = {
  name: string;
  args: [number, number, number | null, number?, number?]; // stated, tenantRent, nonTenant, reductions, subsidy
  basis: string;
  ok: boolean;
};

const cases: Case[] = [
  {
    name: 'exact match',
    args: [78573.90, 78573.90, 0],
    basis: 'exact', ok: true,
  },
  {
    // Real: stated total is gross of concessions the owner absorbs.
    name: 'gross of owner-borne reductions (360-unit roll)',
    args: [365522, 360275, 0, -5247, 0],
    basis: 'convention', ok: true,
  },
  {
    // Real: stated is the tenant's share AND gross of reductions.
    //   678,072 owner-collected = base + 1,835 subsidy - 5,367 reductions
    //   stated 681,604 = base
    name: "tenant's share, gross of reductions (386-unit roll)",
    args: [681604, 678072, 0, -5367, 1835],
    basis: 'convention', ok: true,
  },
  {
    name: 'non-tenant rent booked into the stated total',
    args: [479114, 476705, 2409],
    basis: 'non_tenant_rent', ok: true,
  },
  {
    // The case the old code called "possibly other income or rounding".
    // It still PASSES — the tolerance is load-bearing — but must now say
    // plainly that nothing accounts for it.
    name: 'under 1% but unexplained — passes, but says so',
    args: [500000, 497500, 0, 0, 0],
    basis: 'unexplained_in_tolerance', ok: true,
  },
  {
    name: 'large and unaccounted for',
    args: [500000, 400000, 0, 0, 0],
    basis: 'mismatch', ok: false,
  },
];

let failed = 0;
for (const c of cases) {
  const r = reconcileTotalRent(...c.args);
  const ok = r.basis === c.basis && r.ok === c.ok;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        basis=${r.basis} ok=${r.ok} residual=${r.residual}${ok ? '' : `  (want basis=${c.basis} ok=${c.ok})`}`);
  if (r.components.length) {
    console.log(`        components: ${r.components.map(x => `${x.label} ${x.amount}`).join(' | ')}`);
  }
}

// A fully-named reconciliation must leave nothing over; a tolerated one must
// report exactly what it could not explain.
const conv = reconcileTotalRent(681604, 678072, 0, -5367, 1835);
const named = Math.abs(conv.residual) <= 0.02;
console.log(`${named ? 'PASS' : 'FAIL'}  a 'convention' basis leaves no residual`);
if (!named) failed++;

const tol = reconcileTotalRent(500000, 497500, 0, 0, 0);
const reports = Math.abs(tol.residual - 2500) <= 0.02;
console.log(`${reports ? 'PASS' : 'FAIL'}  an unexplained pass reports its residual (${tol.residual})`);
if (!reports) failed++;

console.log(failed === 0 ? '\nreconciliation OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
