import { appendFile, mkdir, readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { AIMessage } from "@langchain/core/messages";

/** Token log location (bind-mounted to the host in Docker: ./logs:/app/logs). */
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "tokens.jsonl");

/** Contexto asíncrono para correlacionar llamadas anidadas y concurrentes (S3-1) */
export interface ContextoTokens {
  ejecucionId?: string;
  procesoId?: string;
  agente?: string;
  tipo?: string;
}

/** Almacenamiento asíncrono local seguro para concurrencia */
export const almacenamientoContextoTokens = new AsyncLocalStorage<ContextoTokens>();

/**
 * Ejecuta una función asíncrona dentro de un contexto de tokens.
 * Las llamadas anidadas heredan las propiedades y pueden sobrescribir campos específicos.
 */
export function ejecutarConContextoTokens<T>(
  contexto: ContextoTokens,
  fn: () => Promise<T>,
): Promise<T> {
  const actual = almacenamientoContextoTokens.getStore();
  const combinado = { ...actual, ...contexto };
  return almacenamientoContextoTokens.run(combinado, fn);
}

/** Obtiene el contexto de tokens activo en el hilo de ejecución asíncrono actual. */
export function obtenerContextoTokens(): ContextoTokens | undefined {
  return almacenamientoContextoTokens.getStore();
}

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

  // Campos extendidos S3-1 (correlación contextual):
  ejecucionId?: string;
  procesoId?: string;
  agente?: string;
  tipo?: string;

  // Detalles completos de uso de tokens (usage_metadata ampliado):
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  tokens_razonamiento?: number | null;
  output_token_details?: Record<string, unknown>;
  input_token_details?: Record<string, unknown>;
  usage_metadata?: Record<string, unknown>;
}

/** Alias para compatibilidad hacia atrás */
export type RegistroCosto = RegistroTokens;

/**
 * Appends one JSON line per model call to logs/tokens.jsonl,
 * logging the full token breakdown from `message.usage_metadata` and response_metadata,
 * as well as the active AsyncLocalStorage context.
 */
export async function registrarCosto(
  task: string,
  model: string,
  message: AIMessage,
  contextoManual?: ContextoTokens,
): Promise<RegistroTokens> {
  const ctx = {
    ...almacenamientoContextoTokens.getStore(),
    ...contextoManual,
  };

  const uso = message.usage_metadata;
  const rawMeta = (message.response_metadata?.tokenUsage ?? message.response_metadata?.usage ?? {}) as Record<string, unknown>;
  const tokensEntrada = uso?.input_tokens ?? 0;
  const tokensSalida = uso?.output_tokens ?? 0;
  const tokensTotal = uso?.total_tokens ?? (typeof rawMeta.total_tokens === "number" ? rawMeta.total_tokens : tokensEntrada + tokensSalida);

  const outputDetails = (uso?.output_token_details ?? rawMeta.completion_tokens_details ?? {}) as Record<string, unknown>;
  const inputDetails = (uso?.input_token_details ?? rawMeta.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const razonamiento = (outputDetails.reasoning ?? outputDetails.reasoning_tokens) as number | undefined;

  const registro: RegistroTokens = {
    fecha: new Date().toISOString(),
    tarea: task,
    modelo: model,
    tokens_entrada: tokensEntrada,
    tokens_salida: tokensSalida,
    tokens_total: tokensTotal,
    detalles_salida: {
      razonamiento,
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
    // Nuevos campos S3-1:
    ejecucionId: ctx.ejecucionId,
    procesoId: ctx.procesoId,
    agente: ctx.agente ?? task,
    tipo: ctx.tipo,
    input_tokens: tokensEntrada,
    output_tokens: tokensSalida,
    total_tokens: tokensTotal,
    tokens_razonamiento: razonamiento ?? null,
    output_token_details: outputDetails,
    input_token_details: inputDetails,
    usage_metadata: uso as Record<string, unknown> | undefined,
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

/**
 * Lee todos los registros históricos de tokens desde logs/tokens.jsonl.
 */
export async function leerRegistrosTokens(): Promise<RegistroTokens[]> {
  try {
    const raw = await readFile(LOG_FILE, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as RegistroTokens);
  } catch {
    return [];
  }
}
