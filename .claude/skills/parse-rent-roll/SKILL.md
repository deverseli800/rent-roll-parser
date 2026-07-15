---
name: parse-rent-roll
description: Extract structured unit data from a multifamily rent roll (Excel or PDF) using the rent-roll-parser AI pipeline. Use when the user provides a rent roll file (xlsx, xls, xlsm, or PDF — digital or scanned) and wants units, rents, occupancy, or summary statistics extracted from it.
---

# Parse a rent roll

Run the full extraction pipeline (AI parse with model escalation ladder →
summary stats → validation → verification checks → mismatch explanations) on a
rent roll file and report the results.

## Running it

```bash
npx tsx ./scripts/parse-rent-roll.ts <path-to-file> [--out <path>]
```

- Accepts `.xlsx`, `.xls`, `.xlsm`, and `.pdf` (vision extraction — scanned
  PDFs work).
- Requires `ANTHROPIC_API_KEY` — the script reads the repo's `.env.local`
  automatically, so no setup is needed on this machine.
- **Timing:** small documents finish in under a minute; large documents take
  5–25 minutes. Run it in the background (`run_in_background`) and monitor,
  rather than blocking on it. Progress streams to stderr, including
  "N units extracted so far" heartbeats — if those are advancing, it is not
  stuck. The model ladder (Sonnet 5 → Opus 4.8 → Fable 5) may legitimately
  restart extraction on a bigger model when self-verification fails.
- Full structured output is written to `<file>.extraction.json` next to the
  input (or `--out <path>`); a markdown summary prints to stdout. Use `--json`
  to dump the full JSON to stdout instead.

## Reporting results

Relay the stdout summary: property name, unit count (vs the document's stated
count), status breakdown, occupancy, total rent, and the verification verdict
(N/M checks passed, confidence level).

- If verification checks failed, the summary includes an AI explanation and
  root cause per check. `category_mismatch` root causes are definitional
  differences (e.g. the document counts applicant units as vacant), not
  extraction errors — say so plainly rather than presenting them as problems.
- If the user wants the actual unit data, read it from the `units` array in
  the `.extraction.json` file (fields: unitNumber, status, monthlyRent,
  tenantName, unitSqft, unitType, lease/move dates).
- On failure (non-zero exit), report the stderr error; the most common causes
  are a missing/invalid `ANTHROPIC_API_KEY` and unsupported file types.

## Reviewing in the web app

The web app (`npm run dev` in the repo) is a separate flow — files uploaded
through it get the interactive review UI. This CLI does not register results
there; offer it if the user wants to review/edit the extraction visually.
