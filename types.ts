export interface Prompt {
  id: number;
  content: string;
  score: number;
}

export interface Creature {
  id: number;
  prompt: string;
}