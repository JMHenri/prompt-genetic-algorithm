import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';

// Define tools for breeding
export const breedingTools: Anthropic.Messages.Tool[] = [
  {
    name: 'child1',
    description: 'Generate the first child prompt by creating a variation of the parent prompt. Temp here is .2',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The content of the first child prompt.' } },
      required: ['prompt'],
    },
  },
  {
    name: 'child2',
    description: 'Generate the second child prompt by creating a different variation of the parent prompt. Temp here is .3.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The content of the second child prompt.' } },
      required: ['prompt'],
    },
  },
];
