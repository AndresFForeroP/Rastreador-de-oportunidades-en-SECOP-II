/**
 * Extracción de evidencias de trazas de LangSmith (S3-1 / Task 5).
 *
 * Lee el árbol de la corrida raíz de forma compacta (nombres, duraciones,
 * conteos de tokens y estado) para persistirlo localmente en trazas.json
 * ante el límite de retención de 14 días de LangSmith.
 */
import { RunTree } from "langsmith";

export interface NodoTrazaCompacto {
  id: string;
  nombre: string;
  tipo: string;
  estado: string;
  duracionMs: number | null;
  tokens: {
    entrada?: number;
    salida?: number;
    total?: number;
  } | null;
  error?: string | null;
  hijos?: NodoTrazaCompacto[];
}

export interface ResultadoTrazaLangSmith {
  compacta: NodoTrazaCompacto | null;
  url: string | null;
  proyecto: string;
  runId: string;
  error: string | null;
}

/**
 * Convierte un objeto Run de LangSmith en una estructura de árbol compacta e informativa.
 */
export function compactarArbolRun(run: any): NodoTrazaCompacto {
  const inicio = run.start_time ? new Date(run.start_time).getTime() : null;
  const fin = run.end_time ? new Date(run.end_time).getTime() : null;
  const duracionMs = inicio && fin ? Math.max(0, fin - inicio) : null;

  const tieneTokens =
    run.total_tokens !== undefined ||
    run.prompt_tokens !== undefined ||
    run.completion_tokens !== undefined;

  const tokens = tieneTokens
    ? {
        entrada: typeof run.prompt_tokens === "number" ? run.prompt_tokens : undefined,
        salida: typeof run.completion_tokens === "number" ? run.completion_tokens : undefined,
        total: typeof run.total_tokens === "number" ? run.total_tokens : undefined,
      }
    : null;

  const nodo: NodoTrazaCompacto = {
    id: String(run.id),
    nombre: String(run.name || "sin_nombre"),
    tipo: String(run.run_type || "chain"),
    estado: String(run.status || (run.error ? "error" : "success")),
    duracionMs,
    tokens,
    error: run.error ? String(run.error) : null,
  };

  if (Array.isArray(run.child_runs) && run.child_runs.length > 0) {
    nodo.hijos = run.child_runs.map((hijo: any) => compactarArbolRun(hijo));
  }

  return nodo;
}

/**
 * Consulta de mejor esfuerzo (best-effort) a LangSmith para obtener la URL y el árbol de ejecución.
 * Si el SDK o la API fallan o no hay conexión, captura el error y devuelve los metadatos disponibles.
 */
export async function extraerTrazaLangSmith(
  runId: string,
  proyecto: string,
): Promise<ResultadoTrazaLangSmith> {
  const resultado: ResultadoTrazaLangSmith = {
    compacta: null,
    url: null,
    proyecto,
    runId,
    error: null,
  };

  try {
    const cliente = RunTree.getSharedClient();

    // 1. Obtener URL de la traza
    try {
      resultado.url = await cliente.getRunUrl({
        runId,
        projectOpts: { projectName: proyecto },
      });
    } catch {
      // getRunUrl puede fallar o estar en desuso según el entorno; no bloquea
    }

    // 2. Leer la corrida completa con sus hijos
    try {
      const run = await cliente.readRun(runId, { loadChildRuns: true });
      if (run) {
        resultado.compacta = compactarArbolRun(run);
      } else {
        resultado.error = "La API de LangSmith no retornó la corrida con ese ID.";
      }
    } catch (err) {
      resultado.error = err instanceof Error ? err.message : String(err);
    }
  } catch (err) {
    resultado.error = err instanceof Error ? err.message : String(err);
  }

  return resultado;
}
