import type { MastraModelConfig } from '@mastra/core/llm'

// Any Mastra model router string works, e.g. "openai/gpt-..." with OPENAI_API_KEY.
const MODEL_ID = process.env.MODEL ?? 'anthropic/claude-haiku-5-5'

// With BIFROST_URL set, every LLM call goes through the Bifrost gateway (its OpenAI-compatible
// endpoint) instead of straight to the provider. Bifrost holds the provider keys, so the servers
// need none. Mastra drops the first segment of the id and sends the rest ("anthropic/claude-...")
// as the model name, which is the provider/model form Bifrost expects.
// BIFROST_VIRTUAL_KEY is optional: Bifrost only checks it when virtual keys are enforced.
export const MODEL: MastraModelConfig = process.env.BIFROST_URL
  ? {
      id: `bifrost/${MODEL_ID}`,
      url: `${process.env.BIFROST_URL.replace(/\/$/, '')}/v1`,
      apiKey: process.env.BIFROST_VIRTUAL_KEY ?? 'bifrost',
    }
  : (MODEL_ID as MastraModelConfig)
