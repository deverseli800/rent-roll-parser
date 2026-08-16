# Rent Roll Parser

## Implementation Plan
The original implementation plan is at: `(local plan file, not committed)`

## Project Overview
A Next.js web application that extracts structured data from multifamily real estate rent rolls (Excel and PDF) using Claude AI. The app parses documents, validates extraction accuracy, and provides an interactive review UI.

## Tech Stack
- **Framework**: Next.js 16 (App Router)
- **UI**: Mantine v8
- **Data Grid**: AG Grid Community
- **AI**: Anthropic Claude API (Sonnet 4 / Opus 4.5)
- **Excel Parsing**: SheetJS (xlsx)
- **Validation**: Zod
- **Storage**: Local JSON files in `data/extractions/`

## Key Directories
- `src/app/` - Next.js app router pages and API routes
- `src/app/api/upload/` - File upload and parsing endpoint
- `src/app/api/extraction/[id]/` - Get/update extraction data
- `src/app/extraction/[id]/` - Review/edit UI page
- `src/lib/parsers/` - Excel and PDF parsing logic
- `src/lib/validation/` - Zod schemas, validators, verification checks
- `src/lib/types.ts` - TypeScript interfaces
- `src/components/` - Reusable React components

## Core Data Flow (async)
1. User uploads Excel/PDF file; `POST /api/upload` creates a `processing` record
   in `data/extractions/{id}.json` and returns immediately (202)
2. A background job (`src/lib/server/processExtraction.ts`) runs in the server
   process: `parseRentRoll()` (with live progress written to the record —
   stage, attempt/model, KB streamed), then `calculateSummaryStats()`,
   `validateExtraction()`, `runVerificationChecks()`, `explainMismatches()`
3. The client polls `GET /api/extraction/[id]` every 2.5s; the extraction page
   shows a live progress view while `status === 'processing'` (large documents
   take 5-25 minutes)
4. On completion the client saves the result to localStorage (which remains the
   store for review edits/approval); a stale-heartbeat check (10 min) surfaces
   jobs killed by a server restart as errors
5. User reviews/edits in AG Grid table, approves extraction

## Key Types
- `MVPUnit` - Individual unit data (unitNumber, status, rent, tenant, dates)
- `RentRollExtraction` - Full extraction record with units, stats, validation
- `VerificationSummary` - Pass/fail checks with confidence score
- `StatedSummaryStats` - Values extracted from document (for comparison)
- `SummaryStats` - Calculated values from extracted units

## Environment Variables
- `ANTHROPIC_API_KEY` - Required for Claude AI parsing

## Common Commands
```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run lint     # Run ESLint
```

## Evaluation
A ground-truthed eval corpus lives in `eval/` (76 real rent rolls). The corpus,
ground truth, run outputs and manifest are all gitignored — they contain tenant
PII and client property data and must never be committed. See `eval/SPEC.md`.

**Never put real property names, addresses, tenant names or source document
filenames in tracked files** (code comments, prompts, docs, eval scripts).
Use invented placeholders like "124 Main Street".

```bash
npx tsx eval/run-eval.ts            # parse (cached) + score all files
npx tsx eval/run-eval.ts --cached   # rescore existing parse outputs, no API calls
npx tsx eval/run-eval.ts --fresh    # re-parse everything
npx tsx eval/parse-all.ts 28 33     # re-parse specific corpus ids into the cache
npx tsx eval/run-eval.ts --set core --fresh   # 16-file representative set (~1.2M tokens)
npx tsx eval/run-eval.ts --set smoke --fresh  # 5-file sanity check (~150K tokens)
```
Named sets live in `eval/eval-sets.json`; run the full corpus before shipping parser changes, the core set for iteration.
Parse outputs cache in `eval/runs/latest/`; reports in `eval/runs/latest/REPORT.{md,json}`.
Target: macro-average field accuracy >= 95% (achieved: see eval/runs/).

## Parser Architecture (v2)
- `src/lib/parsers/extractionCore.ts` — shared extraction rules/prompt, JSON schema,
  status normalization, self-verification against document-stated totals, and the
  model escalation ladder (Sonnet 5 -> Opus 4.8 -> Fable 5; second-opinion consensus
  when a document states no totals to verify against).
