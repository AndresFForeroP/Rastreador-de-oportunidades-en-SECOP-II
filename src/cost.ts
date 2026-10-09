import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AIMessage } from "@langchain/core/messages";

/** Cost log location (bind-mounted to the host in Docker: ./logs:/app/logs). */
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "costos.jsonl");

interface Precio {
  /** USD per 1M input tokens. */
  entradaPorMillon: number | null;
  /** USD per 1M output tokens. */
  salidaPorMillon: number | null;
}

/**
 * Model prices in USD per 1M tokens.
 * TODO: placeholders. Fill in the real values from the Reto dashboard.
 * While a price is null, `costo_usd` is logged as null (unknown), not 0.
 */
export const PRECIOS: Record<string, Precio> = {
  // "<grok-model-name>": { entradaPorMillon: null, salidaPorMillon: null },
};

export interface RegistroCosto {
  fecha: string;
  tarea: string;
  modelo: string;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
}

function calcularCosto(modelo: string, entrada: number, salida: number): number | null {
  const precio = PRECIOS[modelo];
  if (!precio || precio.entradaPorMillon === null || precio.salidaPorMillon === null) {
    return null;
  }
  const costo =
    (entrada / 1_000_000) * precio.entradaPorMillon +
    (salida / 1_000_000) * precio.salidaPorMillon;
  return Number(costo.toFixed(8));
}

/**
 * Appends one JSON line per model call to logs/costos.jsonl,
 * using the token counts in `message.usage_metadata`.
 */
export async function registrarCosto(
  task: string,
  model: string,
  message: AIMessage,
): Promise<RegistroCosto> {
  const uso = message.usage_metadata;
  const tokensEntrada = uso?.input_tokens ?? 0;
  const tokensSalida = uso?.output_tokens ?? 0;

  const registro: RegistroCosto = {
    fecha: new Date().toISOString(),
    tarea: task,
    modelo: model,
    tokens_entrada: tokensEntrada,
    tokens_salida: tokensSalida,
    costo_usd: calcularCosto(model, tokensEntrada, tokensSalida),
  };

  if (!uso) {
    console.warn(`[costo] "${task}": the response has no usage_metadata; logging 0 tokens.`);
  }

  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(registro) + "\n", "utf8");
  return registro;
}
