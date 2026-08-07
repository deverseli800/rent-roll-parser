# Rent Roll Parser Eval Spec

## Corpus
`eval/corpus/` holds unique rent-roll files collected from a local document
library (excluding rent-regulation registrations, blank templates,
misclassified documents, and content duplicates), deduped by content hash.
Provenance is recorded in `eval/corpus-manifest.json`.

**The corpus contains real documents with tenant PII and client property data.**
`eval/corpus/`, `eval/groundtruth/`, `eval/runs/` and `eval/corpus-manifest.json`
are all gitignored and must stay that way. Never quote a real filename, property
name, address or tenant name in a tracked file — including in this spec, in code
comments, or in results tables.

## Ground truth
One JSON file per corpus file: `eval/groundtruth/<corpus-id>.json`.

```jsonc
{
  "corpusId": "02__example_rent_roll.xlsx",
  // Fields the DOCUMENT actually provides per unit. Only these get graded.
  // Allowed: status, monthlyRent, tenantName, unitSqft, unitType,
  //          leaseStartDate, leaseEndDate, moveInDate, moveOutDate,
  //          category, regulation, charges
  "documentFields": ["status", "monthlyRent", "tenantName", "leaseEndDate"],
  "statedUnitCount": 16,          // total units stated IN the document, or null
  "statedTotalMonthlyRent": 41000.5, // stated total rent IN the document, or null
  "units": [
    {
      "unitNumber": "2A",          // exactly as shown in the document
      "status": "occupied",        // occupied|vacant|notice|model|down|applicant
      "monthlyRent": 2500,          // actual/current monthly rent; null if blank
      "acceptableRents": [2500, 2450.5], // OPTIONAL: alternative defensible values
                                    // (e.g., legal vs preferential rent, with/without
                                    // subsidy). Include ONLY when genuinely ambiguous.
      "tenantName": "Smith, John",  // as shown; null if blank or placeholder (VACANT)
      "unitSqft": null,
      "unitType": "1BR/1BA",        // as shown (bed/bath, floorplan code, or use type
                                    // like "Store"/"Office" for commercial)
      "leaseStartDate": "2024-06-01", // ISO YYYY-MM-DD, null if blank
      "leaseEndDate": "2025-05-31",
      "moveInDate": null,
      "moveOutDate": null,
      "category": "residential",    // OPTIONAL: 'residential' | 'commercial' |
                                    // 'non_unit_income' (parking/antenna/laundry/
                                    // storage/signage). Graded only when
                                    // 'category' is in documentFields.
      "regulation": "RS",           // OPTIONAL: the rent-regulation / lease-type
                                    // value printed for this unit, VERBATIM
                                    // ("RS", "FM", "Decontrolled", "MRKT", ...).
                                    // Graded (when 'regulation' is in
                                    // documentFields) by checking the parser
                                    // preserved it in the unit's sourceColumns
                                    // passthrough — the engine is NOT expected to
                                    // interpret it. null when the document shows
                                    // no regulation value for the unit.
      "charges": [                  // OPTIONAL: for charge-block documents, the
        { "code": "rent", "amount": 9995 },     // itemized charge lines printed for
        { "code": "storage", "amount": 200 }    // this unit, VERBATIM (code as
      ]                             // printed, amount with sign as displayed),
                                    // EXCLUDING the "Charge Total" line. Graded
                                    // (when 'charges' is in documentFields) as
                                    // CAPTURE: every listed line must appear in
                                    // the extracted unit's charges with matching
                                    // code and amount (to the cent); extra
                                    // extracted lines are NOT penalized, so a GT
                                    // may list only the lines that matter (e.g.
                                    // just the non-rent ones). null when the
                                    // document prints no itemized charges for
                                    // this unit.
    }
  ],
  "verification": {
    "unitCountMatchesStated": true,   // units.length vs statedUnitCount
    "rentSumMatchesStated": true,     // sum(monthlyRent) vs statedTotalMonthlyRent (±$2)
    "notes": "any discrepancies explained here"
  },
  "confidence": "high",            // high|medium|low — GT author's own confidence
  "notes": "quirks of this document worth knowing for scoring disputes"
}
```

### Ground-truth rules
- Include EVERY unit in the document, including vacant, commercial (stores,
  offices, professional space), superintendent units, parking if listed as units.
- Do NOT include: summary rows, subtotal rows, charge line items, unit-TYPE
  aggregate sections, future/applicant duplicate rows (choose one row per unit —
  prefer the current-occupancy row; note the duplicate in `notes`).
- Multi-sheet workbooks (proformas, portfolio workbooks): ground truth covers the
  rent-roll content of the WHOLE workbook (all properties' units) — a correct
  parser should extract all units in the file. Record sheet context in `notes`.
- `status`: infer from the document. Tenant present = occupied. "VACANT"/blank
  tenant + no rent = vacant. Notice/NTV = notice. If doc marks employee/super
  units, they are occupied (rent may be 0/null).
- `monthlyRent`: MONTHLY actual rent. If document shows annual, divide by 12 and
  add both to `acceptableRents` if it is ambiguous which one a parser should
  report. If multiple rent columns exist (legal/preferential/actual), the actual
  collected rent is canonical; put other defensible columns in `acceptableRents`.
- Names: copy as displayed (don't reorder "Last, First").
- Verify: unit count vs stated count; sum of rents vs stated total. Record in
  `verification`. If they don't match, re-read the document until you can explain.

## Scoring (eval/score.ts)
Per file:
- **Unit alignment** by normalized unit number (uppercase; strip spaces, `#`,
  `UNIT`/`APT` prefixes, punctuation; strip leading zeros in numeric runs;
  for multi-property files also try building-prefix stripping).
- Cells graded:
  - 1 "presence" cell per GT unit: correct if a matching extracted unit exists.
  - 1 penalty cell per hallucinated extracted unit (never correct).
  - For each matched unit: one cell per field in `documentFields`.
- Field comparison:
  - status: exact enum match, EXCEPT both-of {occupied, notice} pairs count as
    correct if leaseStatus preserved the raw text (secondary detail), and
    'applicant' vs 'vacant' on the same unit is correct either way.
  - monthlyRent/unitSqft: |a-b| <= max(1, 0.5% of GT) or matches any acceptableRents.
    null==null correct; null vs value wrong.
  - tenantName: normalized token-set equality (lowercase, strip punctuation,
    order-insensitive) or Levenshtein similarity >= 0.85. Placeholder names
    ("VACANT", "AVAILABLE") are treated as null.
  - unitType: normalized loose match (case/punct-insensitive containment either way).
  - dates: exact ISO date equality.
  - category: exact match of the extracted unit's `category` (null==null correct).
  - regulation: passes when the GT verbatim value appears in the extracted unit's
    `sourceColumns` (normalized equality/containment). Tests CAPTURE of the
    regulation/lease-type column, not interpretation. A null GT value is trivially
    correct (nothing to capture).
  - charges: passes when every GT charge line has a matching line in the
    extracted unit's `charges` — normalized code equality/containment plus
    amount to the cent, multiset semantics (duplicate lines need duplicate
    captures). Extra extracted lines are not penalized. A null/empty GT list is
    trivially correct. Tests CAPTURE of the itemized charge block, one cell per
    unit.
- File accuracy = correct cells / total cells.
- **Overall accuracy = macro average of file accuracies** (target >= 95%).
  Micro (cell-weighted) also reported.
