import { normalizeChargeCode } from '../../src/lib/utils/chargeNormalization';

const cases: [string, string][] = [
  // Reimbursed credits — the prior must catch NAMED programs...
  ['SCRIE', 'reimbursed_credit'],
  ['Scrie', 'reimbursed_credit'],
  ['SCRIE Credit', 'reimbursed_credit'],           // would have been 'concession' via "credit"
  ['DRIE-Disability Rent Increase Exemption', 'reimbursed_credit'],
  ['Tax Abatement Credit', 'reimbursed_credit'],   // "abatement" no longer means concession
  ['J-51 Abatement', 'reimbursed_credit'],

  // ...and leave everything vaguer to the per-document classifier.
  ['SCR', 'other'],
  ['CON', 'other'],
  ['RR', 'other'],
  ['Pref', 'other'],
  ['PREF', 'other'],

  // Owner-borne reductions stay concessions.
  ['PRD-Preferred Rent Discount', 'concession'],
  ['Preferential Rent', 'concession'],
  ['CONC-Concession', 'concession'],
  ['Courtesy Credit', 'concession'],

  // Regressions guarded by existing comments in the file.
  ['MLIW-Mandatory Liability Insurance Waiver', 'other_income'],
  ['Credit Builder', 'credit_builder'],
  ['RENT-Rent', 'base_rent'],
  ['HAP-Housing Assistance Payment', 'subsidy'],
  // Bare "LTOL" has no separator, so splitCode sets no abbrev and the
  // `a === 'ltol'` rule cannot fire — it falls to 'other' for the classifier,
  // which is the documented design. The separator form does match.
  ['LTOL', 'other'],
  ['LTOL-Loss to Lease', 'loss_to_lease'],
  ['petrent', 'pet'],
];

let failed = 0;
for (const [code, want] of cases) {
  const got = normalizeChargeCode(code);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${code.padEnd(42)} -> ${got}${ok ? '' : `  (want ${want})`}`);
}
console.log(failed === 0 ? '\nkeyword prior OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
