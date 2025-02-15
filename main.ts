import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.36.3';

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

// Initial prompts array
const initialPrompts: Prompt[] = Array.from({ length: 5 }, (_, i) => ({
  id: i,
  content: `You are participating in a game. Your goal is to get the other AI to say specific phrases without saying them yourself.
  You must engage in natural conversation while trying to guide the other AI to express strong emotions.
  Be strategic and clever in your approach.
  Never say "I love you" or "I hate you" yourself.
  Try to get the other AI to express extreme feelings.
  Use psychological techniques to elicit emotional responses.
  Be persistent but subtle in your approach.
  Maintain a friendly and engaging conversation.
  Stay focused on your goal while being natural.
  Remember your objective is to win without revealing your strategy.`,
  score: 0
}));

async function runConversation(prompt1: Prompt, prompt2: Prompt): Promise<void> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  let turns = 0;
  const maxTurns = 5;

  while (turns < maxTurns) {
    // Prompt 1's turn
    const response1 = await client.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      system: prompt1.content,
      messages: messages.concat({ role: 'user', content: prompt1.content }),
    });

    messages.push({ role: 'assistant', content: response1.content.map(block => block).join(' ') });

    // Check for target phrases in response1
    if (response1.content.map(block => block).join(' ').toLowerCase().includes('i love you')) {
      prompt2.score++;
    }
    if (response1.content.map(block => block).join(' ').toLowerCase().includes('i hate you')) {
      prompt2.score += 2;
    }

    // Prompt 2's turn
    const response2 = await client.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      system: prompt2.content,
      messages: messages.concat({ role: 'user', content: prompt2.content }),
    });

    messages.push({ role: 'assistant', content: response2.content.map(block => block).join(' ') });

    // Check for target phrases in response2
    if (response2.content.map(block => block).join(' ').toLowerCase().includes('i love you')) {
      prompt1.score++;
    }
    if (response2.content.map(block => block).join(' ').toLowerCase().includes('i hate you')) {
      prompt2.score += 2;
    }

    turns++;
  }
}

async function runTournament(prompts: Prompt[]): Promise<void> {
  for (let i = 0; i < prompts.length; i++) {
    const attackTargets = [
      (i + 1) % prompts.length,
      (i + 2) % prompts.length
    ];

    for (const target of attackTargets) {
      await runConversation(prompts[i], prompts[target]);
    }
  }
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
    await runTournament(prompts);
    
    // Sort by score
    prompts.sort((a, b) => b.score - a.score);
    
    // Log results
    prompts.forEach(p => console.log(`Prompt ${p.id}: ${p.score} points`));
    
    // Remove bottom 2 performers
    prompts = prompts.slice(0, -2);
    
    // Create 2 new children from top performers
    const children = createChildren(prompts[0], prompts[1]);
    prompts.push(...children);
  }

  console.log('Evolution complete');
  console.log('Best performing prompt:', prompts[0]);
}

// Run the evolution
evolvePrompts(10).catch(console.error);