/**
 * Gateway connection test: runs three independent checks against Grok
 * through the Reto gateway and reports which ones work.
 *
 *   pnpm exec tsx src/test-grok.ts
 */
import { tool } from "langchain";
import { AIMessage } from "@langchain/core/messages";
import * as z from "zod";
import { llm, MODEL_NAME } from "./llm.js";
import { registrarCosto } from "./cost.js";

type Resultado = { nombre: string; ok: boolean };

/** Prints useful error details without dumping request config or headers. */
function describirError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { status?: number; code?: string; error?: unknown; cause?: unknown };
  const detalle = {
    name: e.name,
    message: e.message,
    status: e.status,
    code: e.code,
    body: e.error,
    cause: e.cause instanceof Error ? e.cause.message : e.cause,
  };
  return JSON.stringify(detalle, null, 2);
}

async function probar(nombre: string, fn: () => Promise<void>): Promise<Resultado> {
  console.log(`\n=== ${nombre} ===`);
  try {
    await fn();
    console.log(`OK: ${nombre}`);
    return { nombre, ok: true };
  } catch (err) {
    console.error(`FAILED: ${nombre}\n${describirError(err)}`);
    return { nombre, ok: false };
  }
}

// 1. Plain response
async function respuestaSimple(): Promise<void> {
  const res = await llm.invoke("Reply with exactly one short sentence: what is SECOP II?");
  console.log("content:", res.content);
  console.log("usage_metadata:", res.usage_metadata);
  await registrarCosto("test-grok:respuesta-simple", MODEL_NAME, res);
}

// 2. Tool call
async function llamadaHerramienta(): Promise<void> {
  const getWeather = tool((input) => `It's always sunny in ${input.city}!`, {
    name: "get_weather",
    description: "Get the weather for a given city",
    schema: z.object({ city: z.string().describe("The city to get the weather for") }),
  });

  const res = await llm.bindTools([getWeather]).invoke("What's the weather in Bogotá?");
  console.log("tool_calls:", JSON.stringify(res.tool_calls, null, 2));
  console.log("usage_metadata:", res.usage_metadata);
  await registrarCosto("test-grok:tool-call", MODEL_NAME, res);

  if (!res.tool_calls || res.tool_calls.length === 0) {
    throw new Error("The model answered without calling the get_weather tool.");
  }
}

// 3. Structured output with zod
async function salidaEstructurada(): Promise<void> {
  const Oportunidad = z.object({
    entidad: z.string().describe("Contracting public entity"),
    objeto: z.string().describe("Short description of the contract object"),
    valor_cop: z.number().describe("Estimated value in Colombian pesos"),
  });

  const res = await llm
    .withStructuredOutput(Oportunidad, { name: "oportunidad", includeRaw: true })
    .invoke(
      "Extract the data: 'La Alcaldía de Medellín abre proceso para mantenimiento de " +
        "software por 150.000.000 COP.'",
    );

  console.log("parsed:", res.parsed);
  if (res.raw instanceof AIMessage) {
    console.log("usage_metadata:", res.raw.usage_metadata);
    await registrarCosto("test-grok:structured-output", MODEL_NAME, res.raw);
  }
  Oportunidad.parse(res.parsed);
}

const resultados: Resultado[] = [];
resultados.push(await probar("1. Plain response", respuestaSimple));
resultados.push(await probar("2. Tool call", llamadaHerramienta));
resultados.push(await probar("3. Structured output (zod)", salidaEstructurada));

console.log("\n=== Summary ===");
for (const r of resultados) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.nombre}`);
process.exitCode = resultados.every((r) => r.ok) ? 0 : 1;
