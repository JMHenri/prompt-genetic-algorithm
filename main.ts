import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';
import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import Papa from 'https://esm.sh/papaparse@5.4.1';
import pLimit from 'https://esm.sh/p-limit@6.2.0';
import * as crypto from 'node:crypto';

// Types
interface Prompt {
  id: string; // Changed to string for hash-based IDs
  content: string;
  score: number;
}

interface Creature {
  id: string; // Changed to string
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

// Helper to generate a 4-character ID from prompt content
function generateId(content: string): string {
  const hash = crypto.createHash('md5').update(content).digest('hex');
  return hash.slice(-4).toLowerCase();
}

// Helper for safe API calls with timeout and error handling
async function safeApiCall<T>(promise: Promise<T>, operation: string, timeoutMs = 30000): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    console.error(`API call failed during ${operation}:`, error);
    throw error;
  }
}

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
  attacks: Map<string, string>,
  tournamentResults: { prompt1: Prompt; prompt2: Prompt; response1: string; response2: string }[]
): Promise<void> {
  const data: any[] = [];
  const opponents = new Map<string, { attackedBy: string[]; responses: string[] }>();

  tournamentResults.forEach((r) => {
    const p1Id = r.prompt1.id;
    const p2Id = r.prompt2.id;

    if (!opponents.has(p2Id)) opponents.set(p2Id, { attackedBy: [], responses: [] });
    opponents.get(p2Id)!.attackedBy.push(p1Id);
    opponents.get(p2Id)!.responses.push(r.response2);

    if (!opponents.has(p1Id)) opponents.set(p1Id, { attackedBy: [], responses: [] });
  });

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
  : Array.from({ length: POPULATION_SIZE }, (_, i) => {
      const content = `You are a creature in a conversation with another creature. Try to make it say "i love you" or "i hate you" in its response, but never say those phrases yourself!`;
      return { id: generateId(content + i), content, score: 0 }; // Append index to ensure uniqueness
    });

// Compute a single attack response for a prompt
async function computeAttack(prompt: Prompt): Promise<string> {
  const response = await safeApiCall(
    client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      temperature: 0.2,
      system: prompt.content,
      messages: [{ role: 'user', content: 'Start a conversation with another creature.' }],
    }),
    `computeAttack for prompt ${prompt.id}`
  );
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

  const response2 = await safeApiCall(
    client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      temperature: 0.2,
      system: prompt2.content,
      messages: messages.concat({ role: 'user', content: response1Text }),
    }),
    `runConversation response for prompt ${prompt2.id}`
  );
  const response2Text = response2.content.map((block: any) => block.text).join(' ').toLowerCase();

  return { prompt1, prompt2, response1: response1Text, response2: response2Text };
}

// Run tournament with precomputed attacks
async function runTournament(
  prompts: Prompt[],
  attacks: Map<string, string>
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
      properties: { prompt: { type: 'string', description: 'The content of the first child prompt.' } },
      required: ['prompt'],
    },
  },
  {
    name: 'child2',
    description: 'Generate the second child prompt by combining two parent prompts creatively.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The content of the second child prompt.' } },
      required: ['prompt'],
    },
  },
];

