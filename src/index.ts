/**
 * Basic agent from the LangChain quickstart ("Build a basic agent"),
 * using Grok through the Reto gateway.
 *
 *   pnpm exec tsx src/index.ts
 */
import { AIMessage, createAgent, createMiddleware, tool } from "langchain";
import * as z from "zod";
import { llm, MODEL_NAME } from "./llm.js";
import { registrarCosto } from "./cost.js";

const getWeather = tool((input) => `It's always sunny in ${input.city}!`, {
  name: "get_weather",
  description: "Get the weather for a given city",
  schema: z.object({
    city: z.string().describe("The city to get the weather for"),
  }),
});

/** Logs the cost of every model call the agent makes (one per loop step). */
const costoPorLlamada = createMiddleware({
  name: "CostoPorLlamada",
  afterModel: async (state) => {
    const ultimo = state.messages.at(-1);
    if (ultimo && AIMessage.isInstance(ultimo)) {
      await registrarCosto("agente-basico", MODEL_NAME, ultimo);
    }
  },
});

const agent = createAgent({
  model: llm,
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant. Use the available tools when needed and answer briefly.",
  middleware: [costoPorLlamada],
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
});

console.log(result.messages.at(-1)?.content);
