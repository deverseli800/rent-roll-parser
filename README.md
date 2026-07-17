# Rent Roll Parser

An AI-powered pipeline that turns multifamily rent rolls (Excel or PDF, digital or scanned) into clean, validated, unit-level JSON. Upload a document, and the system extracts every unit with its rent, status, tenant, dates, and rent components, then verifies the extraction against the totals the document states about itself.

Built with Next.js and the Anthropic Claude API. Includes a web app with a live progress view and review grid, a CLI for scripting, and a ground-truthed evaluation harness (76 real rent rolls, 99%+ macro-average field accuracy).

## What it extracts

| Field | Notes |
|-------|-------|
| Unit number | Exactly as displayed, including prefixes and suffixes |
| Status | occupied, vacant, notice, model, down, applicant (normalized from dozens of vendor spellings) |
| Monthly rent | The actual in-place rent charge, not charge totals or market rent |
| Market rent | Asking or scheduled rent when the document shows it |
| Subsidy rent | Section 8 / HAP portion when shown separately |
| Employee discount, concessions | Recurring credits, sign preserved |
| Tenant name, unit type, square footage | As displayed |
| Lease start/end, move-in/move-out dates | Normalized to ISO dates |

It also captures the summary totals the document states about itself (total units, occupancy, total rent and sqft), which power the verification step.

## How the pipeline works

1. **Read.** Excel workbooks are read in full, every sheet, with date formats resolved. Sheets are triaged (heuristics plus AI for ambiguous workbooks) so only unit-level rent roll sheets are extracted. PDFs go to Claude vision, so scans work as well as digital PDFs.
2. **Fast path.** Standard tabular layouts are read deterministically (structure mapping plus a code walk over the cells) with no per-unit AI call. The result only counts if it reconciles against the document's stated totals; otherwise the AI ladder takes over.
3. **Quick preview.** A fast first pass reads just the document's stated summary (unit count, occupancy, total rent) so the UI shows something within seconds. The document is written to the prompt cache here, making the passes that follow much cheaper.
4. **Full extraction with a model ladder.** Claude Sonnet 5 extracts every unit using structured outputs (guaranteed-valid JSON). The result is self-verified against the stated totals. On a verification failure, the parser escalates to Claude Opus 4.8 with feedback about what went wrong, and then to Claude Fable 5. When a document states no totals to verify against, a second model independently extracts and the results are compared.
5. **Chunking for very large documents.** A 400+ unit document produces more JSON than one model response can hold. The parser detects this (proactively from the stated unit count, or reactively when output truncates) and re-extracts in parallel row-range or page-range chunks with the same model, merges them in document order, and verifies the merged result as one document. Truncation never triggers model escalation, because a stronger model cannot fix a too-much-output problem.
6. **Validate and explain.** The finished extraction gets summary statistics, Zod validation, verification checks (stated vs calculated totals, duplicates, gaps, suspicious patterns), and AI-written explanations for any mismatches.

Every AI call streams, reports live progress, and records token usage, so each run comes with a cache-aware cost estimate.

## Quick start

Requirements: Node.js 20.17+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/deverseli800/rent-roll-parser.git
cd rent-roll-parser
npm install
cp .env.example .env.local   # then put your ANTHROPIC_API_KEY in .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), drop in a rent roll, and watch the extraction timeline. Small documents finish in under a minute; large documents (300+ units) take 10 to 25 minutes and show live per-model, per-chunk progress the whole way. When extraction completes, review and edit the results in the grid, then approve.

For production: `npm run build && npm start`.

## CLI

The same pipeline runs outside the web app:

```bash
npx tsx scripts/parse-rent-roll.ts <file.xlsx|file.pdf> [--out <path>] [--json]
```

- `--out <path>` writes the full extraction JSON (default: `<file>.extraction.json` next to the input)
- `--json` prints the full JSON to stdout instead of a human-readable summary
- Progress streams to stderr; exits non-zero on failure

## HTTP API

```bash
# Upload (returns 202 immediately; extraction runs as a background job)
curl -X POST http://localhost:3000/api/upload -F "file=@rent-roll.xlsx"

# Poll for status/result (the web app polls this every 2.5s)
curl http://localhost:3000/api/extraction/{id}
```

While processing, the response carries the live progress timeline (stage, current model and attempt, units streamed so far). On completion it carries the units, summary stats, validation results, and verification checks.

