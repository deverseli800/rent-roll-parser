import Anthropic from '@anthropic-ai/sdk';

/**
 * Shared AI client for rent roll extraction.
 *
 * - Structured outputs (output_config.format json_schema) so responses are
 *   guaranteed-valid JSON — no regex extraction.
 * - Streaming (required for large max_tokens).
 * - Model ladder: Sonnet 5 (fast/cheap) -> Opus 4.8 (strong) -> Fable 5
 *   (most capable) for escalation when verification fails.
 */

export const MODELS = {
  fast: 'claude-sonnet-5',
  strong: 'claude-opus-4-8',
  max: 'claude-fable-5',
} as const;

/** Human-readable names for progress/escalation messages. */
export { modelLabel } from '../utils/modelLabels';

export interface AIUsage {
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache this call (billed ~1.25x input price). */
  cacheCreationInputTokens?: number;
  /** Tokens served from the prompt cache this call (billed ~0.1x input price). */
  cacheReadInputTokens?: number;
}

export interface StreamProgress {
  /** cumulative output characters streamed (0 while the model is still thinking) */
  chars: number;
  /** completed items seen so far, counted by occurrences of `itemToken` in the stream */
  items: number;
}

/** Called during streaming with cumulative progress (throttled). */
export type StreamHeartbeat = (progress: StreamProgress) => void;

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }
  _client = new Anthropic({ apiKey, timeout: 15 * 60 * 1000, maxRetries: 3 });
  return _client;
}

/**
 * Make a structured extraction call. Returns parsed JSON matching the schema.
 */
export async function extractStructured<T>(options: {
  model: string;
  content: Anthropic.ContentBlockParam[];
  schema: Record<string, unknown>;
  maxTokens?: number;
  onHeartbeat?: StreamHeartbeat;
  /**
   * Substring whose occurrences in the streamed JSON count completed items
   * for progress reporting (e.g. '"unitNumber"' — once per unit object).
   */
  itemToken?: string;
}): Promise<{ data: T; usage: AIUsage }> {
  const client = getClient();
  const { model, content, schema, maxTokens = 110000, onHeartbeat, itemToken } = options;

  const params: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content }],
    output_config: {
      format: {
        type: 'json_schema',
        schema,
      },
    },
  };
  // Fable 5: thinking is always on (omit param). Opus/Sonnet: enable adaptive.
  if (model !== MODELS.max) {
    params.thinking = { type: 'adaptive' };
  }

  const stream = client.messages.stream(params);

  if (onHeartbeat) {
    let chars = 0;
    let items = 0;
    // Token matches can split across delta boundaries; carry the last
    // token-length−1 chars forward. A full token never fits in the carry
    // alone, so nothing is double-counted.
    let carry = '';
    let lastBeat = Date.now();
    stream.on('text', (delta) => {
      chars += delta.length;
      if (itemToken) {
        const seg = carry + delta;
        let idx = seg.indexOf(itemToken);
        while (idx !== -1) {
          items++;
          idx = seg.indexOf(itemToken, idx + itemToken.length);
        }
        carry = seg.slice(-(itemToken.length - 1));
      }
      if (Date.now() - lastBeat >= 3000) {
        lastBeat = Date.now();
        onHeartbeat({ chars, items });
      }
    });
    // Thinking phases emit no text for minutes; any stream event proves liveness
    stream.on('streamEvent', () => {
      if (Date.now() - lastBeat >= 15000) {
        lastBeat = Date.now();
        onHeartbeat({ chars, items });
      }
    });
  }

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(`Model ${model} refused the request`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Model ${model} hit max_tokens (${maxTokens}) — output truncated`);
  }

  const textBlock = message.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text'
  );
  if (!textBlock) {
    throw new Error(`No text response from ${model}`);
  }

  const data = JSON.parse(textBlock.text) as T;
  return {
    data,
    usage: {
      modelUsed: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

export function sumUsage(usages: AIUsage[]): AIUsage {
  return {
    modelUsed: usages.length ? usages[usages.length - 1].modelUsed : 'none',
    inputTokens: usages.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: usages.reduce((s, u) => s + u.outputTokens, 0),
  };
}
