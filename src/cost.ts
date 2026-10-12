import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AIMessage } from "@langchain/core/messages";

/** Token log location (bind-mounted to the host in Docker: ./logs:/app/logs). */
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "tokens.jsonl");

export interface RegistroTokens {
  fecha: string;
  tarea: string;
  modelo: string;
  tokens_entrada: number;
  tokens_salida: number;
  tokens_total: number;
}

/** Alias para compatibilidad hacia atrás */
export type RegistroCosto = RegistroTokens;

/**
 * Appends one JSON line per model call to logs/tokens.jsonl,
 * using the token counts in `message.usage_metadata`.
 */
export async function registrarCosto(
  task: string,
  model: string,
  message: AIMessage,
): Promise<RegistroTokens> {
  const uso = message.usage_metadata;
  const tokensEntrada = uso?.input_tokens ?? 0;
  const tokensSalida = uso?.output_tokens ?? 0;
  const tokensTotal = uso?.total_tokens ?? tokensEntrada + tokensSalida;

  const registro: RegistroTokens = {
    fecha: new Date().toISOString(),
    tarea: task,
    modelo: model,
    tokens_entrada: tokensEntrada,
    tokens_salida: tokensSalida,
    tokens_total: tokensTotal,
  };

  if (!uso) {
    console.warn(`[tokens] "${task}": the response has no usage_metadata; logging 0 tokens.`);
  }

  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(registro) + "\n", "utf8");
  return registro;
}

/** Alias con nombre representativo para el registro exclusivo de tokens */
export const registrarTokens = registrarCosto;

