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
  detalles_salida?: {
    razonamiento?: number;
    audio?: number;
    [key: string]: unknown;
  };
  detalles_entrada?: {
    cache?: number;
    audio?: number;
    [key: string]: unknown;
  };
  metadatos_completos?: Record<string, unknown>;
}

/** Alias para compatibilidad hacia atrás */
export type RegistroCosto = RegistroTokens;

/**
 * Appends one JSON line per model call to logs/tokens.jsonl,
 * logging the full token breakdown from `message.usage_metadata` and response_metadata.
 */
export async function registrarCosto(
  task: string,
  model: string,
  message: AIMessage,
): Promise<RegistroTokens> {
  const uso = message.usage_metadata;
  const rawMeta = (message.response_metadata?.tokenUsage ?? message.response_metadata?.usage ?? {}) as Record<string, unknown>;
  const tokensEntrada = uso?.input_tokens ?? 0;
  const tokensSalida = uso?.output_tokens ?? 0;
  const tokensTotal = uso?.total_tokens ?? (typeof rawMeta.total_tokens === "number" ? rawMeta.total_tokens : tokensEntrada + tokensSalida);

  const outputDetails = (uso?.output_token_details ?? rawMeta.completion_tokens_details ?? {}) as Record<string, unknown>;
  const inputDetails = (uso?.input_token_details ?? rawMeta.prompt_tokens_details ?? {}) as Record<string, unknown>;

  const registro: RegistroTokens = {
    fecha: new Date().toISOString(),
    tarea: task,
    modelo: model,
    tokens_entrada: tokensEntrada,
    tokens_salida: tokensSalida,
    tokens_total: tokensTotal,
    detalles_salida: {
      razonamiento: (outputDetails.reasoning ?? outputDetails.reasoning_tokens) as number | undefined,
      ...outputDetails,
    },
    detalles_entrada: {
      cache: (inputDetails.cache_read ?? inputDetails.cached_tokens) as number | undefined,
      ...inputDetails,
    },
    metadatos_completos: {
      usage_metadata: uso,
      raw_token_usage: rawMeta,
    },
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

