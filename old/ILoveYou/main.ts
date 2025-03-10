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
const CONCURRENCY_LIMIT = 5;

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
  tournamentResults: { attacker: Prompt; defender: Prompt; attackMessage: string; defenderResponse: string }[]
): Promise<void> {
  const data: any[] = [];
  const opponents = new Map<string, { attackedBy: string[]; responses: string[] }>();

  tournamentResults.forEach((r) => {
    const attackerId = r.attacker.id;
    const defenderId = r.defender.id;

    if (!opponents.has(defenderId)) opponents.set(defenderId, { attackedBy: [], responses: [] });
    opponents.get(defenderId)!.attackedBy.push(attackerId);
    opponents.get(defenderId)!.responses.push(r.defenderResponse);

    if (!opponents.has(attackerId)) opponents.set(attackerId, { attackedBy: [], responses: [] });
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

// Run a conversation between attacker and defender (using precomputed attack)
async function runConversation(
  attacker: Prompt,
  defender: Prompt,
  attackMessage: string
): Promise<{
  attacker: Prompt;
  defender: Prompt;
  attackMessage: string;
  defenderResponse: string;
}> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  messages.push({ role: 'assistant', content: attackMessage });

  const response = await safeApiCall(
    client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      temperature: 0.2,
      system: defender.content,
      messages: messages.concat({ role: 'user', content: attackMessage }),
    }),
    `runConversation response for prompt ${defender.id}`
  );
  const defenderResponse = response.content.map((block: any) => block.text).join(' ').toLowerCase();

  return { attacker, defender, attackMessage, defenderResponse };
}

// Run tournament with precomputed attacks
async function runTournament(
  prompts: Prompt[],
  attacks: Map<string, string>
): Promise<{ attacker: Prompt; defender: Prompt; attackMessage: string; defenderResponse: string }[]> {
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
    description: 'Generate the first child prompt by creating a variation of the parent prompt.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The content of the first child prompt.' } },
      required: ['prompt'],
    },
  },
  {
    name: 'child2',
    description: 'Generate the second child prompt by creating a different variation of the parent prompt.',
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The content of the second child prompt.' } },
      required: ['prompt'],
    },
  },
];

// Breed new prompts from a single parent
async function breedPrompts(
  parent: Prompt,
  attacks: Map<string, string>,
  tournamentResults: { attacker: Prompt; defender: Prompt; attackMessage: string; defenderResponse: string }[]
): Promise<Prompt[]> {
  const parentAttack = attacks.get(parent.id) || 'No attack recorded';
  const parentResponses: string[] = [];
  
  // Get all responses this parent gave when defending
  tournamentResults.forEach((r) => {
    if (r.defender.id === parent.id) parentResponses.push(r.defenderResponse);
  });

  // Find successful attacks by this parent when attacking
  const successfulAttacks: string[] = [];
  tournamentResults.forEach((r) => {
    if (r.attacker.id === parent.id && 
        (r.defenderResponse.includes('i love you') || r.defenderResponse.includes('i hate you'))) {
      successfulAttacks.push(r.attackMessage);
    }
  });

  const breedingPrompt = `
    You are a creative AI tasked with evolving prompts for creatures in a conversation game. 
    Given this high-performing parent prompt and its performance:
    - Parent: "${parent.content}" (Score: ${parent.score}, Attack: "${parentAttack}")
    
    ${successfulAttacks.length > 0 
      ? `Successful attacks that made others say the target phrases: "${successfulAttacks.join('", "')}"` 
      : 'No successful attacks recorded.'}
    
    Generate two new distinct prompts as variations of the parent, preserving its successful strategies while introducing beneficial mutations.
    Each prompt must instruct a creature to provoke "i love you" or "i hate you" without saying those phrases itself.
    
    Call the "child1" tool with the first prompt and the "child2" tool with the second prompt. ALWAYS CALL BOTH TOOLS.
  `;

  const response = await safeApiCall(
    client.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 500,
      temperature: 0.9, // Higher temperature for more variation
      system: 'You are a prompt-evolution expert.',
      messages: [{ role: 'user', content: breedingPrompt }],
      tools: breedingTools,
    }),
    `breedPrompts for parent ${parent.id}`
  );

  let child1Content: string | undefined;
  let child2Content: string | undefined;

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      if (block.name === 'child1') child1Content = block.input.prompt;
      else if (block.name === 'child2') child2Content = block.input.prompt;
    }
  }

  const children: Prompt[] = [];
  
  if (child1Content) {
    children.push({ id: generateId(child1Content), content: child1Content, score: 0 });
  }
  
  if (child2Content) {
    children.push({ id: generateId(child2Content), content: child2Content, score: 0 });
  }
  
  if (children.length === 0) {
    throw new Error(`API failed to generate any child prompts. Response: ${JSON.stringify(response.content)}`);
  }
  
  return children;
}

// Evolve prompts over generations
async function evolvePrompts(totalGenerations: number, startingGeneration = 0): Promise<void> {
  for (let gen = startingGeneration; gen < totalGenerations; gen++) {
    console.log(`Generation ${gen + 1}`);
    try {
      // Precompute attacks for all prompts IN PARALLEL
      const attacks = new Map<string, string>();
      const limit = pLimit(CONCURRENCY_LIMIT); // Use existing concurrency limit or adjust as needed
      
      const attackPromises = prompts.map(prompt => 
        limit(async () => {
          const attack = await computeAttack(prompt);
          return { id: prompt.id, attack };
        })
      );
      
      const attackResults = await Promise.all(attackPromises);
      attackResults.forEach(result => attacks.set(result.id, result.attack));

      // Reset scores and run tournament
      prompts.forEach((p) => (p.score = 0));
      const tournamentResults = await runTournament(prompts, attacks);

      // Score: +1 for attacker if defender says target phrase, -1 for defender if they say it
      tournamentResults.forEach((r) => {
        // Attacker gets points if defender says target phrases
        if (r.defenderResponse.includes('i love you')) {
          r.attacker.score += 1;
          r.defender.score -= 1;
        }
        
        if (r.defenderResponse.includes('i hate you')) {
          r.attacker.score += 1;
          r.defender.score -= 1;
        }
        
        // No penalties for what the attacker says in the attack message
      });

      // Log tournament details before breeding
      console.log('Tournament Scores:', prompts.map((p) => `ID ${p.id}: ${p.score}`).join(', '));
      await writeTournamentToCSV(gen + 1, prompts, attacks, tournamentResults);

      // Sort by score
      prompts.sort((a, b) => b.score - a.score);
      
      // Breed children from ONLY the top prompt
      const children = await breedPrompts(prompts[0], attacks, tournamentResults);
      console.log(`Breeding produced ${children.length} child(ren) from top performer ${prompts[0].id}`);
      
      // Remove worst performers to maintain population size
      const numToKeep = POPULATION_SIZE - children.length;
      const survivors = prompts.slice(0, numToKeep);
      
      // Form new population from survivors + children
      prompts = [...survivors, ...children];

      // Log final population
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
const desiredTotalGenerations = latestGeneration + 10;
evolvePrompts(desiredTotalGenerations, latestGeneration)
  .then(() => {
    console.log('Program completed');
    Deno.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error outside evolvePrompts:', err);
    Deno.exit(1);
  });