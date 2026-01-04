import Anthropic from '@anthropic-ai/sdk';
import type { MVPUnit, UnitStatus } from '../types';
import { ClaudeExtractionResponseSchema } from '../validation/schema';

/**
 * MVP PDF Parser using Claude Vision API
 * Focused on accurate unit count extraction - no missing or hallucinated units
 */

const MVP_EXTRACTION_PROMPT = `You are extracting unit data from a rent roll document. Your PRIMARY goal is accurate unit count - do not miss ANY units and do not hallucinate units that don't exist.

STEP 1: Look for the total unit count stated in the document (e.g., "Total Units: 156", summary row, or property info section). If found, report this number.

STEP 2: Extract ALL units. A unit is a row with a UNIT NUMBER (like "101", "A-201", "1A", "Unit 5").

IMPORTANT - DO NOT count these as units:
- Charge breakdown rows (RENT, PESTCONTROL, PARKING, etc.)
- Summary/total rows
- Header rows
- Empty rows
- Property information rows

STEP 3: For each unit, extract the following fields (use null if not present):

PRIMARY FIELDS:
- unitNumber (REQUIRED): The unit identifier
- status (REQUIRED): One of: occupied, vacant, notice, model, applicant
  - "Occupied", "Current", "C" = occupied
  - "Vacant", "V" = vacant
  - "NTV", "Notice", "Occupied-NTV" = notice
  - "Model", "M" = model
  - "Applicant", "Pending" = applicant
- monthlyRent: The primary rent amount (number only, no $ or commas)
- tenantName: The tenant/resident name if present

ADDITIONAL FIELDS (optional - include if present, omit if not found to save space):
- unitSqft: Square footage (number only)
- unitType: Unit type/floorplan (e.g., "1BR/1BA", "A2", "Studio")
- leaseStatus: Raw lease status text
- moveInDate: Move-in date (YYYY-MM-DD)
- moveOutDate: Move-out date (YYYY-MM-DD)
- leaseStartDate: Lease start (YYYY-MM-DD)
- leaseEndDate: Lease end (YYYY-MM-DD)

STEP 4: After extraction, count your extracted units. If you found a stated total in Step 1, verify your count matches. If not, re-examine the document.

Return ONLY valid JSON in this exact format:
{
  "propertyName": "Property Name Here or null",
  "statedTotalUnits": <number from document or null if not found>,
  "units": [
    {
      "unitNumber": "101",
      "status": "occupied",
      "monthlyRent": 1200,
      "tenantName": "John Smith",
      "unitSqft": 850,
      "unitType": "1BR/1BA",
      "leaseStatus": "Occupied",
      "moveInDate": "2024-01-15",
      "moveOutDate": null,
      "leaseStartDate": "2024-01-15",
      "leaseEndDate": "2025-01-14"
    }
  ],
  "extractedCount": <count of units in your array>,
  "countMatch": <true if statedTotalUnits equals extractedCount, false if not, null if statedTotalUnits is null>
}

CRITICAL: Missing units or hallucinated units is a critical failure. Double-check your work.`;

// Status normalization mapping
const STATUS_MAPPINGS: Record<string, UnitStatus> = {
  'occupied': 'occupied',
  'current': 'occupied',
  'c': 'occupied',
  'leased': 'occupied',
  'occupied-ntv': 'notice',
  'vacant': 'vacant',
  'v': 'vacant',
  'available': 'vacant',
  'notice': 'notice',
  'ntv': 'notice',
  'model': 'model',
  'm': 'model',
  'down': 'down',
  'd': 'down',
  'applicant': 'applicant',
  'pending': 'applicant',
};

function normalizeStatus(status: string): UnitStatus {
  const normalized = status.toLowerCase().trim();
  return STATUS_MAPPINGS[normalized] || 'occupied';
}

/**
 * Convert PDF buffer to base64
 */
function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Parse PDF using Claude Vision API
 */
