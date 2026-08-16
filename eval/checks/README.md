# Charge-category / capture checks

Deterministic assertions for the owner-collected-rent rules and the
`sourceColumns` capture guarantee. No API calls, no corpus, no PII — they build
their own tiny worksheets in memory, so they run anywhere in about a second:

```bash
for f in eval/checks/*-check.ts; do npx tsx "$f" || break; done
```

Each exits non-zero on failure.

| check | what it pins down |
|---|---|
| `capture-check` | Every populated column reaches `sourceColumns` **even when the mapper omits it** from `extraColumns` — the guarantee that a column can never be silently dropped. Also that charge columns are not duplicated and empty spacers are skipped. |
| `rent-check` | The four acceptance cases from the charge-category handoff, at exact amounts: a negative exemption column is not netted out of rent, a preferential column is, a block-layout preferential discount is subtracted without string-matching the code, and a block-layout exemption credit is not. |
| `keyword-check` | `normalizeChargeCode` routes named exemption programs to `reimbursed_credit` and leaves ambiguous codes at `other` for the per-document classifier. Includes regression cases for the insurance-waiver and credit-builder bugs the keyword list already carries comments about. |
| `override-check` | `gateProposal` — the classifier may fill abstentions and correct `concession` ↔ `reimbursed_credit`, and may not overrule the keyword prior on anything else. |

## Why these are here and not in the eval corpus

They test RULES, not extraction accuracy. `eval/run-eval.ts` grades parses of
real rent rolls against ground truth and needs the (gitignored, PII-bearing)
corpus to run at all. These need nothing, so they can gate a commit.

They exist because the corpus cannot cover this: the rent-deciding categories
turn on *who bears a reduction*, and whether a given roll happens to contain a
SCRIE credit is an accident of which properties are in the corpus. Two of the
four acceptance cases had no corpus example at the time they were written.

## What they do NOT cover

- **Accuracy.** Nothing here compares against ground truth. A rule can be
  self-consistently wrong and still pass.
- **The AI paths.** Charge-code classification and the full-AI extractor are
  prompt-driven; only their deterministic gates are pinned here.
- **`monthlyRent` when a rent COLUMN is mapped.** The owner-collected rule
  applies where rent is derived from charge lines. When the mapper maps a
  scalar rent column, that column wins and reductions are NOT subtracted — see
  the note in CLAUDE.md. These checks exercise the derived path only.
