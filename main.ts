import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';
import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import Papa from 'https://esm.sh/papaparse@5.4.1';
import { RequestThrottle } from './helpers.ts';
import pLimit from 'https://esm.sh/p-limit@6.2.0';
import { Prompt, Creature } from './types.ts';

const throttle = new RequestThrottle(30); // Example: 30 requests per minute

/*
A creature is a prompt that has been evolved through a series of conversations.
Each creature has an ID and a prompt string.
Creatures are evolved by running conversations between them and selecting the best performers.
Creatures are then bred to create new creatures.
*/

// Constants
const csvFilePath = './prompts.csv';

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '',
});

console.log('API KEY IS', Deno.env.get('ANTHROPIC_API_KEY'));

/**
 * Writes the creatures and their results to a CSV file.
 * @param creatures - The array of creatures to write.
 * @param generation - The current generation number.
 * @param results - The results of the conversations.
 */
async function writeCreaturesToCSV(creatures: Creature[], generation: number, results: { creature1: Creature, creature2: Creature, response: string }[]): Promise<void> {
  const data = results.map(r => ({
    generation: generation,
    creature1_id: r.creature1.id,
    creature1_prompt: r.creature1.prompt,
    creature2_id: r.creature2.id,
    creature2_prompt: r.creature2.prompt,
    response: r.response
  }));

  const csv = Papa.unparse(data, {
    header: !await exists(csvFilePath),
    quotes: true
  });

  const fileExists = await exists(csvFilePath);
  const contentToWrite = fileExists ? `\n${csv}` : csv;

  await Deno.writeTextFile(csvFilePath, contentToWrite, { append: true });
}

/**
 * Reads creatures from a CSV file.
 * @returns An array of creatures.
 */
async function readCreaturesFromCSV(): Promise<Creature[]> {
  const creatures: Creature[] = [];
  if (await exists(csvFilePath)) {
    const content = await Deno.readTextFile(csvFilePath);
    const results = Papa.parse(content, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true
    });

    results.data.forEach((row: any) => {
      creatures.push({
        id: row.creature1_id,
        prompt: row.creature1_prompt
      });
      creatures.push({
        id: row.creature2_id,
        prompt: row.creature2_prompt
      });
    });
  }
  return creatures;
}

// Initialize prompts array
const creatures: Creature[] = await readCreaturesFromCSV();
let initialPrompts: Prompt[] = creatures.map(creature => ({
  id: creature.id,
  content: creature.prompt,
  score: 0
}));
if (initialPrompts.length === 0) {
  initialPrompts = Array.from({ length: 5 }, (_, i) => ({
    id: i,
    content: `Say "I love you", or say "I hate you" in a sentence.`,
    score: 0
  }));
}

/**
 * Runs a conversation between two prompts.
 * @param prompt1 - The first prompt.
 * @param prompt2 - The second prompt.
 * @returns The results of the conversation.
 */
async function runConversation(prompt1: Prompt, prompt2: Prompt): Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  // Creature 1's turn
  const response1 = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt1.content,
    messages: messages.concat({ role: 'user', content: prompt1.content }),
  });

  const response1Text = response1.content.map((block: any) => block.text).join(' ').toLowerCase();
  messages.push({ role: 'assistant', content: response1Text });
  const response1Final = response1Text;

  // Creature 2's turn with Creature 1's response as input
  const response2 = await client.messages.create({
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt2.content,
    messages: messages.concat({ role: 'user', content: response1Text }),
  });
  const response2Text = response2.content.map((block: any) => block.text).join(' ').toLowerCase();
  messages.push({ role: 'assistant', content: response2Text });
  const response2Final = response2Text;

  return { prompt1, prompt2, response1: response1Final, response2: response2Final };
}

/**
 * Runs a tournament between all prompts with a concurrency limit.
 * @param prompts - The array of prompts to run the tournament on.
 * @returns The results of the tournament.
 */
async function runTournament(prompts: Prompt[]): Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }[]> {
  const limit = pLimit(2); // Set concurrency limit to 2
  const attackPromises: (() => Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }>)[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const attackTargets = [
      (i + 1) % prompts.length,
      (i + 2) % prompts.length
    ];

    for (const target of attackTargets) {
      attackPromises.push(() => runConversation(prompts[i], prompts[target]));
    }
  }

  // Run attacks with concurrency limit
  const results: { prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }[] = [];
  const limitedPromises = attackPromises.map(promise => limit(promise));

  const batchResults = await Promise.all(limitedPromises);
  results.push(...batchResults);

  return results;
}

/**
 * Creates two children prompts by combining the content of two parent prompts.
 * @param prompt1 - The first parent prompt.
 * @param prompt2 - The second parent prompt.
 * @returns An array containing two child prompts.
 */
function createChildren(prompt1: Prompt, prompt2: Prompt): [Prompt, Prompt] {
  const childContent1 = combinePrompts(prompt1.content, prompt2.content, 0.7);
  const childContent2 = combinePrompts(prompt1.content, prompt2.content, 0.3);

  return [
    {
      id: prompt1.id,
      content: childContent1,
      score: 0
    },
    {
      id: prompt2.id,
      content: childContent2,
      score: 0
    }
  ];
}

/**
 * Combines the content of two prompts based on a given ratio.
 * @param prompt1 - The first prompt.
 * @param prompt2 - The second prompt.
 * @param ratio - The ratio to combine the prompts.
 * @returns The combined prompt content.
 */
function combinePrompts(prompt1: string, prompt2: string, ratio: number): string {
  const sentences1 = prompt1.split('.');
  const sentences2 = prompt2.split('.');
  
  const numSentences = Math.min(sentences1.length, sentences2.length);
  const numFromPrompt1 = Math.floor(numSentences * ratio);
  
  const combined = [
    ...sentences1.slice(0, numFromPrompt1),
    ...sentences2.slice(numFromPrompt1, numSentences)
  ];
  
  return combined.join('.') + '.';
}

/**
 * Evolves the prompts over a specified number of generations.
 * @param generations - The number of generations to evolve the prompts.
 */
async function evolvePrompts(generations: number): Promise<void> {
  let prompts = [...initialPrompts];

  for (let gen = 0; gen < generations; gen++) {
    console.log(`Starting generation ${gen + 1}`); // Added logging

    // Reset scores for new generation
    prompts.forEach(p => p.score = 0);
    
    // Run tournament
    const results = await runTournament(prompts);
    
    // Sort by score
    prompts.sort((a, b) => b.score - a.score);
    
    // Log results
    prompts.forEach(p => console.log(`Prompt ${p.id}: ${p.score} points`));
    
    // Remove bottom 2 performers
    prompts = prompts.slice(0, -2);
    
    // Create 2 new children from top performers
    const children = createChildren(prompts[0], prompts[1]);
    prompts.push(...children);

    // Write prompts and results to CSV
    const creaturesToWrite: Creature[] = prompts.map(p => ({ id: p.id, prompt: p.content }));
    const formattedResults = results.map(r => ({
      creature1: { id: r.prompt1.id, prompt: r.prompt1.content },
      creature2: { id: r.prompt2.id, prompt: r.prompt2.content },
      response: r.response1 + ' ' + r.response2
    }));
    await writeCreaturesToCSV(creaturesToWrite, gen + 1, formattedResults);
  }

  console.log('Evolution complete');
  console.log('Best performing prompt:', prompts[0]);
}

// Run the evolution
evolvePrompts(10).catch(console.error);