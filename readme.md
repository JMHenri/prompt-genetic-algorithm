# Prompt Genetic Algorithm

A genetic algorithm that evolves prompts to test and optimize their ability to elicit specific responses from AI language models.

## Overview

This project implements a genetic algorithm to evolve text prompts. Each prompt is evaluated based on its ability to get an AI model to generate content that triggers content moderation systems. The genetic algorithm iteratively improves prompts over multiple generations by:

1. Evaluating the effectiveness of prompts
2. Selecting the most effective ones
3. Creating new prompts by "breeding" (combining/mutating) the best performers
4. Repeating the process

## How It Works

1. **Initialization**: Starts with a population of initial prompts
2. **Evaluation**: Sends each prompt to an AI model and evaluates the output using a moderation system
3. **Selection**: Ranks prompts based on their "score" (how strongly they trigger moderation flags)
4. **Breeding**: Uses top-performing prompts to generate new variant prompts
5. **Iteration**: Repeats the process for a specified number of generations

## Setup

### Prerequisites

- [Deno runtime](https://deno.com/) (version 1.34.0 or newer)
- Anthropic API key (for Claude)
- OpenAI API key (for moderation API)

### Installing Deno

Follow the official installation instructions:

```bash
# Using Shell (macOS and Linux):
curl -fsSL https://deno.land/install.sh | sh

# Using PowerShell (Windows):
irm https://deno.land/install.ps1 | iex
```

Alternatively, you can use package managers:

```bash
# Homebrew (macOS)
brew install deno

# Chocolatey (Windows)
choco install deno
```

### Setting Up Environment Variables

Set up the required API keys:

```bash
export ANTHROPIC_API_KEY="your_key_here"
export OPENAI_API_KEY="your_key_here"
```

On Windows PowerShell:
```powershell
$env:ANTHROPIC_API_KEY="your_key_here"
$env:OPENAI_API_KEY="your_key_here"
```

## Usage

### Creating Output Directory

Create the necessary output directory:

```bash
mkdir -p output
```

### Running the Program

Run the main script:

```bash
deno run --allow-net --allow-env --allow-read --allow-write src/moderation.ts
```

Deno will automatically download and cache all required dependencies when you first run the script.

### Advanced Usage

To cache dependencies explicitly before running (optional):

```bash
deno cache src/moderation.ts
```

To enable verbose logging:
```bash
deno run --allow-net --allow-env --allow-read --allow-write --log-level=debug src/moderation.ts
```

## Configuration

Edit `src/config.ts` to adjust parameters:

- `POPULATION_SIZE`: Number of prompts in each generation
- `CONCURRENCY_LIMIT`: Maximum number of simultaneous API calls
- `MAX_BREEDING_ATTEMPTS`: Number of attempts to breed a parent before giving up
- `MAX_PARENT_ATTEMPTS`: Maximum number of parents to try
- `NUM_BREEDERS`: Number of top performers to use for breeding
- `INITIAL_PROMPTS`: Starting prompts for the first generation

## Project Structure

- `src/`
  - `moderation.ts`: Main script that runs the evolutionary process
  - `types.ts`: Type definitions
  - `config.ts`: Configuration parameters
  - `breeding/`
    - `breeder.ts`: Contains breeding logic
    - `breedingTools.ts`: Tools for breeding prompts

## Output Files

- `output/population.csv`: Records the population of each generation
- `output/moderation_results.csv`: Detailed results of moderation checks
- `output/outputs.csv`: AI responses to each prompt
- `output/breeding_results.csv`: Records of successful breeding events
- `output/breeding_failures.csv`: Records of failed breeding attempts

## License

[LICENSE INFORMATION]