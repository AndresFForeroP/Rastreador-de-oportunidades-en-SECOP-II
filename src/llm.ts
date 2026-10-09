import { config } from "dotenv";
import { ChatOpenAI } from "@langchain/openai";

// Load .env when running locally. In Docker, variables come from `env_file`
// and there is no .env inside the image, so this is a silent no-op.
config({ quiet: true });

/** OpenAI-compatible gateway of the Reto Agente 2026 challenge. */
export const RETO_BASE_URL = "https://api.reto.pltk.mx/v1";

/**
 * Grok model name exactly as shown in the Reto dashboard.
 * TODO: pending confirmation from the project owner. Do not guess it.
 */
export const MODEL_NAME = "";

if (!MODEL_NAME) {
  throw new Error(
    "MODEL_NAME is empty in src/llm.ts. Set the exact Grok model name from the Reto dashboard.",
  );
}

if (!process.env.RETO_KEY) {
  throw new Error(
    "RETO_KEY is not set. Copy .env.example to .env and add your key (never commit it).",
  );
}

/** Single shared chat model instance (Grok through the Reto gateway). */
export const llm = new ChatOpenAI({
  model: MODEL_NAME,
  apiKey: process.env.RETO_KEY,
  // Custom base URL goes inside `configuration` (OpenAI SDK ClientOptions),
  // per https://docs.langchain.com/oss/javascript/integrations/chat/openai
  configuration: {
    baseURL: RETO_BASE_URL,
  },
  // Force the Chat Completions API: an OpenAI-compatible gateway is not
  // guaranteed to implement OpenAI's Responses API.
  useResponsesApi: false,
});
