/**
 * Gestor centralizado de rutas para evidencias del Reto Agente 2026 (data/pruebas-reto/).
 *
 * Provee accesores tipados para cada subcarpeta de evidencias y utilidades
 * para crear la estructura bajo demanda de manera segura y concurrente.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

/** Raíz del directorio de evidencias committeables */
export const DIR_PRUEBAS_RETO = path.resolve(process.cwd(), "data", "pruebas-reto");

/** Subdirectorios de primer nivel */
export const DIR_EJECUCIONES = path.join(DIR_PRUEBAS_RETO, "ejecuciones");
export const DIR_COSTOS = path.join(DIR_PRUEBAS_RETO, "costos");
export const DIR_EVALUACION = path.join(DIR_PRUEBAS_RETO, "evaluacion");
export const DIR_CARGA = path.join(DIR_PRUEBAS_RETO, "carga");

/** Rutas canónicas para ejecuciones */
export function rutaRegistroEjecuciones(): string {
  return path.join(DIR_EJECUCIONES, "registro.jsonl");
}

export function rutaResumenEjecuciones(): string {
  return path.join(DIR_EJECUCIONES, "RESUMEN.md");
}

export function dirEjecucionIndividual(ejecucionId: string): string {
  return path.join(DIR_EJECUCIONES, ejecucionId);
}

/** Rutas para evaluación (S3) */
export function dirResultadosEvaluacion(): string {
  return path.join(DIR_EVALUACION, "resultados");
}

export function rutaCasosSinEtiquetar(): string {
  return path.join(DIR_EVALUACION, "casos-sin-etiquetar.json");
}

export function rutaClavesPrivadas(): string {
  return path.join(DIR_EVALUACION, "claves-privadas.json");
}

export function dirResultadoEvaluacionTimestamp(timestamp: string): string {
  return path.join(dirResultadosEvaluacion(), timestamp);
}

export function dirResultadoEvaluacionLineaBase(): string {
  return path.join(dirResultadosEvaluacion(), "linea-base");
}

export function dirResultadoEvaluacionAgentes(timestamp: string): string {
  return path.join(dirResultadosEvaluacion(), `${timestamp}-agentes`);
}

/** Rutas para carga desatendida (S4) */
export function dirCargaSubcarpetas(): {
  state: string;
  events: string;
  log: string;
  resources: string;
  reports: string;
} {
  return {
    state: path.join(DIR_CARGA, "state"),
    events: path.join(DIR_CARGA, "events"),
    log: path.join(DIR_CARGA, "log"),
    resources: path.join(DIR_CARGA, "resources"),
    reports: path.join(DIR_CARGA, "reports"),
  };
}

/**
 * Crea toda la jerarquía de carpetas requerida en data/pruebas-reto/ si no existe.
 */
export async function asegurarEstructuraPruebas(): Promise<void> {
  const carpetas = [
    DIR_PRUEBAS_RETO,
    DIR_EJECUCIONES,
    DIR_COSTOS,
    DIR_EVALUACION,
    dirResultadosEvaluacion(),
    DIR_CARGA,
    path.join(DIR_CARGA, "state"),
    path.join(DIR_CARGA, "events"),
    path.join(DIR_CARGA, "log"),
    path.join(DIR_CARGA, "resources"),
    path.join(DIR_CARGA, "reports"),
  ];

  await Promise.all(carpetas.map((dir) => mkdir(dir, { recursive: true })));
}

/**
 * Crea la subcarpeta de una ejecución individual bajo demanda.
 */
export async function asegurarCarpetaEjecucion(ejecucionId: string): Promise<string> {
  const ruta = dirEjecucionIndividual(ejecucionId);
  await mkdir(ruta, { recursive: true });
  return ruta;
}

/** Límite de tamaño sugerido por archivo en megabytes (regla global: advertir si > 5 MB) */
export const LIMITE_TAMANO_ARCHIVO_MB = 5;

/**
 * Verifica el tamaño de un archivo y emite una advertencia si excede el límite de 5 MB.
 */
export async function verificarTamanoArchivo(rutaArchivo: string): Promise<number> {
  try {
    const s = await stat(rutaArchivo);
    const tamanoMB = s.size / (1024 * 1024);
    if (tamanoMB > LIMITE_TAMANO_ARCHIVO_MB) {
      console.warn(
        `[pruebas-reto] ⚠️ ADVERTENCIA: El archivo "${path.basename(rutaArchivo)}" tiene un tamaño de ` +
          `${tamanoMB.toFixed(2)} MB, superando el límite recomendado de ${LIMITE_TAMANO_ARCHIVO_MB} MB.`,
      );
    }
    return s.size;
  } catch {
    return 0;
  }
}
