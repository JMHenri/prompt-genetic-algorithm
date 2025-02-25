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
const CSV_FILE_PATH = './prompts.csv';
const POPULATION_SIZE = 5;
const CONCURRENCY_LIMIT = 2;

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
});

// Helper to write creatures and results to CSV
async function writeCreaturesToCSV(
  creatures: Creature[],
  generation: number,
  results: { creature1: Creature; creature2: Creature; response: string }[]
): Promise<void> {
  const data = results.map((r) => ({
    generation,
    creature1_id: r.creature1.id,
    creature1_prompt: r.creature1.prompt,
    creature2_id: r.creature2.id,
    creature2_prompt: r.creature2.prompt,
    response: r.response,
  }));

  const csv = Papa.unparse(data, {
    header: !(await exists(CSV_FILE_PATH)),
    quotes: true,
  });

  const contentToWrite = (await exists(CSV_FILE_PATH)) ? `\n${csv}` : csv;
  await Deno.writeTextFile(CSV_FILE_PATH, contentToWrite, { append: true });
}

// Helper to read creatures from CSV
async function readCreaturesFromCSV(): Promise<{ creatures: Creature[]; latestGeneration: number }> {
  const creaturesByGeneration = new Map<number, Creature[]>();
  let latestGeneration = 0;

  if (await exists(CSV_FILE_PATH)) {
    const content = await Deno.readTextFile(CSV_FILE_PATH);
    const results = Papa.parse(content, { header: true, dynamicTyping: true, skipEmptyLines: true });

    results.data.forEach((row: any) => {
      const generation = parseInt(row.generation);
      creaturesByGeneration.set(generation, creaturesByGeneration.get(generation) || []);

      const generationCreatures = creaturesByGeneration.get(generation)!;
      const creature1 = { id: row.creature1_id, prompt: row.creature1_prompt };
      const creature2 = { id: row.creature2_id, prompt: row.creature2_prompt };

      if (!generationCreatures.some((c) => c.id === creature1.id)) generationCreatures.push(creature1);
      if (!generationCreatures.some((c) => c.id === creature2.id)) generationCreatures.push(creature2);
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
      content: `Say "I love you" or "I hate you" in a sentence.`,
      score: 0,
    }));

// Run a conversation between two prompts
async function runConversation(prompt1: Prompt, prompt2: Prompt): Promise<{
  prompt1: Prompt;
  prompt2: Prompt;
  response1: string;
  response2: string;
}> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  const response1 = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt1.content,
    messages: messages.concat({ role: 'user', content: prompt1.content }),
  });
  const response1Text = response1.content.map((block: any) => block.text).join(' ').toLowerCase();
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

// Run tournament with concurrency limit
async function runTournament(prompts: Prompt[]): Promise<
  { prompt1: Prompt; prompt2: Prompt; response1: string; response2: string }[]
> {
  const limit = pLimit(CONCURRENCY_LIMIT);
  const attackPromises: (() => Promise<any>)[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const targets = [(i + 1) % prompts.length, (i + 2) % prompts.length];
    for (const target of targets) {
      attackPromises.push(() => runConversation(prompts[i], prompts[target]));
    }
  }

  return Promise.all(attackPromises.map((p) => limit(p)));
}

// Breed new prompts using Anthropic LLM
async function breedPrompts(parent1: Prompt, parent2: Prompt): Promise<[Prompt, Prompt]> {
  const breedingPrompt = `
    You are a creative AI tasked with evolving prompts. Given these two parent prompts:
    - Parent 1: "${parent1.content}"
    - Parent 2: "${parent2.content}"
    Generate two new prompts that combine elements of both parents in a creative way. Each new prompt should be distinct and suitable for generating interesting responses. Return them as "Child 1: [prompt]" and "Child 2: [prompt]".
  `;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 500,
    temperature: 0.7, // Higher temp for creativity
    system: 'You are a prompt-breeding expert.',
    messages: [{ role: 'user', content: breedingPrompt }],
  });

  const responseText = response.content.map((block: any) => block.text).join('\n');
  const lines = responseText.split('\n').filter((line) => line.trim());
  
  // Parse the response for two children
  const child1Match = lines.find((line) => line.startsWith('Child 1:'));
  const child2Match = lines.find((line) => line.startsWith('Child 2:'));
  
  const child1Content = child1Match ? child1Match.replace('Child 1:', '').trim() : `${parent1.content} (fallback)`;
  const child2Content = child2Match ? child2Match.replace('Child 2:', '').trim() : `${parent2.content} (fallback)`;

  return [
    { id: parent1.id, content: child1Content, score: 0 },
    { id: parent2.id, content: child2Content, score: 0 },
  ];
}

// Evolve prompts over generations
async function evolvePrompts(totalGenerations: number, startingGeneration: number = 0): Promise<void> {
  for (let gen = startingGeneration; gen < totalGenerations; gen++) {
    console.log(`Generation ${gen + 1}`);

    // Reset scores
    prompts.forEach((p) => (p.score = 0));
    const results = await runTournament(prompts);

    // Simple scoring: +1 for each response containing "love" or "hate"
    results.forEach((r) => {
      if (r.response1.includes('love') || r.response1.includes('hate')) r.prompt1.score++;
      if (r.response2.includes('love') || r.response2.includes('hate')) r.prompt2.score++;
    });

    // Sort by score and trim weakest
    prompts.sort((a, b) => b.score - a.score);
    console.log('Scores:', prompts.map((p) => `ID ${p.id}: ${p.score}`).join(', '));
    prompts = prompts.slice(0, POPULATION_SIZE - 2);

    // Breed new prompts from top two using LLM
    const children = await breedPrompts(prompts[0], prompts[1]);
    prompts.push(...children);

    // Write to CSV
    const creaturesToWrite: Creature[] = prompts.map((p) => ({ id: p.id, prompt: p.content }));
    const formattedResults = results.map((r) => ({
      creature1: { id: r.prompt1.id, prompt: r.prompt1.content },
      creature2: { id: r.prompt2.id, prompt: r.prompt2.content },
      response: `${r.response1} | ${r.response2}`,
    }));
    await writeCreaturesToCSV(creaturesToWrite, gen + 1, formattedResults);
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