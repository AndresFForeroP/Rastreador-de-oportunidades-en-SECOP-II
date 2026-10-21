/**
 * Trazabilidad con LangSmith.
 *
 * - `iniciarTrazas()`: valida UNA vez la configuración. Si LANGSMITH_TRACING=true
 *   pero falta la API key o es inválida, imprime UNA advertencia, apaga las
 *   trazas y el programa sigue funcionando.
 * - `configEjecucion()`: arma el RunnableConfig (runName, tags, metadata) para
 *   llamadas de LangChain/LangGraph (se usará con los agentes en etapas siguientes).
 * - `opcionesTraceable()`: opciones para envolver pasos de código con `traceable`.
 * - `cerrarTrazas()`: espera a que se envíen todas las trazas antes de salir.
 *
 * Docs: https://docs.langchain.com/langsmith/annotate-code
 *       https://docs.langchain.com/langsmith/trace-with-langchain
 */
import "./config/entorno.js";
import { RunTree } from "langsmith";
import type { TraceableConfig } from "langsmith/traceable";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import type { RunnableConfig } from "@langchain/core/runnables";
import { leerFechaPrueba, modoEjecucion } from "./config/entorno.js";

/** Proyecto de LangSmith por defecto si LANGSMITH_PROJECT no está definido. */
export const PROYECTO_POR_DEFECTO = "secop-rastreador";

/** Variables que activan las trazas (LangSmith SDK y LangChain leen cualquiera). */
const VARIABLES_TRAZAS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

let validacion: Promise<boolean> | null = null;

function trazasSolicitadas(): boolean {
  return VARIABLES_TRAZAS.some((v) => process.env[v]?.trim().toLowerCase() === "true");
}

/** Apaga las trazas en caliente (los SDK leen process.env en cada ejecución). */
function desactivarTrazas(motivo: string): void {
  console.warn(`[trazas] ADVERTENCIA: ${motivo} Se continúa SIN trazas de LangSmith.`);
  for (const v of VARIABLES_TRAZAS) process.env[v] = "false";
}

function mensajeError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as Error & { status?: number }).status;
    return status ? `HTTP ${status}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Valida la configuración de LangSmith una sola vez por proceso.
 * Devuelve true si las trazas quedan activas.
 */
export function iniciarTrazas(): Promise<boolean> {
  validacion ??= (async () => {
    if (!trazasSolicitadas()) return false;

    if (!process.env.LANGSMITH_PROJECT?.trim()) {
      process.env.LANGSMITH_PROJECT = PROYECTO_POR_DEFECTO;
    }

    const clave = process.env.LANGSMITH_API_KEY?.trim() || process.env.LANGCHAIN_API_KEY?.trim();
    if (!clave) {
      desactivarTrazas("LANGSMITH_TRACING=true pero LANGSMITH_API_KEY está vacía.");
      return false;
    }

    try {
      // Petición mínima autenticada: si la clave es inválida responde 401/403.
      // Se usa el cliente compartido, el mismo que usa `traceable` por defecto.
      const cliente = RunTree.getSharedClient();
      for await (const _proyecto of cliente.listProjects({ name: process.env.LANGSMITH_PROJECT })) {
        break;
      }
      return true;
    } catch (err) {
      desactivarTrazas(`no se pudo validar LANGSMITH_API_KEY (${mensajeError(err)}).`);
      return false;
    }
  })();
  return validacion;
}

/** Metadata común a todas las trazas: modo de ejecución y fecha de prueba si aplica. */
function metadataBase(): Record<string, unknown> {
  const modo = modoEjecucion();
  const fechaPrueba = leerFechaPrueba();
  return fechaPrueba ? { modo, fecha_prueba: fechaPrueba } : { modo };
}

function tagsBase(): string[] {
  return ["secop", modoEjecucion()];
}

export interface OpcionesTraza {
  /** Nombre visible de la ejecución en LangSmith. */
  runName: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** ID único de la corrida raíz (UUID) */
  runId?: string;
}

/** RunnableConfig para invocar modelos, agentes o grafos de LangChain/LangGraph. */
export function configEjecucion(
  opciones: OpcionesTraza,
  parentConfig?: RunnableConfig,
): RunnableConfig {
  const tagsUnicos = Array.from(
    new Set([...tagsBase(), ...(opciones.tags ?? []), ...(parentConfig?.tags ?? [])]),
  );
  return {
    ...parentConfig,
    runId: opciones.runId ?? parentConfig?.runId,
    runName: opciones.runName,
    tags: tagsUnicos,
    metadata: {
      ...metadataBase(),
      ...parentConfig?.metadata,
      ...opciones.metadata,
    },
    callbacks: parentConfig?.callbacks,
  };
}

/** Opciones para `traceable(fn, opciones)` en pasos de código (descarga, pre-filtro...). */
export function opcionesTraceable<F extends (...args: any[]) => any>(
  opciones: OpcionesTraza & Pick<TraceableConfig<F>, "processInputs" | "processOutputs">,
): TraceableConfig<F> {
  return {
    name: opciones.runName,
    run_type: "chain",
    tags: [...tagsBase(), ...(opciones.tags ?? [])],
    metadata: { ...metadataBase(), ...opciones.metadata },
    processInputs: opciones.processInputs,
    processOutputs: opciones.processOutputs,
  };
}

/** Espera a que se envíen las trazas pendientes (llamar antes de terminar el proceso). */
export async function cerrarTrazas(): Promise<void> {
  if (!(await iniciarTrazas())) return;
  try {
    await awaitAllCallbacks();
    await RunTree.getSharedClient().awaitPendingTraceBatches();
  } catch (err) {
    console.warn(`[trazas] No se pudieron enviar todas las trazas: ${mensajeError(err)}`);
  }
}
