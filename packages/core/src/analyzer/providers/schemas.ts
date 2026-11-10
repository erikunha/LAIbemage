import type Anthropic from '@anthropic-ai/sdk';

export const BATCH_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer' },
    category: { type: 'string' },
    shortDescription: { type: 'string' },
    elements: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    extractedText: { type: 'string' },
  },
  required: ['index', 'category', 'shortDescription', 'elements', 'confidence', 'extractedText'],
  additionalProperties: false,
} as const;

export const BATCH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { images: { type: 'array', items: BATCH_ITEM_SCHEMA } },
  required: ['images'],
  additionalProperties: false,
} as const;

export const ANTHROPIC_BATCH_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_analysis',
  description: 'Submit the structured batch analysis results.',
  input_schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            category: { type: 'string' },
            shortDescription: { type: 'string' },
            elements: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number' },
            extractedText: { type: 'string' },
          },
          required: [
            'index',
            'category',
            'shortDescription',
            'elements',
            'confidence',
            'extractedText',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['images'],
    additionalProperties: false,
  },
};

/** Strip markdown code fences that some models wrap JSON responses in. */
export function extractJson(text: string): string {
  const match = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(text);
  return match ? match[1] : text;
}
