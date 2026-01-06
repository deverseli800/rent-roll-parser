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

## Core Data Flow
1. User uploads Excel/PDF file
2. `parseRentRoll()` extracts units using Claude AI
3. `calculateSummaryStats()` computes totals from extracted data
4. `validateExtraction()` checks for issues (duplicates, count mismatches)
5. `runVerificationChecks()` compares stated vs calculated values
6. Results saved to `data/extractions/{id}.json`
7. User reviews/edits in AG Grid table, approves extraction

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

## Important Patterns
- Parsers use Claude to extract JSON, validated with Zod schemas
- Verification checks compare stated document values vs calculated values
- UI shows only columns with data by default (toggle for all columns)
- Verification checks panel is collapsible (starts collapsed)
