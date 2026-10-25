/**
 * Capa de datos: descarga de procesos de SECOP II publicados HOY.
 *
 * Regla de negocio: en producción SOLO se procesan los procesos publicados hoy
 * (hora de Colombia). No existe parámetro de fecha y nunca se recurre a otra
 * fecha si hoy no hay datos. Única excepción de desarrollo: SECOP_FECHA_PRUEBA.
 */
import "../config/entorno.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { traceable } from "langsmith/traceable";
import { leerFechaPrueba, type ModoEjecucion } from "../config/entorno.js";
import {
  ENDPOINT_SECOP,
  MAX_PAGINAS,
  MODALIDADES_COMPETITIVAS,
  TAMANO_PAGINA,
} from "../config/secop.js";
import { opcionesTraceable } from "../trazas.js";

/**
 * Fila cruda del dataset p6dx-8zbt (solo los campos que usamos).
 * Socrata devuelve todo como texto y OMITE los campos nulos, por eso todos son opcionales.
 */
export interface FilaSecop {
  id_del_proceso?: string;
  nombre_del_procedimiento?: string;
  descripci_n_del_procedimiento?: string;
  entidad?: string;
  departamento_entidad?: string;
  ciudad_entidad?: string;
  tipo_de_contrato?: string;
  modalidad_de_contratacion?: string;
  fase?: string;
  estado_de_apertura_del_proceso?: string;
  precio_base?: string;
  fecha_de_publicacion_del?: string;
  urlproceso?: { url?: string };
  [campo: string]: unknown;
}

export interface ResultadoDescarga {
  /** Fecha consultada (YYYY-MM-DD). */
  fecha: string;
  modo: ModoEjecucion;
  filas: FilaSecop[];
  /** Mensaje legible para el usuario (incluye el caso de 0 filas). */
  mensaje: string;
  desdeCache: boolean;
}

/** Colombia usa UTC-5 fijo todo el año (sin horario de verano). */
const DESFASE_COLOMBIA_MS = -5 * 60 * 60 * 1000;

/** Fecha de hoy en Colombia (UTC-5), formato YYYY-MM-DD. */
export function fechaHoy(): string {
  return new Date(Date.now() + DESFASE_COLOMBIA_MS).toISOString().slice(0, 10);
}

