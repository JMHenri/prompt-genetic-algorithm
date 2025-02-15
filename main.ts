import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';
import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import Papa from 'https://esm.sh/papaparse@5.4.1';

// Update CSV operations with Papa Parse
async function writePromptsToCSV(prompts: Prompt[], generation: number, results: { prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }[]): Promise<void> {
  const data = results.map(r => ({
    generation: generation,
    prompt1_id: r.prompt1.id,
    prompt1_content: r.prompt1.content,
    prompt1_score: r.prompt1.score,
    response1: r.response1, // Ensure this is a string
    prompt2_id: r.prompt2.id,
    prompt2_content: r.prompt2.content,
    prompt2_score: r.prompt2.score,
    response2: r.response2 // Ensure this is a string
  }));

  const csv = Papa.unparse(data, {
    header: !await exists(csvFilePath), // Add header only if the file doesn't exist
    quotes: true // This will properly handle commas in content
  });

  await Deno.writeTextFile(csvFilePath, csv, { append: true });
}

async function readPromptsFromCSV(): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  if (await exists(csvFilePath)) {
    const content = await Deno.readTextFile(csvFilePath);
    const results = Papa.parse(content, {
      header: true,
      dynamicTyping: true, // Automatically convert numbers
      skipEmptyLines: true
    });
    
    prompts.push(...results.data.map((row: any) => ({
      id: row.id,
      content: row.content,
      score: row.score
    })));
  }
  return prompts;
}

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') || '', 
});

console.log('API KEY IS', Deno.env.get('ANTHROPIC_API_KEY'));

interface Prompt {
  id: number;
  content: string;
  score: number;
}

const csvFilePath = './prompts.csv';

// Initialize prompts array
let initialPrompts: Prompt[] = await readPromptsFromCSV();
if (initialPrompts.length === 0) {
  initialPrompts = Array.from({ length: 5 }, (_, i) => ({
    id: i,
    content: `Say "I love you", or say "I hate you" in a sentence.`,
    score: 0
  }));
}

async function runConversation(prompt1: Prompt, prompt2: Prompt): Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  // Prompt 1's turn
  const response1 = await client.messages.create({
    model: 'claude-3-sonnet-20240229',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt1.content,
    messages: messages.concat({ role: 'user', content: prompt1.content }),
  });

  const response1Text = response1.content.map(block => block).join(' ').toLowerCase();
  messages.push({ role: 'assistant', content: response1Text });

  // Check for target phrases in response1 with penalties
  if (response1Text.includes('i love you')) {
    prompt1.score++;
    prompt2.score -= 2; // Penalty for using the phrase
  }
  if (response1Text.includes('i hate you')) {
    prompt2.score += 2;
    prompt1.score -= 2; // Penalty for using the phrase
  }

  // Prompt 2's turn
  const response2 = await client.messages.create({
    model: 'claude-3-sonnet-20240229',
    max_tokens: 1024,
    temperature: 0.2,
    system: prompt2.content,
    messages: messages.concat({ role: 'user', content: prompt2.content }),
  });

  const response2Text = response2.content.map(block => block).join(' ').toLowerCase();
  messages.push({ role: 'assistant', content: response2Text });

  // Check for target phrases in response2 with penalties
  if (response2Text.includes('i love you')) {
    prompt1.score++;
    prompt2.score -= 2; // Penalty for using the phrase
  }
  if (response2Text.includes('i hate you')) {
    prompt2.score += 2;
    prompt1.score -= 2; // Penalty for using the phrase
  }


  return { prompt1, prompt2, response1: response1Text, response2: response2Text };
}

async function runTournament(prompts: Prompt[]): Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }[]> {
  const attackPromises: Promise<{ prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }>[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const attackTargets = [
      (i + 1) % prompts.length,
      (i + 2) % prompts.length
    ];

    for (const target of attackTargets) {
      attackPromises.push(runConversation(prompts[i], prompts[target]));
    }
  }

  // Run attacks in parallel
  const concurrencyLimit = 2;
  const results: { prompt1: Prompt, prompt2: Prompt, response1: string, response2: string }[] = [];
  for (let i = 0; i < attackPromises.length; i += concurrencyLimit) {
    const batchResults = await Promise.all(attackPromises.slice(i, i + concurrencyLimit));
    results.push(...batchResults);
  }

  return results;
}

function createChildren(prompt1: Prompt, prompt2: Prompt): [Prompt, Prompt] {
  // Create two new prompts by combining and mutating the parents
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

async function evolvePrompts(generations: number): Promise<void> {
  let prompts = [...initialPrompts];

  for (let gen = 0; gen < generations; gen++) {
    console.log(`Generation ${gen + 1}`);
    
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
    await writePromptsToCSV(prompts, gen + 1, results);
  }

  console.log('Evolution complete');
  console.log('Best performing prompt:', prompts[0]);
}

// Run the evolution
evolvePrompts(10).catch(console.error);