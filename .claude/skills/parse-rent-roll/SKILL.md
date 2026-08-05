---
name: parse-rent-roll
description: Extract structured unit data from a multifamily rent roll (Excel or PDF) using the rent-roll-parser AI pipeline. Use when the user provides a rent roll file (xlsx, xls, xlsm, or PDF — digital or scanned) and wants units, rents, occupancy, or summary statistics extracted from it.
---

# Parse a rent roll

Run the full extraction pipeline (AI parse with model escalation ladder →
summary stats → validation → verification checks → mismatch explanations) on a
rent roll file and report the results.

## Requires an ANTHROPIC_API_KEY — do not work around it

This skill only works with a valid `ANTHROPIC_API_KEY`; it calls the Anthropic
API to extract and verify the data. **If no key is available, STOP and ask the
user to provide one. Do NOT read the spreadsheet or PDF yourself as a
substitute** — a manual/structural read bypasses the AI extraction, the
model-escalation ladder, and the verification checks that are the entire point
of this skill, and cannot handle PDFs or scans at all. Report the missing key
plainly and wait for it rather than producing an unverified hand-parsed result.

## Running it

```bash
npx tsx ./scripts/parse-rent-roll.ts <path-to-file> [--out <path>]
```

- Accepts `.xlsx`, `.xls`, `.xlsm`, and `.pdf` (vision extraction — scanned
  PDFs work).
- Requires `ANTHROPIC_API_KEY` — the script reads the repo's `.env.local`
  automatically, so no setup is needed on this machine.
- **Timing:** small documents finish in under a minute, and most institutional
  Excel exports (Yardi/RealPage row and charge-block formats) take 1–3 minutes
  via a deterministic fast path (one small AI call maps the sheet structure,
  code walks every row, and the result must reconcile against the document's
  own stated totals). PDFs and documents the fast path rejects go through the
  full AI ladder and can take 5–25 minutes. Run it in the background
  (`run_in_background`) and monitor, rather than blocking on it. Progress
  streams to stderr, including "N units extracted so far" heartbeats — if
  those are advancing, it is not stuck. The model ladder
  (Sonnet 5 → Opus 4.8 → Fable 5) may legitimately restart extraction on a
  bigger model when self-verification fails.
- **Early summary — relay it immediately.** Within ~20 seconds, stderr prints a
  line starting with "Document summary —" giving the totals the document states
  about itself (unit count, occupancy, monthly rent). On documents that will
  take minutes, tell the user those stated totals as soon as the line appears
  instead of staying silent until the full extraction finishes — note they are
  the document's own claims, which the per-unit extraction then verifies.
- Full structured output is written to `<file>.extraction.json` next to the
  input (or `--out <path>`); a markdown summary prints to stdout. Use `--json`
  to dump the full JSON to stdout instead.

## Reporting results

Relay the stdout summary: property name, unit count (vs the document's stated
count), status breakdown, occupancy, total rent, ancillary income by category
(when the document itemizes charges), and the verification verdict (N/M checks
passed, confidence level).

- If verification checks failed, the summary includes an AI explanation and
  root cause per check. `category_mismatch` root causes are definitional
  differences (e.g. the document counts applicant units as vacant), not
  extraction errors — say so plainly rather than presenting them as problems.
- If the user wants the actual unit data, read it from the `units` array in
  the `.extraction.json` file (fields: unitNumber, building, status, category,
  monthlyRent, marketRent, subsidyRent, employeeDiscount, concession,
  tenantName, unitSqft, unitType, lease/move dates; `sourceColumns` carries
  any unmapped document columns verbatim, e.g. rent-regulation codes).
- **Income picture / charge codes:** on charge-block documents each unit also
  carries `charges` — every itemized charge line verbatim as
  `{code, amount, category}` (rent lines, fees, credits; categories are
  AI-classified per document with a keyword prior) — plus `totalCharges`.
  Property-level: `summaryStats.chargeSummary` aggregates by category with the
  raw codes, and `summaryStats.totalChargesAmount` is identified ancillary
  income only (rent-class lines excluded; rent adjustments and unclassified
  `other` codes are listed in chargeSummary but not counted — a large `other`
  row means codes went unrecognized, not that income is missing). Use these to
  answer income questions ("total storage/parking/pet income") instead of
  re-reading the document. Row-format documents without itemized charge rows
  legitimately have no `charges`; their fee columns appear in `sourceColumns`.
- On failure (non-zero exit), report the stderr error; the most common causes
  are a missing/invalid `ANTHROPIC_API_KEY` and unsupported file types.

## Reviewing in the web app

The web app (`npm run dev` in the repo) is a separate flow — files uploaded
through it get the interactive review UI. This CLI does not register results
there; offer it if the user wants to review/edit the extraction visually.