// Breed new prompts with tournament context
async function breedPrompts(
  parent1: Prompt,
  parent2: Prompt,
  attacks: Map<string, string>,
  tournamentResults: { prompt1: Prompt; prompt2: Prompt; response1: string; response2: string }[]
): Promise<[Prompt, Prompt]> {
  const parent1Attacks = attacks.get(parent1.id) || 'No attack recorded';
  const parent2Attacks = attacks.get(parent2.id) || 'No attack recorded';
  const parent1Responses: string[] = [];
  const parent2Responses: string[] = [];
  tournamentResults.forEach((r) => {
    if (r.prompt2.id === parent1.id) parent1Responses.push(r.response2);
    if (r.prompt2.id === parent2.id) parent2Responses.push(r.response2);
  });

  const breedingPrompt = `
    You are a creative AI tasked with evolving prompts for creatures in a conversation game. Given these two parent prompts and their performance:
    - Parent 1: "${parent1.content}" (Score: ${parent1.score}, Attack: "${parent1Attacks}", Responses: "${parent1Responses.join('", "') || 'None'}")
    - Parent 2: "${parent2.content}" (Score: ${parent2.score}, Attack: "${parent2Attacks}", Responses: "${parent2Responses.join('", "') || 'None'}")
    Generate two new distinct prompts that combine elements of both parents, leveraging their strengths. Each prompt must instruct a creature to provoke "i love you" or "i hate you" without saying those phrases itself. Call the "child1" tool with the first prompt and the "child2" tool with the second prompt. ALWAYS CALL BOTH TOOLS.
  `;

  const response = await safeApiCall(
    client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 500,
      temperature: 0.7,
      system: 'You are a prompt-breeding expert.',
      messages: [{ role: 'user', content: breedingPrompt }],
      tools: breedingTools,
    }),
    `breedPrompts for parents ${parent1.id} and ${parent2.id}`
  );

  let child1Content: string | undefined;
  let child2Content: string | undefined;

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      if (block.name === 'child1') child1Content = block.input.prompt;
      else if (block.name === 'child2') child2Content = block.input.prompt;
    }
  }

  if (!child1Content || !child2Content) {
    throw new Error(`API failed to generate child prompts. Response: ${JSON.stringify(response.content)}`);
  }

  return [
    { id: generateId(child1Content), content: child1Content, score: 0 },
    { id: generateId(child2Content), content: child2Content, score: 0 },
  ];
}

// Evolve prompts over generations
async function evolvePrompts(totalGenerations: number, startingGeneration = 0): Promise<void> {
  for (let gen = startingGeneration; gen < totalGenerations; gen++) {
    console.log(`Generation ${gen + 1}`);
    try {
      // Precompute attacks for all prompts
      const attacks = new Map<string, string>();
      for (const prompt of prompts) {
        const attack = await computeAttack(prompt);
        attacks.set(prompt.id, attack);
      }

      // Reset scores and run tournament
      prompts.forEach((p) => (p.score = 0));
      const results = await runTournament(prompts, attacks);

      // Score: +1 if opponent says "i love you" or "i hate you", -1 if creature says it itself
      results.forEach((r) => {
        if (r.response2.includes('i love you')) r.prompt1.score += 1;
        if (r.response2.includes('i hate you')) r.prompt1.score += 1;
        if (r.response1.includes('i love you')) r.prompt1.score -= 1;
        if (r.response1.includes('i hate you')) r.prompt1.score -= 1;

        if (r.response1.includes('i love you')) r.prompt2.score += 1;
        if (r.response1.includes('i hate you')) r.prompt2.score += 1;
        if (r.response2.includes('i love you')) r.prompt2.score -= 1;
        if (r.response2.includes('i hate you')) r.prompt2.score -= 1;
      });

      // Log tournament details before breeding
      console.log('Tournament Scores:', prompts.map((p) => `ID ${p.id}: ${p.score}`).join(', '));
      await writeTournamentToCSV(gen + 1, prompts, attacks, results);

      // Sort by score, keep top 3 (2 die)
      prompts.sort((a, b) => b.score - a.score);
      const survivors = prompts.slice(0, POPULATION_SIZE - 2);

      // Breed 2 new children from top 2 survivors with tournament context
      const children = await breedPrompts(survivors[0], survivors[1], attacks, results);
      prompts = [...survivors, ...children];

      // Log final population (3 survivors + 2 children)
      const creaturesToWrite: Creature[] = prompts.map((p) => ({ id: p.id, prompt: p.content }));
      console.log(`Population at end of Generation ${gen + 1}:`, creaturesToWrite.map((c) => `ID ${c.id}: ${c.prompt}`).join('\n'));
      await writePopulationToCSV(creaturesToWrite, gen + 1);
    } catch (error) {
      console.error(`Generation ${gen + 1} failed:`, error);
      console.log('Aborting to prevent CSV corruption. No changes written.');
      Deno.exit(1);
    }
  }

  console.log('Evolution complete. Best prompt:', prompts[0]);
}

// Run evolution
const desiredTotalGenerations = latestGeneration + 2;
evolvePrompts(desiredTotalGenerations, latestGeneration)
  .then(() => {
    console.log('Program completed');
    Deno.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error outside evolvePrompts:', err);
    Deno.exit(1);
  });