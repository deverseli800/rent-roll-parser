/**
 * The override gate: a keyword-pinned 'concession' must be correctable to
 * 'reimbursed_credit', while tier-2 buckets stay locked as before.
 */
import { gateProposal } from '../../src/lib/utils/chargeClassifier';
import type { ChargeCategory } from '../../src/lib/types';

const cases: [ChargeCategory, ChargeCategory, string][] = [
  // The fix this whole change depends on — without it the new category is a no-op
  // for every code the keyword layer already claims.
  ['concession', 'reimbursed_credit', 'accept'],
  ['reimbursed_credit', 'concession', 'accept'],

  // The empirically justified lockout is intact.
  ['admin_fee', 'other_income', 'decline'],
  ['base_rent', 'other_income', 'decline'],
  ['other_income', 'base_rent', 'decline'],
  ['pet', 'parking', 'decline'],

  // Reductions may not escape into income, or vice versa.
  ['concession', 'other_income', 'decline'],
  ['other_income', 'reimbursed_credit', 'decline'],
  ['subsidy', 'reimbursed_credit', 'decline'],

  // Abstention still yields to the model.
  ['other', 'utility', 'accept'],
  ['other', 'reimbursed_credit', 'accept'],
  ['other', 'other', 'noop'],

  // Agreement is a no-op.
  ['concession', 'concession', 'noop'],
];

let failed = 0;
for (const [from, to, want] of cases) {
  const got = gateProposal(from, to);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${from} -> ${to}`.padEnd(58) + `${got}${ok ? '' : `  (want ${want})`}`);
}
console.log(failed === 0 ? '\noverride gate OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
