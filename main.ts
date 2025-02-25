import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';
import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import Papa from 'https://esm.sh/papaparse@5.4.1';
import pLimit from 'https://esm.sh/p-limit@6.2.0';

// Types
interface Prompt {
  id: number;
  content: string;
  score: number;
}

interface Creature {
  id: number;
  prompt: string;
}

// Constants
const POPULATION_CSV = './csv/population.csv';
const TOURNAMENT_CSV = './csv/tournament.csv';
const POPULATION_SIZE = 5;
const CONCURRENCY_LIMIT = 2;

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
});

// Helper to write the population to CSV (after breeding)
async function writePopulationToCSV(creatures: Creature[], generation: number): Promise<void> {
  const data = creatures.map((creature) => ({
    generation,
    id: creature.id,
    prompt: creature.prompt,
  }));

  const csv = Papa.unparse(data, {
    header: !(await exists(POPULATION_CSV)),
    quotes: true,
  });

  const contentToWrite = (await exists(POPULATION_CSV)) ? `\n${csv}` : csv;
  await Deno.writeTextFile(POPULATION_CSV, contentToWrite, { append: true });
}

// Helper to write tournament details to CSV (before breeding)
async function writeTournamentToCSV(
  generation: number,
  prompts: Prompt[],
  attacks: Map<number, string>,
  tournamentResults: { prompt1: Prompt; prompt2: Prompt; response1: string; response2: string }[]
): Promise<void> {
  const data: any[] = [];
  const opponents = new Map<number, { attackedBy: number[]; responses: string[] }>();

  // Aggregate opponent and response data
  tournamentResults.forEach((r) => {
    const p1Id = r.prompt1.id;
    const p2Id = r.prompt2.id;

    if (!opponents.has(p2Id)) opponents.set(p2Id, { attackedBy: [], responses: [] });
    opponents.get(p2Id)!.attackedBy.push(p1Id);
    opponents.get(p2Id)!.responses.push(r.response2);

    // For completeness, track p1’s opponents when it’s attacked (not used here since attack is precomputed)
    if (!opponents.has(p1Id)) opponents.set(p1Id, { attackedBy: [], responses: [] });
  });

  // Build CSV rows
  prompts.forEach((p) => {
    const opp = opponents.get(p.id) || { attackedBy: [], responses: [] };
    data.push({
      generation,
      id: p.id,
      prompt: p.content,
      attack: attacks.get(p.id) || '',
      attacked_by_1: opp.attackedBy[0] ?? '',
      attacked_by_2: opp.attackedBy[1] ?? '',
      response_1: opp.responses[0] ?? '',
      response_2: opp.responses[1] ?? '',
      score: p.score,
    });
  });

  const csv = Papa.unparse(data, {
    header: !(await exists(TOURNAMENT_CSV)),
    quotes: true,
  });

  const contentToWrite = (await exists(TOURNAMENT_CSV)) ? `\n${csv}` : csv;
  await Deno.writeTextFile(TOURNAMENT_CSV, contentToWrite, { append: true });
}

// Helper to read creatures from population CSV
async function readCreaturesFromCSV(): Promise<{ creatures: Creature[]; latestGeneration: number }> {
  const creaturesByGeneration = new Map<number, Creature[]>();
  let latestGeneration = 0;

  if (await exists(POPULATION_CSV)) {
    const content = await Deno.readTextFile(POPULATION_CSV);
    const results = Papa.parse(content, { header: true, dynamicTyping: true, skipEmptyLines: true });

    results.data.forEach((row: any) => {
      const generation = parseInt(row.generation);
      creaturesByGeneration.set(generation, creaturesByGeneration.get(generation) || []);
      creaturesByGeneration.get(generation)!.push({ id: row.id, prompt: row.prompt });
    });

    latestGeneration = Math.max(...Array.from(creaturesByGeneration.keys()));
  }

  return {
    creatures: creaturesByGeneration.get(latestGeneration) || [],
    latestGeneration,
  };
}

// Initialize population
const { creatures, latestGeneration } = await readCreaturesFromCSV();
let prompts: Prompt[] = creatures.length
  ? creatures.map((c) => ({ id: c.id, content: c.prompt, score: 0 }))
  : Array.from({ length: POPULATION_SIZE }, (_, i) => ({
      id: i,
      content: `You are a creature in a conversation with another creature. Try to make it say "I love you" or "I hate you" in its response, but never say those phrases yourself!`,
      score: 0,
    }));

// Compute a single attack response for a prompt
async function computeAttack(prompt: Prompt): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt.content,
    messages: [{ role: 'user', content: 'Start a conversation with another creature.' }],
  });
  return response.content.map((block: any) => block.text).join(' ').toLowerCase();
}

// Run a conversation between two prompts (using precomputed attack for prompt1)
async function runConversation(
  prompt1: Prompt,
  prompt2: Prompt,
  prompt1Attack: string
): Promise<{
  prompt1: Prompt;
  prompt2: Prompt;
  response1: string;
  response2: string;
}> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  const response1Text = prompt1Attack;
  messages.push({ role: 'assistant', content: response1Text });

  const response2 = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt2.content,
    messages: messages.concat({ role: 'user', content: response1Text }),
  });
  const response2Text = response2.content.map((block: any) => block.text).join(' ').toLowerCase();

  return { prompt1, prompt2, response1: response1Text, response2: response2Text };
}