export async function parsePDF(buffer: Buffer): Promise<{
  units: MVPUnit[];
  statedUnitCount: number | null;
  propertyName: string | null;
  format: string;
  pageCount: number | null;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const client = new Anthropic({
    apiKey,
    timeout: 10 * 60 * 1000, // 10 minutes - disable pre-request duration check
  });

  const base64PDF = bufferToBase64(buffer);

  try {
    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 64000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: base64PDF,
                },
              },
              {
                type: 'text',
                text: MVP_EXTRACTION_PROMPT,
              },
            ],
          },
        ],
      },
      {
        timeout: 10 * 60 * 1000, // 10 minutes
      }
    );

    // Extract the text response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not find JSON in Claude response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate with Zod schema
    const validated = ClaudeExtractionResponseSchema.parse(parsed);

    // Convert to MVPUnit format
    const units: MVPUnit[] = validated.units.map((unit, index) => ({
      unitNumber: unit.unitNumber,
      status: normalizeStatus(unit.status),
      monthlyRent: unit.monthlyRent ?? null,
      tenantName: unit.tenantName ?? null,
      // Additional fields
      unitSqft: unit.unitSqft ?? null,
      unitType: unit.unitType ?? null,
      leaseStatus: unit.leaseStatus ?? null,
      moveInDate: unit.moveInDate ?? null,
      moveOutDate: unit.moveOutDate ?? null,
      leaseStartDate: unit.leaseStartDate ?? null,
      leaseEndDate: unit.leaseEndDate ?? null,
      // Metadata
      sourcePage: 1, // Claude processes all pages together
      sourceRow: index + 1,
    }));

    // Detect format based on patterns
    let format = 'unknown';
    if (textContent.text.toLowerCase().includes('onesite') ||
        textContent.text.toLowerCase().includes('realpage')) {
      format = 'onesite';
    } else if (textContent.text.toLowerCase().includes('resman')) {
      format = 'resman';
    } else if (textContent.text.toLowerCase().includes('yardi')) {
      format = 'yardi';
    }

    return {
      units,
      statedUnitCount: validated.statedTotalUnits ?? null,
      propertyName: validated.propertyName ?? null,
      format,
      pageCount: null,
      modelUsed: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (error) {
    // If Claude Sonnet 4 fails, try with Opus 4.5
    if (error instanceof Error && error.message.includes('model')) {
      const response = await client.messages.create(
        {
          model: 'claude-opus-4-5-20251101',
          max_tokens: 64000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64PDF,
                  },
                },
                {
                  type: 'text',
                  text: MVP_EXTRACTION_PROMPT,
                },
              ],
            },
          ],
        },
        {
          timeout: 10 * 60 * 1000, // 10 minutes
        }
      );

      const textContent = response.content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text response from Claude');
      }

      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not find JSON in Claude response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = ClaudeExtractionResponseSchema.parse(parsed);

      const units: MVPUnit[] = validated.units.map((unit, index) => ({
        unitNumber: unit.unitNumber,
        status: normalizeStatus(unit.status),
        monthlyRent: unit.monthlyRent ?? null,
        tenantName: unit.tenantName ?? null,
        // Additional fields
        unitSqft: unit.unitSqft ?? null,
        unitType: unit.unitType ?? null,
        leaseStatus: unit.leaseStatus ?? null,
        moveInDate: unit.moveInDate ?? null,
        moveOutDate: unit.moveOutDate ?? null,
        leaseStartDate: unit.leaseStartDate ?? null,
        leaseEndDate: unit.leaseEndDate ?? null,
        // Metadata
        sourcePage: 1,
        sourceRow: index + 1,
      }));

      return {
        units,
        statedUnitCount: validated.statedTotalUnits ?? null,
        propertyName: validated.propertyName ?? null,
        format: 'unknown',
        pageCount: null,
        modelUsed: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    }

    throw error;
  }
}
