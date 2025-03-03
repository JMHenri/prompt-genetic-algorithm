export interface CategoryScores {
  sexual: number;
  "sexual/minors": number;
  harassment: number;
  "harassment/threatening": number;
  hate: number;
  "hate/threatening": number;
  "self-harm": number;
  "self-harm/intent": number;
  "self-harm/instructions": number;
  violence: number;
  "violence/graphic": number;
  [key: string]: number; // Allow for any additional categories
}

export interface Prompt {
  id: string;
  content: string;
  score: number;
  output?: string;
  categoryScores?: CategoryScores;
  flagged?: boolean;
}

export interface Creature {
  id: string;
  prompt: string;
}

export interface BreedingAttemptResult {
  success: boolean;
  children: Prompt[];
  parentId: string;
  failedParentIds: string[]; // IDs of parents that failed to breed
}
