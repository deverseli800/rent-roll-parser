# Rent Roll Parser

Turn multifamily rent rolls (Excel or PDF, digital or scanned) into clean, validated, unit-level JSON — and know whether the result is right before you use it.

Built with Next.js and the Anthropic Claude API. Includes a web app with a live progress view and review grid, a CLI, a Claude Code skill, and a ground-truthed evaluation harness (76 real rent rolls, 99%+ macro-average field accuracy).

## Why this instead of handing the file to an LLM

Anyone can paste a rent roll into a model and get a table back. The hard part is knowing whether the table is correct — and rent rolls punish you for being wrong: a missed unit or a rent column read one column to the left changes an underwriting.

This parser is built around three ideas.

**1. Don't use an LLM if you don't have to.** Most institutional exports (Yardi, RealPage/OneSite, ResMan, AppFolio) are regular grids. For those, the model never sees the units. One small call maps the *shape* of the sheet — layout, column indices, which charge codes are rent, where the data stops — and then plain code walks every row. The AI reads the structure; deterministic code reads the numbers. Rows can't be skipped, values can't be paraphrased, and a 442-unit export goes from ~24 minutes and 120K tokens to ~17 seconds and 13K.

**2. The document proves the answer, not the model.** Rent rolls state their own totals: unit count, occupancy, total monthly rent, total market rent, total square footage. Every extraction — fast path or AI — is reconciled against those anchors in code. Nothing is accepted because a model said so.

**3. Escalate only on failure, with a reason.** When reconciliation fails, the parser retries on a stronger model and tells it exactly what didn't add up. Verification survives to the output, so you see which checks passed and which didn't.

## Fast path vs. AI ladder

```
Excel/PDF
   │
   ├─ Excel, regular grid ──► FAST PATH
   │                          1 small structure-mapping call, then a code walk
   │                          over every row
   │                              │
   │                              ├─ reconciles + proven complete ──► done  (~15s, ~90% cheaper)
   │                              └─ anything off ───────────────────┐
   │                                                                 │
   └─ PDF, scan, irregular layout, or fast path declined ────────────┴─► AI LADDER
                                                                         Sonnet 5
                                                                            │ verification fails
                                                                         Opus 4.8  (+ what mismatched)
                                                                            │ verification fails
                                                                         Fable 5
```

Fallback is silent and automatic — the fast path never guesses at being right. It is accepted only when both of these hold:

- **It reconciles.** Extracted unit count, rent sum, market-rent sum and occupied count all match the document's stated figures within tolerance, and the result passes coverage checks (no charge codes swept into rent, no rows dropped at a page break).
- **It's provably complete.** A stated unit count is the cleanest anchor. Plenty of real exports never print one, so a stated *market-rent* total can stand in — but only if every unit carries a market rent, the sum matches within a hairline tolerance (max of $1 or 0.02%), the cheapest unit's market rent exceeds that tolerance (so no single unit can be missing without breaking the match), and a second stated money total agrees. A stated *rent* total is deliberately not enough on its own: it's often a total-charges figure that legitimately differs from base rent, so it corroborates but never proves.

Roughly: institutional Excel exports finish in 1–3 minutes for cents; PDFs, scans and irregular workbooks take the ladder at 10–25 minutes for a few dollars. You don't choose — the document does.

### What the verification actually checks

Both paths run the same reconciliation, and the AI path uses failures as retry feedback:

- Stated vs. extracted unit count, occupied count, total monthly rent, total market rent — with the mismatch interpreted, not just reported ("sum too high → you used total charges or market rent"; "too low → you missed units or used the tenant-paid portion")
- Occupancy reconciled under either on-notice convention, and unit counts reconciled by category (a document counting only residential units shouldn't fail a roll that also has commercial space)
- **Model fatigue**: fields well-populated in the first quarter of a long document but empty in the last quarter — the classic failure on 300+ unit rolls. Same check for the per-unit charge lines.
- Duplicates (keyed by building + unit, so multi-building rolls that reuse "1A" don't false-trip), unit-number gaps, and corruption signatures such as a unit-type column that equals the rent column
- Where a document states nothing to check against, a second model extracts independently and the results are compared

Anything still unexplained gets an AI-written explanation attached, and the UI shows a pass/fail panel with a confidence level rather than a bare table.

## What it extracts

| Field | Notes |
|-------|-------|
| Unit number | Exactly as displayed, including prefixes and suffixes |
| Building | For multi-building documents, the section label the unit sits under |
| Status | occupied, vacant, notice, model, down, applicant (normalized from dozens of vendor spellings) |
| Category | residential, commercial, or non-unit income (parking, antenna, laundry, signage) |
| Monthly rent | The actual in-place rent charge, not charge totals or market rent |
| Market rent | Asking or scheduled rent when the document shows it |
| Subsidy rent | Section 8 / HAP portion when shown separately |
| Employee discount, concessions | Recurring credits, sign preserved |
| Charges | Every itemized charge line for the unit, verbatim (see below) |
| Tenant name, unit type, square footage | As displayed |
| Lease start/end, move-in/move-out dates | Normalized to ISO dates |
| Source columns | Any document column with no home in the schema, passed through verbatim (e.g. NYC rent-regulation codes) — nothing on the sheet is silently dropped |

It also captures the summary totals the document states about itself, which power the verification step.

## Charges and the income picture

Charge-block exports print one unit as several rows — `Rent 1,196.00`, `Trash Removal 10.00`, `Pet Rent 35.00`, then a `Charge Total`. The parser keeps every line as `{code, amount, category}` rather than collapsing them, so rent stays rent (never the charge total) and the ancillary income survives.

Charge codes are vendor-specific gibberish that differs per document, so categorization runs as its own pass: a keyword prior handles the obvious ones, and a single small AI call classifies the document's remaining distinct codes — the codes, not the rows, so it costs the same on a 40-unit roll and a 600-unit one.

At the property level, `summaryStats.chargeSummary` aggregates by category and `totalChargesAmount` gives identified ancillary income. Two deliberate choices there: rent-class lines (base rent, subsidy) are excluded because the rent totals already carry them, and rent *adjustments* (concessions, loss to lease, vacancy loss) plus unrecognized codes are listed but not summed. So the rows won't add up to the total — that's the point. A large `other` row means codes went unrecognized, not that income is missing.

The review grid surfaces per-charge-code columns under "Show all columns", and the CLI prints an ancillary-income breakdown.

## The rest of the pipeline

1. **Read.** Excel workbooks are read in full, every sheet, with date formats resolved from number-format metadata (fixing systematic off-by-one date errors). Sheets are triaged — heuristics plus AI for ambiguous workbooks — so only unit-level rent roll sheets are extracted, and derived or corrupted duplicate views of the same roll are dropped in favor of the source view. PDFs go to Claude vision, so scans work as well as digital PDFs.
2. **Quick preview.** A fast first pass reads just the document's stated summary so the UI shows something within seconds. The document is written to the prompt cache here, making every pass that follows much cheaper.
3. **Extract.** Fast path or AI ladder, as above. All AI calls use structured outputs (guaranteed-valid JSON) and stream.
4. **Chunk when necessary.** A 400+ unit document produces more JSON than one model response can hold. The parser detects this — proactively from the stated unit count, reactively when output truncates — and re-extracts in parallel row-range or page-range chunks, merges them in document order, and verifies the merged result as one document. Truncation never triggers model escalation, because a stronger model can't fix a too-much-output problem.
5. **Validate and explain.** Summary statistics, Zod validation, verification checks, and AI-written explanations for anything that still doesn't reconcile.

Every AI call reports live progress and records token usage, so each run comes with a cache-aware cost estimate.

## Quick start

Requirements: Node.js 20.17+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/deverseli800/rent-roll-parser.git
cd rent-roll-parser
npm install
cp .env.example .env.local   # then put your ANTHROPIC_API_KEY in .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drop in a rent roll, and watch the extraction timeline. Fast-path documents finish in a couple of minutes; documents that need the full ladder (300+ units, scans) take 10 to 25 minutes and show live per-model, per-chunk progress the whole way. When extraction completes, review and edit the results in the grid, then approve.

For production: `npm run build && npm start`.

## CLI

The same pipeline runs outside the web app:

```bash
npx tsx scripts/parse-rent-roll.ts <file.xlsx|file.pdf> [--out <path>] [--json]
```

- `--out <path>` writes the full extraction JSON (default: `<file>.extraction.json` next to the input)
- `--json` prints the full JSON to stdout instead of a human-readable summary
- Progress streams to stderr; exits non-zero on failure

The summary reports property name, unit count against the document's stated count, status breakdown, occupancy, total rent, ancillary income by category, the verification verdict, and a cost estimate.

## Claude Code skill

`.claude/skills/parse-rent-roll/` wraps the CLI as a [Claude Code](https://claude.com/claude-code) skill, so you can hand Claude a rent roll and ask questions about it directly. Run `npm run export-skill` to build a portable bundle.

## HTTP API

```bash
# Upload (returns 202 immediately; extraction runs as a background job)
curl -X POST http://localhost:3000/api/upload -F "file=@rent-roll.xlsx"

# Poll for status/result (the web app polls this every 2.5s)
curl http://localhost:3000/api/extraction/{id}
```

While processing, the response carries the live progress timeline (stage, current model and attempt, units streamed so far). On completion it carries the units, summary stats, validation results, and verification checks.

## Accuracy and evaluation

A ground-truthed corpus of 76 real rent rolls lives in `eval/` — property management exports (OneSite/RealPage, Yardi, ResMan, AppFolio), proformas, scanned and photographed PDFs, charge-block layouts, HUD/subsidy rolls, mixed residential/commercial buildings, multi-building workbooks, and "trap" documents whose correct answer is zero units. The scorer aligns extracted units to ground truth and reports per-field accuracy, missed units, and hallucinated units.

The corpus contains real tenant and property data, so it is not distributed with the repo — `eval/corpus/`, `eval/groundtruth/` and `eval/runs/` are gitignored. `eval/SPEC.md` documents the ground-truth format so you can build your own.

```bash
npx tsx eval/run-eval.ts              # parse (cached) + score all files
npx tsx eval/run-eval.ts --cached     # rescore existing outputs, no API calls
npx tsx eval/run-eval.ts --set core   # 16-file representative set
npx tsx eval/run-eval.ts --set smoke  # 5-file sanity check
```

Reports land in `eval/runs/latest/REPORT.md`.

### Current results

**99.75% macro-average field accuracy across the 16-file representative set, 1,459 units, zero missed and zero hallucinated units** — 16/16 files at or above the 95% target. The set spans every format family in the corpus, including a 411-unit file that exercises chunked extraction end to end.

| Field | Accuracy | Cells |
|-------|----------|-------|
| Unit presence | **100.0%** | 1459/1459 |
| Unit type | **100.0%** | 1425/1425 |
| Square footage | **100.0%** | 1287/1287 |
| Move-out date | **100.0%** | 728/728 |
| Status | **99.2%** | 1447/1459 |
| Lease end date | **99.2%** | 1447/1459 |
| Monthly rent | **99.1%** | 1446/1459 |
| Tenant name | **99.1%** | 1294/1306 |
| Move-in date | **99.0%** | 1281/1294 |
| Lease start date | **98.6%** | 1142/1158 |

Historical runs and the v1-to-v2 comparison are in `eval/RESULTS.md`.

## Cost

Extraction uses the Claude API. Rough per-document costs:

- Fast-path Excel exports: a cent or two — one structure-mapping call and one charge-code classification call, regardless of unit count
- Mid-size documents on the AI ladder: $0.10 to $1.00
- Large documents that need full AI extraction (300+ units): $2 to $6, kept down by prompt caching across the preview, extraction, and chunk calls

The app shows a cost estimate for every run.

## Project structure

```
src/
├── app/                     # Next.js app router
│   ├── api/upload/          # Async upload endpoint (202 + background job)
│   ├── api/extraction/[id]/ # Status/result polling
│   ├── extraction/[id]/     # Live progress + review/edit UI
│   └── page.tsx             # Upload page
├── components/              # Upload, grid, timeline components
└── lib/
    ├── parsers/
    │   ├── extractionCore.ts    # Shared rules, schema, verification, model ladder, chunking
    │   ├── excelV2.ts           # Sheet reading, triage, per-sheet extraction
    │   ├── excelFastPath.ts     # Deterministic reader + its proof rules
    │   ├── pdfV2.ts             # Vision extraction
    │   └── aiClient.ts          # Streaming structured-output client
    ├── utils/
    │   ├── chargeClassifier.ts  # Per-document charge-code categorization
    │   ├── chargeNormalization.ts
    │   ├── occupancy.ts         # Count/occupancy/rent reconciliation
    │   └── summaryStats.ts
    ├── validation/              # Zod schemas, verification checks, mismatch explainer
    ├── server/                  # Background job runner
    └── types.ts
scripts/parse-rent-roll.ts       # CLI entry point
.claude/skills/parse-rent-roll/  # Claude Code skill
eval/                            # Ground-truthed evaluation harness
data/extractions/                # Extraction records (local JSON, gitignored)
```

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router)
- [Anthropic Claude API](https://www.anthropic.com/): Sonnet 5, Opus 4.8, and Fable 5 with structured outputs, streaming, and prompt caching
- [Mantine v8](https://mantine.dev/) UI, [AG Grid](https://www.ag-grid.com/) review table
- [SheetJS](https://sheetjs.com/) Excel parsing, [Zod](https://zod.dev/) validation

## License

MIT. See [LICENSE](LICENSE).