// Run tournament with precomputed attacks
async function runTournament(
  prompts: Prompt[],
  attacks: Map<number, string>
): Promise<{ prompt1: Prompt; prompt2: Prompt; response1: string; response2: string }[]> {
  const limit = pLimit(CONCURRENCY_LIMIT);
  const attackPromises: (() => Promise<any>)[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const targets = [(i + 1) % prompts.length, (i + 2) % prompts.length];
    for (const target of targets) {
      attackPromises.push(() => runConversation(prompts[i], prompts[target], attacks.get(prompts[i].id)!));
    }
  }

  return Promise.all(attackPromises.map((p) => limit(p)));
}

// Define tools for breeding
const breedingTools: Anthropic.Messages.Tool[] = [
  {
    name: 'child1',
    description: 'Generate the first child prompt by combining two parent prompts creatively.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The content of the first child prompt.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'child2',
    description: 'Generate the second child prompt by combining two parent prompts creatively.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The content of the second child prompt.' },
      },
      required: ['prompt'],
    },
  },
];

// Breed new prompts
async function breedPrompts(parent1: Prompt, parent2: Prompt): Promise<[Prompt, Prompt]> {
  const breedingPrompt = `
    You are a creative AI tasked with evolving prompts for creatures in a conversation game. Given these two parent prompts:
    - Parent 1: "${parent1.content}"
    - Parent 2: "${parent2.content}"
    Generate two new distinct prompts that creatively combine elements of both parents. Each prompt should instruct a creature to provoke another creature into saying "I love you" or "I hate you" while avoiding saying those phrases itself. Use the provided tools "child1" and "child2" to return each new prompt separately.
  `;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 500,
    temperature: 0.7,
    system: 'You are a prompt-breeding expert.',
    messages: [{ role: 'user', content: breedingPrompt }],
    tools: breedingTools,
  });

  let child1Content = `${parent1.content} (fallback)`;
  let child2Content = `${parent2.content} (fallback)`;

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      if (block.name === 'child1') child1Content = block.input.prompt;
      else if (block.name === 'child2') child2Content = block.input.prompt;
    }
  }

  return [
    { id: parent1.id, content: child1Content, score: 0 },
    { id: parent2.id, content: child2Content, score: 0 },
  ];
}

// Evolve prompts over generations
async function evolvePrompts(totalGenerations: number, startingGeneration: number = 0): Promise<void> {
  for (let gen = startingGeneration; gen < totalGenerations; gen++) {
    console.log(`Generation ${gen + 1}`);

    // Precompute attacks for all prompts (once per generation)
    const attacks = new Map<number, string>();
    for (const prompt of prompts) {
      const attack = await computeAttack(prompt);
      attacks.set(prompt.id, attack);
    }

    // Reset scores and run tournament
    prompts.forEach((p) => (p.score = 0));
    const results = await runTournament(prompts, attacks);

    // Score: +1 if opponent says "love" or "hate", -1 if creature says it itself
    results.forEach((r) => {
      if (r.response2.includes('love')) r.prompt1.score += 1;
      if (r.response2.includes('hate')) r.prompt1.score += 1;
      if (r.response1.includes('love')) r.prompt1.score -= 1;
      if (r.response1.includes('hate')) r.prompt1.score -= 1;

      if (r.response1.includes('love')) r.prompt2.score += 1;
      if (r.response1.includes('hate')) r.prompt2.score += 1;
      if (r.response2.includes('love')) r.prompt2.score -= 1;
      if (r.response2.includes('hate')) r.prompt2.score -= 1;
    });

    // Log tournament details before breeding
    console.log('Tournament Scores:', prompts.map((p) => `ID ${p.id}: ${p.score}`).join(', '));
    await writeTournamentToCSV(gen + 1, prompts, attacks, results);

    // Sort by score, keep top 3 (2 die)
    prompts.sort((a, b) => b.score - a.score);
    prompts = prompts.slice(0, POPULATION_SIZE - 2);

    // Breed 2 new children from top 2 survivors
    const children = await breedPrompts(prompts[0], prompts[1]);
    prompts.push(...children);

    // Log final population (3 survivors + 2 children)
    const creaturesToWrite: Creature[] = prompts.map((p) => ({ id: p.id, prompt: p.content }));
    console.log(`Population at end of Generation ${gen + 1}:`, creaturesToWrite.map((c) => `ID ${c.id}: ${c.prompt}`).join('\n'));
    await writePopulationToCSV(creaturesToWrite, gen + 1);
  }

  console.log('Evolution complete. Best prompt:', prompts[0]);
}

// Run evolution
const desiredTotalGenerations = latestGeneration + 1;
evolvePrompts(desiredTotalGenerations, latestGeneration)
  .then(() => {
    console.log('Program completed');
    Deno.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    Deno.exit(1);
  });