/** Día siguiente a una fecha YYYY-MM-DD. */
function diaSiguiente(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Directorio de caché, usado SOLO para la fecha de prueba. */
const DIR_CACHE = path.resolve(process.cwd(), "data", "dias");

/** Construye el $where de SoQL: publicados en [fecha 00:00, fecha+1 00:00) y modalidad competitiva. */
function construirWhere(fecha: string): string {
  const modalidades = MODALIDADES_COMPETITIVAS.map((m) => `'${m.replaceAll("'", "''")}'`).join(", ");
  return (
    `fecha_de_publicacion_del >= '${fecha}T00:00:00' AND ` +
    `fecha_de_publicacion_del < '${diaSiguiente(fecha)}T00:00:00' AND ` +
    `modalidad_de_contratacion IN (${modalidades})`
  );
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Error que NO debe reintentarse (p. ej. 4xx por consulta mal formada). */
class ErrorNoReintentable extends Error {}

/**
 * GET con 3 reintentos y backoff exponencial (1 s, 2 s, 4 s) ante errores de
 * red, timeouts, 5xx y 429. Los demás 4xx fallan de inmediato.
 */
async function obtenerConReintentos(url: string, intentosExtra = 3): Promise<unknown> {
  for (let intento = 0; ; intento++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return await res.json();

      const cuerpo = (await res.text()).slice(0, 300);
      const reintentable = res.status >= 500 || res.status === 429;
      const error = `Socrata respondió HTTP ${res.status}: ${cuerpo}`;
      if (!reintentable) throw new ErrorNoReintentable(error);
      throw new Error(error);
    } catch (err) {
      if (err instanceof ErrorNoReintentable || intento >= intentosExtra) throw err;
      const espera = 1000 * 2 ** intento;
      const motivo = err instanceof Error ? err.message : String(err);
      console.warn(`[socrata] Intento ${intento + 1} falló (${motivo}). Reintentando en ${espera} ms...`);
      await esperar(espera);
    }
  }
}

/** Descarga todas las páginas para una fecha. */
async function descargarFecha(fecha: string): Promise<FilaSecop[]> {
  const filas: FilaSecop[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const params = new URLSearchParams({
      $where: construirWhere(fecha),
      // Orden estable: id_del_proceso, desempatado por el id interno de fila
      // (:id) porque el dataset puede traer id_del_proceso repetidos.
      $order: "id_del_proceso, :id",
      $limit: String(TAMANO_PAGINA),
      $offset: String(pagina * TAMANO_PAGINA),
    });
    const datos = await obtenerConReintentos(`${ENDPOINT_SECOP}?${params}`);
    if (!Array.isArray(datos)) {
      throw new Error("Respuesta inesperada de Socrata: se esperaba un arreglo JSON.");
    }
    filas.push(...(datos as FilaSecop[]));
    if (datos.length < TAMANO_PAGINA) return filas;
  }
  throw new Error(`Se superó el tope de ${MAX_PAGINAS} páginas; revisa la consulta.`);
}

async function leerCache(fecha: string): Promise<FilaSecop[] | null> {
  try {
    return JSON.parse(await readFile(path.join(DIR_CACHE, `${fecha}.json`), "utf8")) as FilaSecop[];
  } catch {
    return null;
  }
}

async function guardarCache(fecha: string, filas: FilaSecop[]): Promise<void> {
  await mkdir(DIR_CACHE, { recursive: true });
  await writeFile(path.join(DIR_CACHE, `${fecha}.json`), JSON.stringify(filas), "utf8");
}

function avisoModoPrueba(fecha: string, hoy: string): void {
  const linea = "!".repeat(72);
  console.warn(
    `\n${linea}\n` +
      `!!  MODO PRUEBA: SECOP_FECHA_PRUEBA=${fecha} reemplaza la fecha de hoy (${hoy}).\n` +
      `!!  Estos NO son los procesos de hoy. Elimina la variable para producción.\n` +
      `${linea}\n`,
  );
}

/**
 * Obtiene los procesos competitivos de una fecha específica (YYYY-MM-DD).
 * Utiliza la caché en data/dias/<fecha>.json si existe, o descarga de Socrata y la guarda.
 */
export async function obtenerProcesosFecha(
  fecha: string,
  opciones?: { ignorarCache?: boolean },
): Promise<{ fecha: string; filas: FilaSecop[]; desdeCache: boolean }> {
  const usarCache = !opciones?.ignorarCache;
  let filas = usarCache ? await leerCache(fecha) : null;
  const desdeCache = filas !== null;
  if (!filas) {
    filas = await descargarFecha(fecha);
    if (usarCache) await guardarCache(fecha, filas);
  }
  return { fecha, filas, desdeCache };
}

async function descargarHoyInterno(): Promise<ResultadoDescarga> {
  const hoy = fechaHoy();
  const fechaPrueba = leerFechaPrueba();
  const modo: ModoEjecucion = fechaPrueba ? "prueba" : "produccion";
  const fecha = fechaPrueba ?? hoy;

  // La caché se usa SOLO para la fecha de prueba y nunca si coincide con hoy
  // (los datos de hoy siguen cambiando durante el día).
  const usarCache = modo === "prueba" && fecha !== hoy;

  if (modo === "prueba") avisoModoPrueba(fecha, hoy);

  let filas = usarCache ? await leerCache(fecha) : null;
  const desdeCache = filas !== null;
  if (!filas) {
    filas = await descargarFecha(fecha);
    if (usarCache) await guardarCache(fecha, filas);
  }

  const etiqueta = modo === "prueba" ? `la fecha de prueba ${fecha}` : `hoy (${fecha})`;
  const mensaje =
    filas.length === 0
      ? `No hay procesos competitivos publicados en SECOP II para ${etiqueta}. ` +
        "No se consulta ninguna otra fecha."
      : `${filas.length} procesos competitivos publicados para ${etiqueta}` +
        (desdeCache ? " (desde caché)." : ".");

  return { fecha, modo, filas, mensaje, desdeCache };
}

/**
 * Descarga los procesos competitivos publicados HOY (hora Colombia).
 * Sin parámetro de fecha. Si no hay procesos devuelve lista vacía y un mensaje claro.
 * Trazado en LangSmith como "descargar_hoy" (solo un resumen, no todas las filas).
 */
export const descargarHoy = traceable(
  descargarHoyInterno,
  opcionesTraceable<typeof descargarHoyInterno>({
    runName: "descargar_hoy",
    tags: ["datos"],
    processOutputs: (r) => ({
      fecha: r.fecha,
      modo: r.modo,
      total_filas: r.filas.length,
      desde_cache: r.desdeCache,
      mensaje: r.mensaje,
    }),
  }),
);
