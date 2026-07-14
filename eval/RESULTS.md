# Rent Roll Parser — Eval Results

## Batch 3 update (2026-07-12): first-contact pass

7 more institutional files (ids 78-84: Yardi one-row and charge-block exports,
a OneSite .xls, a 53-column wide WPM-style roll; 1,966 units total; 5 exact
duplicates in the drop were hash-deduped for free). **First-pass score with NO
parser iteration: 99.19% macro, 7/7 files >= 95%, 1,966/1,966 units found, zero
hallucinations.** The only pre-parse change was making the column cap dynamic
(the wide file had data past the old 40-column limit — caught by inspection
before parsing). Full 76-file corpus: 99.65% macro, 76/76 >= 95%
(`eval/runs/v4-final-76/`).


## Batch 2 update (2026-07-11/12): due-diligence institutional rolls

23 files from `./data/dd-rolls` added to the corpus
(ids 55-77): Yardi/RealPage/ResMan/OneSite institutional exports (200-576 units,
sheets up to 3,930 rows), charge-block formats (one unit = several charge rows +
a Charge Total), a HUD roll with RESIDENT+SUBSIDY row pairs, wide 40-76 column
detail rolls, a retail roll, an underwriting .xlsm with four duplicate views of
the same roll, 12-43 page PDFs, and a 30-page scanned/OCR PDF.

**Final (fresh verification run, 69 files): macro 99.70%, 69/69 files >= 95%,
zero hallucinated units, worst field 98.0%.** First pass on the new batch
scored 97.8% macro; the iteration fixes that closed the gap:

- Charge-block rule made explicit: monthlyRent = the Rent charge row (plus
  rent-subsidy rows), NEVER the "Charge Total" line (all three models grabbed
  Charge Total on the scanned Scanned Garden Apts PDF until told exactly this).
- Lazy-extraction detection: verification now flags optional fields that are
  populated early but empty later (model fatigue on 300+ unit documents) and
  fields with near-zero date coverage on large rolls, triggering a retry with
  targeted feedback.
- Deterministic column hints: the Excel parser reads the header region and
  tells the model which optional columns exist in the sheet.
- Diagnostic verification feedback: rent-sum mismatches now say what they imply
  (sum too high -> "you used total charges/market rent"; too low -> "missed
  units or tenant-paid portion").
- Sheet triage: bigger token budget (thinking shares it), never fatal (falls
  back to all candidate sheets), and prefers actual-rent views over
  scheduled/market/zeroed duplicate views of the same roll.

Archived runs: `eval/runs/v3-final-69/` (final), `eval/runs/batch2-run1-fixed/`.

---

# Batch 1 — NYC appraisal corpus (2026-07-10/11 overnight)

Goal: reliably >= 95% field-level extraction accuracy on the rent rolls in
`./data/appraisals` (DHCR documents excluded).

## Headline

| | Old parser (v1) | New parser (v2) |
|---|---|---|
| Macro accuracy (avg per-file) | **64.5%** | **99.87%** |
| Micro accuracy (all graded cells) | 65.1% | 99.84% |
| Files >= 95% | 21 / 46 | **46 / 46** |
| Hard crashes | 12 / 46 | 0 |
| Hallucinated units | 17 | 0 real (1 alignment artifact) |

v2 numbers are from a fully fresh, uncached run of the final code
(`eval/runs/v2-final/`). An independent earlier full run scored 99.93% macro —
run-to-run variance stays well above the 95% bar. Worst file in the final run:
96.6% (a scanned, photographed rent roll).

## Corpus (46 files)

Collected via the document classifier indexes (`document-index.json`) across 20
appraisal projects; deduped by content hash; excluded DHCR registrations (per
instruction), blank bank templates, re-saved duplicate copies, one offering
memo, one lease-expiration listing, and three NYC housing-db property records.
Full provenance: `eval/corpus-manifest.json`.

Coverage: AppFolio/MRI/SSRS system exports, hand-built owner spreadsheets,
multi-sheet proforma workbooks (one rent roll per building), a 5-property
portfolio workbook, mixed residential+commercial NYC buildings, HAP/subsidy
rolls, scanned+photographed signed PDFs, and two "trap" files (bank templates
containing only sample rows and unit-type aggregates — correct answer: 0 units).

## Ground truth

One JSON per file (`eval/groundtruth/`), produced by 10 verification agents that
transcribed every unit and reconciled unit counts and rent sums against each
document's own stated totals in code (most to the penny; every discrepancy
explained in the file's `verification`/`notes`). Conventions in `eval/SPEC.md`;
ambiguous rent columns (legal vs preferential vs in-place) are handled with
`acceptableRents`.

## Scoring

`eval/score.ts`: per-file cells = 1 presence cell per GT unit + 1 penalty cell
per hallucinated unit + one cell per document-provided field (status, rent,
tenant, sqft, type, dates) for each matched unit. Unit alignment by normalized
unit number; names fuzzy-matched; rents within 0.5%/$1 or any acceptable
alternative; bed/bath notations semantically equated ("4/1" == "4BR/1BA").
Macro = mean of file accuracies (the target metric).

## What the v2 parser does differently

- **Structured outputs** (`output_config.format` json_schema) — guaranteed-valid
  JSON, no regex parsing, no Zod crashes (v1 crashed on 12/46 files).
- **Model ladder with self-verification**: Sonnet 5 first; extraction is checked
  against totals stated in the document itself (unit count, rent sum, occupied
  count). On failure it retries with Opus 4.8 (then Fable 5) with explicit
  feedback about what mismatched, keeping the better attempt. When a document
  states no totals at all, Opus 4.8 runs as a second opinion and wins on
  disagreement.
- **All sheets, not just the first**: heuristic + AI triage picks unit-level
  sheets in multi-building workbooks; per-sheet extraction; stated totals summed
  across sheets; change-log sheets dropped only when both unit numbers AND
  tenants duplicate another sheet (sibling buildings share unit layouts).
- **Date fidelity**: Excel serial dates converted UTC-safe using number-format
  metadata (`cellNF`), fixing systematic off-by-one/two-day errors.
- **Anti-hallucination rules**: never fabricate units from unit-type aggregate
  rows; template sample rows are not units; billing/arrears sections defer to
  the rent roll section.

## Reproducing

```bash
npx tsx eval/run-eval.ts --cached    # rescore the final run (no API calls)
npx tsx eval/run-eval.ts --fresh     # full re-parse (~1.1M tokens)
```

Archived runs: `eval/runs/baseline-v1/` (old parser), `eval/runs/v2-final/`
(final verification run), plus intermediate iterations.

## Fast-path update (2026-07-12): deterministic Excel extraction

`excelFastPath.ts`: one small structure-mapping call (layout, column indices,
charge-code rules, stop markers), then code walks every row. Accepted ONLY when
the walk reconciles against the document's stated unit count and totals;
otherwise silent fallback to the full-AI ladder. Full-corpus proof run:
99.51% macro, 75/76 >= 95% (the one below-bar file is the scanned Allyson
Gardens PDF — known run variance, never touches the fast path). Fast-path files
drop from minutes to ~15s and ~90% cheaper (442-unit Yardi: 1,431s/120K tokens
-> 17s/13K). Archived: eval/runs/v5-fastpath-76/.