- `src/lib/parsers/excelV2.ts` — all-sheet reading (cellNF/cellText for date formats),
  heuristic + AI sheet triage, per-sheet full-AI extraction with structured outputs,
  update-log sheet subset dedupe, multi-sheet stated-total merging.
- `src/lib/parsers/pdfV2.ts` — vision extraction (handles scans) with the same ladder.
- `src/lib/parsers/excel.ts` / `pdf.ts` — legacy v1 parsers, kept for reference.
- Structured outputs (`output_config.format` json_schema) guarantee valid JSON; all
  calls stream (required for 64K max_tokens).

## Capture vs derivation (the contract)

Two obligations, held to different standards. Capture failures are
unrecoverable; derivation failures are not.

- **Capture is non-negotiable.** `charges[]` `{code, amount}` and
  `sourceColumns` are a verbatim transcription of the document. A column or
  charge line that does not survive the parse cannot be reconstructed by anyone
  — the consumer has to reopen the source file, which is the one thing this
  engine exists to prevent. `applyStructure` therefore captures EVERY populated
  column deterministically; the mapper decides only what gets PROMOTED to a
  first-class field, never what is allowed to exist. Do not reintroduce an
  AI-built allow-list here.
- **Derivation is best-effort but must be honest.** `monthlyRent`, the summary
  stats and every `category` are opinions layered on top. A consumer who
  disagrees recomputes from the raw record. That only works if the raw record is
  complete, which is why the order matters.

## monthlyRent = owner-collected rent

`monthlyRent` is what the owner is contractually entitled to collect:

    + rent components (base/charged rent)
    + subsidy (Section 8/HAP — a third party paying rent, owner receives cash)
    - owner-borne reductions (preferential rent, concessions, employee discounts)
    (reimbursed credits excluded entirely — neither added nor subtracted)

The axis is WHO BEARS THE REDUCTION, and it is the only category distinction
that changes a rent figure:

- `concession` — the owner absorbs it, so collectible rent really is lower.
- `reimbursed_credit` — a third party makes the owner whole (SCRIE/DRIE and
  equivalents), so collectible rent is unchanged.

Note the compensation CHANNEL differs and consumers must not double count:
`subsidy` is cash in the rent stream, while a reimbursed credit typically
reaches the owner as a property-tax abatement. Counting it as rent AND reducing
the tax expense inflates value. The raw charge lines support either treatment.

**KNOWN GAP — a mapped rent column wins.** The subtraction above happens where
rent is DERIVED from charge lines. When the fast-path mapper maps a scalar rent
column, `applyStructure` takes that column verbatim and owner-borne reductions
are NOT subtracted, so `monthlyRent` is whatever the document printed — gross.
Measured on a 15-file corpus: of 5 files carrying concessions, 4 moved and 1
(411 units, ~$533K/mo) did not move at all, because its rent came from a mapped
column. So the layout-dependence this change set out to remove is reduced, not
eliminated: it is now derived-vs-mapped rather than block-vs-column. Closing it
means either preferring the derived figure when charge lines reconcile to the
printed row total, or recomputing rent after charge classification. Both are
real changes to how the walk picks a rent source — do not paper over it by
subtracting the scalar `concession` field from a mapped column, which would
double-subtract on the derived path.

Charge categories come in two tiers — `RENT_DECIDING_CATEGORIES` in
`utils/chargeNormalization.ts` is the authority. The six rent-deciding ones move
money and are worth reconciling against printed totals; the ancillary-income
flavours (pet vs parking vs storage) change no engine output and exist for
cross-document aggregation. Spend verification effort accordingly.

## Important Patterns
- Parsers use Claude to extract JSON, validated with Zod schemas
- Verification checks compare stated document values vs calculated values
- UI shows only columns with data by default (toggle for all columns)
- Verification checks panel is collapsible (starts collapsed)
- The AI charge classifier may fill in codes the keyword prior abstained on, and
  may correct `concession` <-> `reimbursed_credit`, but may not overrule the
  prior otherwise (`gateProposal` in `utils/chargeClassifier.ts` — the rationale
  and the measurements behind it are in that file)
