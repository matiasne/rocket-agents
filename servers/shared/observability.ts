import { LangfuseExporter } from '@mastra/langfuse'
import { Observability } from '@mastra/observability'

// Sends every agent run (LLM calls, tool calls, tokens, inputs and outputs) to Langfuse.
// The exporter reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL.
// Without the keys tracing stays off and the servers run as before.
export function createObservability(serviceName: string) {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return undefined
  return new Observability({
    configs: {
      langfuse: {
        serviceName,
        // `realtime` flushes after every event, so traces show up while you watch.
        exporters: [new LangfuseExporter({ realtime: process.env.NODE_ENV !== 'production' })],
      },
    },
  })
}
