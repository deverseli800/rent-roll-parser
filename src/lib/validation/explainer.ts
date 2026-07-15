import Anthropic from '@anthropic-ai/sdk';
import { MODELS, type AIUsage } from '../parsers/aiClient';
import type { MVPUnit, StatedSummaryStats, SummaryStats, VerificationCheck, MismatchExplanation, ExplanationSummary } from '../types';

const EXPLANATION_PROMPT = `You are analyzing a rent roll extraction to explain WHY mismatches exist between stated values (from the document) and calculated values (from extracted units).

Here is the extraction data:

UNITS EXTRACTED:
{units}

STATED VALUES (from document summary):
{statedStats}

CALCULATED VALUES (from summing extracted units):
{calculatedStats}

FAILED VERIFICATION CHECKS:
{failedChecks}

Analyze the data and explain the ROOT CAUSE of each mismatch. Common causes include:

1. **Total Rent Mismatch**:
   - Document's stated total includes rent booked to model/down/admin units, but the calculation counts only occupied/notice tenants
   - Check if: stated_total = calculated_total + sum of monthlyRent on model/down/vacant/applicant units
   - Document uses market rent for ALL units, but calculation excludes vacant/applicant units
   - Sum the monthlyRent for excluded status types to verify

2. **Occupied Count Mismatch**:
   - Document counts "Notice" units as "Occupied" in its summary
   - Check if: stated_occupied = extracted_occupied + extracted_notice

3. **Vacant Count Mismatch**:
   - Document counts "Applicant" units as "Vacant" in its summary
   - Check if: stated_vacant = extracted_vacant + extracted_applicant

4. **Sqft Mismatch**:
   - Some units may have null/missing sqft values
   - Count units with missing sqft data

For each failed check, provide:
- The specific units/values causing the mismatch
- The mathematical proof (e.g., "43 occupied + 2 notice = 45 stated")
- Whether this is a real extraction error or just a category definition difference

Return JSON only:
{
  "explanations": [
    {
      "checkId": "total-rent",
      "checkName": "Total Rent",
      "explanation": "Clear explanation of why the mismatch exists",
      "rootCause": "category_mismatch | extraction_error | data_quality | unknown",
      "affectedUnits": ["unit1", "unit2"],
      "recommendation": "How to interpret or fix this"
    }
  ],
  "overallAssessment": "Brief summary - are these real errors or expected category differences?"
}`;

export async function explainMismatches(
  units: MVPUnit[],
  statedStats: StatedSummaryStats | null,
  calculatedStats: SummaryStats | null,
  failedChecks: VerificationCheck[],
  /** When provided, the explainer's API usage is appended for cost tracking. */
  usages?: AIUsage[]
): Promise<ExplanationSummary> {
  // If no failed checks, nothing to explain
  if (failedChecks.length === 0) {
    return {
      hasExplanations: false,
      explanations: [],
      overallAssessment: 'All verification checks passed.',
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      hasExplanations: false,
      explanations: [],
      overallAssessment: 'Could not generate explanations: API key not configured.',
    };
  }

  // Prepare unit summary for the prompt (condensed format)
  const unitsSummary = units.map(u => ({
    unit: u.unitNumber,
    status: u.status,
    rent: u.monthlyRent,
    sqft: u.unitSqft,
  }));

  // Group units by status for easier analysis
  const byStatus: Record<string, { count: number; totalRent: number; units: string[] }> = {};
  for (const unit of units) {
    if (!byStatus[unit.status]) {
      byStatus[unit.status] = { count: 0, totalRent: 0, units: [] };
    }
    byStatus[unit.status].count++;
    byStatus[unit.status].totalRent += unit.monthlyRent || 0;
    byStatus[unit.status].units.push(unit.unitNumber);
  }

  const prompt = EXPLANATION_PROMPT
    .replace('{units}', JSON.stringify({ byStatus, allUnits: unitsSummary }, null, 2))
    .replace('{statedStats}', JSON.stringify(statedStats, null, 2))
    .replace('{calculatedStats}', JSON.stringify(calculatedStats, null, 2))
    .replace('{failedChecks}', JSON.stringify(failedChecks, null, 2));

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: MODELS.fast,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    usages?.push({
      modelUsed: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not find JSON in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      hasExplanations: true,
      explanations: parsed.explanations || [],
      overallAssessment: parsed.overallAssessment || 'Analysis complete.',
    };
  } catch (error) {
    console.error('Error generating explanations:', error);
    return {
      hasExplanations: false,
      explanations: [],
      overallAssessment: `Could not generate explanations: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
