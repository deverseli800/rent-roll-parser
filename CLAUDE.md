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
A ground-truthed eval corpus lives in `eval/` (46 real rent rolls collected from
`./data/source-documents`, DHCR docs excluded). See `eval/SPEC.md`.

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

## Important Patterns
- Parsers use Claude to extract JSON, validated with Zod schemas
- Verification checks compare stated document values vs calculated values
- UI shows only columns with data by default (toggle for all columns)
- Verification checks panel is collapsible (starts collapsed)