## Accuracy and evaluation

A ground-truthed eval corpus of 76 real rent rolls (OneSite/RealPage, Yardi, ResMan, AppFolio, proformas, scanned PDFs, commercial/residential mixes) lives in `eval/`. The scorer aligns extracted units to ground truth and reports per-field accuracy, missed units, and hallucinated units.

```bash
npx tsx eval/run-eval.ts              # parse (cached) + score all files
npx tsx eval/run-eval.ts --cached     # rescore existing outputs, no API calls
npx tsx eval/run-eval.ts --set core   # 16-file representative set
npx tsx eval/run-eval.ts --set smoke  # 5-file sanity check
```

Reports land in `eval/runs/latest/REPORT.md`.

### Current results (2026-07-16)

**Overall: 99.75% macro-average field accuracy across the 16-file representative set, 1,459 units, zero missed and zero hallucinated units.** (Fresh run after the chunked-extraction change; 16/16 files at or above the 95% target.)

#### Accuracy by field

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

#### Per-file results

| Document | Units | Accuracy | Missed | Hallucinated |
|----------|-------|----------|--------|--------------|
| [redacted] rent roll details (.xlsx, chunked extraction) | 411 | 99.9% | 0 | 0 |
| Institutional Wide .xls Rent Roll (.xls) | 320 | 98.1% | 0 | 0 |
| [redacted] scanned rent roll (.pdf) | 200 | 100.0% | 0 | 0 |
| Rent Roll with Lease Charges 06/02 (.xlsx) | 153 | 99.1% | 0 | 0 |
| [redacted] Rent Roll (.pdf) | 59 | 100.0% | 0 | 0 |
| [redacted] RR (.xlsm) | 55 | 100.0% | 0 | 0 |
| [redacted] Rent Roll with Lease Charges (.pdf) | 51 | 100.0% | 0 | 0 |
| Tenant Lease Agreement Info (.xlsx) | 50 | 100.0% | 0 | 0 |
| [redacted] Proforma (.xlsx) | 45 | 99.5% | 0 | 0 |
| Rent Roll 6.5.2025 signed (.pdf, scan) | 39 | 100.0% | 0 | 0 |
| South Rent Roll (.xlsx) | 36 | 100.0% | 0 | 0 |
| [redacted] RR + Arrears (.pdf) | 27 | 99.4% | 0 | 0 |
| [redacted] Rent Roll (.xlsx) | 6 | 100.0% | 0 | 0 |
| Rent Roll + Operating Statement (.pdf) | 5 | 100.0% | 0 | 0 |
| [redacted] CM Rent Roll (.xlsx) | 2 | 100.0% | 0 | 0 |
| [redacted] Commercial/Residential (.xls, aggregate-only) | 0 | 100.0% | 0 | 0 |

The set spans property management exports (OneSite/RealPage, Yardi, ResMan), proformas, scans, charge-code layouts, an arrears-mixed document, and an aggregate-only document whose correct answer is zero units. The 411-unit [redacted] file exercises the chunked extraction path end to end.

## Cost

Extraction uses the Claude API. Rough per-document costs:

- Small documents (under ~50 units): a few cents, and often near-free when the deterministic fast path handles them
- Mid-size documents: $0.10 to $1.00
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
    │   ├── extractionCore.ts  # Shared rules, schema, verification, model ladder, chunking
    │   ├── excelV2.ts         # Sheet reading, triage, per-sheet extraction
    │   ├── excelFastPath.ts   # Deterministic reader for standard layouts
    │   ├── pdfV2.ts           # Vision extraction
    │   └── aiClient.ts        # Streaming structured-output client
    ├── validation/            # Zod schemas, verification checks, mismatch explainer
    ├── server/                # Background job runner
    └── types.ts
scripts/parse-rent-roll.ts   # CLI entry point
eval/                        # Ground-truthed evaluation harness
data/extractions/            # Extraction records (local JSON)
```

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router)
- [Anthropic Claude API](https://www.anthropic.com/): Sonnet 5, Opus 4.8, and Fable 5 with structured outputs, streaming, and prompt caching
- [Mantine v8](https://mantine.dev/) UI, [AG Grid](https://www.ag-grid.com/) review table
- [SheetJS](https://sheetjs.com/) Excel parsing, [Zod](https://zod.dev/) validation

## License

MIT. See [LICENSE](LICENSE).
