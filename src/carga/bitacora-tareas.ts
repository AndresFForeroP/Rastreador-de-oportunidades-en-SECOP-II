/**
 * Bitácora oficial por tarea y criterios de unidad de trabajo para S4 (src/carga/bitacora-tareas.ts).
 *
 * Cumple los criterios oficiales de la Semana de Carga (S4-0):
 * 1. Unidad de trabajo = 1 proceso de SECOP II analizado de principio a fin (veredicto de Agente 1
 *    y, cuando es "si", resumen de Agente 2 + lista de documentos de Agente 3), marcado como éxito o fallo.
 *    Los descartados por el pre-filtro de código NO se cuentan. Las llamadas aisladas a Grok NO se cuentan.
 *    Mantiene en paralelo las 3 métricas: (a) unidades fin a fin, (b) solo veredicto Agente 1, y
 *    (c) procesos "si" completados en Agentes 1, 2 y 3.
 * 2. Regla de éxito estricta: éxito (true) únicamente cuando el resultado estructurado final es válido
 *    y completo. Cualquier fallback ("sin respuesta del modelo", "error en invocación del modelo",
 *    "fallback_por_error_modelo") o ítem estacionado es un FALLO (false) con explicación en `recuperacion`.
 * 3. Costo por tarea: el costo de página de Agente 1 (páginas de hasta 25) se asigna en partes iguales
 *    entre los procesos de la página (`costoAsignadoUSD`); los costos de Agentes 2 y 3 son directos
 *    (`costoDirectoUSD`). Si los precios son null, deja USD vacío y conserva los tokens.
 * 4. Verificación de gateway y llave del reto: modo carga/daemon rechaza iniciar si la URL base no es
 *    el gateway oficial del reto (`RETO_BASE_URL` en `src/llm.ts`), imprimiendo únicamente el hostname.
 * 5. Escritura por tarea en el instante en que finaliza (append + flush a disco, nunca reconstruido
 *    desde memoria) en `data/pruebas-reto/carga/bitacora-tareas.csv` y `bitacora-tareas.jsonl`,
 *    con idempotencia respaldada en estado persistente atómico (`estado.json`) para evitar duplicados
 *    tras un reinicio.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { MODEL_NAME, RETO_BASE_URL } from "../llm.js";
import { obtenerContextoTokens } from "../cost.js";
import { leerFechaPrueba } from "../config/entorno.js";
import {
  DIR_CARGA,
  rutaBitacoraTareasCsv,
  rutaBitacoraTareasJsonl,
  rutaEstadoCarga,
} from "../pruebas/rutas.js";
import { obtenerGestorEstado } from "./estado.js";

// ============================================================================
// 1. CONSTANTES DOCUMENTADAS DE UNIDAD DE TRABAJO Y GATEWAY OFICIAL
// ============================================================================

/** Definición oficial de 1 unidad de trabajo en S4 */
export const DEFINICION_UNIDAD_TRABAJO =
  "1 proceso de SECOP II analizado de principio a fin (veredicto de Agente 1 y, cuando es 'si', resumen de Agente 2 y lista de documentos de Agente 3)";

/** Definiciones paralelas registradas para transparencia en reportes */
export const DEFINICIONES_UNIDADES_PARALELAS = {
  oficialFinAFin: DEFINICION_UNIDAD_TRABAJO,
  secundarioVeredictoAgente1:
    "1 proceso con veredicto válido emitido por el Agente 1 (solo triaje)",
  secundarioSiCompletado123:
    "1 proceso clasificado 'si' completado íntegramente con éxito en Agentes 1, 2 y 3",
} as const;

/** Hostname esperado del gateway oficial del reto */
export const RETO_GATEWAY_HOSTNAME = "api.reto.pltk.mx";

/** Formatea una fecha en hora local de Colombia (America/Bogota, UTC-5) */
export function formatearHoraLocalCO(fecha: Date | string | number = new Date()): string {
  const d = typeof fecha === "string" || typeof fecha === "number" ? new Date(fecha) : fecha;
  if (isNaN(d.getTime())) return "";
  const offsetMs = -5 * 60 * 60 * 1000;
  const colDate = new Date(d.getTime() + offsetMs);
  const pad = (n: number, z = 2) => String(n).padStart(z, "0");
  const yyyy = colDate.getUTCFullYear();
  const mm = pad(colDate.getUTCMonth() + 1);
  const dd = pad(colDate.getUTCDate());
  const hh = pad(colDate.getUTCHours());
  const min = pad(colDate.getUTCMinutes());
  const ss = pad(colDate.getUTCSeconds());
  const mss = pad(colDate.getUTCMilliseconds(), 3);
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.${mss}-05:00`;
}

/** Columnas oficiales del archivo CSV en orden estricto */
export const COLUMNAS_BITACORA_TAREAS = [
  "tareaId",
  "ejecucionId",
  "ciclo",
  "fuente",
  "fechaDatos",
  "horaInicio",
  "horaFin",
  "horaLocalCO",
  "idProceso",
  "entrada",
  "resultado",
  "exito",
  "errorTipo",
  "errorMensaje",
  "recuperacion",
  "tokensEntrada",
  "tokensSalida",
  "tokensTotal",
  "costoDirectoUSD",
  "costoAsignadoUSD",
  "latenciaSeg",
] as const;

export const ENCABEZADO_CSV_BITACORA = COLUMNAS_BITACORA_TAREAS.join(",");

// ============================================================================
// 2. TIPOS E INTERFACES DE LA BITÁCORA POR TAREA
// ============================================================================

export type FuenteDatosTarea = "hoy" | "historico";

export interface ResultadoTareaBitacora {
  aptoPyme: "si" | "no" | "dudoso" | null;
  categoriaObjeto: string | null;
  resumenOk?: boolean;
  documentosOk?: boolean;
}

export interface FilaBitacoraTarea {
  tareaId: string;
  ejecucionId: string;
  ciclo: number;
  fuente: FuenteDatosTarea;
  fechaDatos: string;
  horaInicio: string;
  horaFin: string;
  /** Marca de tiempo convertida a hora legal de Colombia (America/Bogota, UTC-5) */
  horaLocalCO?: string;
  idProceso: string;
  /** Nombre u objeto del proceso truncado a 120 caracteres */
  entrada: string;
  resultado: ResultadoTareaBitacora;
  exito: boolean;
  errorTipo: string | null;
  /** Mensaje de error truncado y sanitizado (sin secretos) */
  errorMensaje: string | null;
  /** Detalle de recuperación: reintentos, "reanudado tras reinicio", "marcado fallido", etc. */
  recuperacion: string;
  tokensEntrada: number;
  tokensSalida: number;
  tokensTotal: number;
  /** Costo directo en Agentes 2 y 3 (null si precios no configurados) */
  costoDirectoUSD: number | null;
  /** Costo prorrateado de la página de Agente 1 (null si precios no configurados) */
  costoAsignadoUSD: number | null;
  latenciaSeg: number;
}

export interface TarifasPreciosModelo {
  porMillonEntrada: number | null;
  porMillonSalida: number | null;
}

export interface EstadoParcialTarea {
  tareaId: string;
  idProceso: string;
  ejecucionId: string;
  ciclo: number;
  fuente: FuenteDatosTarea;
  fechaDatos: string;
  horaInicio: string;
  entrada: string;
  aptoPyme: "si" | "no" | "dudoso" | null;
  categoriaObjeto: string | null;
  falloAgente1: boolean;
  motivoFalloAgente1: string | null;
  intentosAgente1: number;
  tokensAgente1: { entrada: number; salida: number; total: number };
  costoAsignadoUSD: number | null;
  latenciaAgente1Seg: number;
  etapaActual: "agente1_completado" | "agente2_completado" | "finalizado";
  reanudadoTrasReinicio?: boolean;
  // Datos acumulados en Agente 2 (para procesos "si" o "dudoso" incluidos)
  resumenOk?: boolean;
  intentosAgente2?: number;
  errorAgente2?: string | null;
  tokensAgente2?: { entrada: number; salida: number; total: number };
  costoDirectoA2USD?: number | null;
  latenciaAgente2Seg?: number;
}

export interface DatosEstadoPersistenteCarga {
  version: number;
  actualizadoEn: string;
  inicioEjecucion: string;
  ultimoCiclo: number;
  erroresConsecutivos: number;
  ejecucionesInvolucradas: string[];
  contadoresUnidades: {
    oficialFinAFin: number;
    exitosasFinAFin: number;
    fallidasFinAFin: number;
    evaluadosAgente1: number;
    clasificadosSi: number;
    completadosAgentes123: number;
  };
  gastoAcumulado: {
    tokensEntrada: number;
    tokensSalida: number;
    tokensTotal: number;
    costoDirectoUSD: number;
    costoAsignadoUSD: number;
    costoTotalUSD: number;
  };
  procesadosPorEtapa: {
    agente1: string[];
    agente2: string[];
    agente3: string[];
    finalizadosBitacora: string[];
  };
  tareasEnVuelo: Record<string, EstadoParcialTarea>;
}

export interface ResumenBitacoraTareas {
  definicionOficial: string;
  unidadesOficiales: {
    total: number;
    exitosas: number;
    fallidas: number;
    tasaExitoPorcentaje: number;
  };
  conteosSecundarios: {
    soloVeredictoAgente1: number;
    siCompletadosAgentes123: number;
  };
  tokens: {
    entrada: number;
    salida: number;
    total: number;
  };
  costos: {
    preciosConfigurados: boolean;
    costoDirectoTotalUSD: number | null;
    costoAsignadoTotalUSD: number | null;
    costoTotalUSD: number | null;
    costoPromedioPorTareaUSD: number | null;
  };
}

// ============================================================================
// 3. VERIFICACIÓN DE GATEWAY DEL RETO Y SANITIZACIÓN
// ============================================================================

/**
 * Verifica que el modelo apunte al gateway oficial del reto (`RETO_BASE_URL` en `src/llm.ts`)
 * y que la llave `RETO_KEY` esté configurada.
 * NUNCA imprime la llave; imprime únicamente el hostname (`api.reto.pltk.mx`).
 */
export function verificarGatewayReto(opciones?: {
  baseUrl?: string;
  apiKey?: string;
  silencioso?: boolean;
}): { ok: true; hostname: string } {
  const urlConfigurada = (opciones?.baseUrl ?? RETO_BASE_URL ?? "").trim();
  const llavePresente = opciones?.apiKey !== undefined ? opciones.apiKey : process.env.RETO_KEY;

  if (!urlConfigurada) {
    throw new Error(
      "[gateway-reto] RECHAZADO: La URL base del modelo está vacía. Los modos de carga y daemon exigen el gateway oficial del reto.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlConfigurada);
  } catch {
    throw new Error(
      `[gateway-reto] RECHAZADO: La URL base configurada no es una URL válida.`,
    );
  }

  if (
    parsedUrl.hostname !== RETO_GATEWAY_HOSTNAME ||
    urlConfigurada.replace(/\/+$/, "") !== RETO_BASE_URL.replace(/\/+$/, "")
  ) {
    throw new Error(
      `[gateway-reto] RECHAZADO: El hostname "${parsedUrl.hostname}" no corresponde al gateway oficial del reto (${RETO_GATEWAY_HOSTNAME}).`,
    );
  }

  if (!llavePresente || llavePresente.trim().length === 0) {
    throw new Error(
      "[gateway-reto] RECHAZADO: La variable RETO_KEY no está definida. Configure la llave oficial del reto en .env.",
    );
  }

  if (!opciones?.silencioso) {
    console.log(`[gateway-reto] Gateway oficial verificado: host=${parsedUrl.hostname}`);
  }

  return { ok: true, hostname: parsedUrl.hostname };
}

/** Alias para compatibilidad con la especificación */
export const verificarPasarelaReto = verificarGatewayReto;

/**
 * Trunca una cadena a una longitud máxima (por defecto 120 para `entrada`),
 * normalizando espacios múltiples o saltos de línea si se solicita.
 */
export function truncarTexto(texto: string, maxChars = 120): string {
  const limpio = texto.trim();
  if (limpio.length <= maxChars) return limpio;
  return limpio.slice(0, Math.max(0, maxChars - 3)) + "...";
}

/**
 * Elimina posibles credenciales, tokens o llaves de API de cualquier mensaje de error
 * y lo trunca a una longitud segura (máx 200 caracteres).
 */
export function sanitizarMensajeError(mensaje: string | null | undefined, maxChars = 200): string | null {
  if (mensaje === null || mensaje === undefined) return null;
  let texto = String(mensaje).trim();
  if (!texto) return null;

  // Ocultar el valor real de RETO_KEY o LANGSMITH_API_KEY si apareciera en el error
  const secretosEntorno = [process.env.RETO_KEY, process.env.LANGSMITH_API_KEY].filter(
    (s): s is string => typeof s === "string" && s.trim().length >= 6,
  );
  for (const secreto of secretosEntorno) {
    texto = texto.split(secreto).join("[OCULTO]");
  }

  // Patrones comunes de llaves y tokens Bearer
  texto = texto
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [OCULTO]")
    .replace(/\b(?:sk|ls|lsv2|xai|reto)-[A-Za-z0-9._\-]{6,}\b/gi, "[OCULTO]")
    .replace(/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',;]+["']?/gi, "$&".replace(/[:=].*$/, "=[OCULTO]"));

  return truncarTexto(texto, maxChars);
}

// ============================================================================
// 4. FORMATEO Y PARSEO CSV (RFC 4180 ESTRICTO)
// ============================================================================

/**
 * Escapa un valor individual para CSV según RFC 4180:
 * - null / undefined -> cadena vacía ""
 * - Objetos -> JSON.stringify
 * - Si contiene comas, comillas dobles, saltos de línea (\n o \r) o espacios extremos:
 *   envuelve entre comillas dobles y duplica cada comilla interna (" -> "").
 */
export function escaparCeldaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) {
    return "";
  }
  const texto = typeof valor === "object" ? JSON.stringify(valor) : String(valor);
  if (
    texto.includes(",") ||
    texto.includes('"') ||
    texto.includes("\n") ||
    texto.includes("\r") ||
    texto.startsWith(" ") ||
    texto.endsWith(" ")
  ) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

/**
 * Convierte una fila tipada `FilaBitacoraTarea` en una línea CSV (sin el salto final).
 */
export function serializarFilaCsv(fila: FilaBitacoraTarea): string {
  const resultadoCompacto: ResultadoTareaBitacora = {
    aptoPyme: fila.resultado.aptoPyme,
    categoriaObjeto: fila.resultado.categoriaObjeto,
    ...(fila.resultado.resumenOk !== undefined ? { resumenOk: fila.resultado.resumenOk } : {}),
    ...(fila.resultado.documentosOk !== undefined ? { documentosOk: fila.resultado.documentosOk } : {}),
  };

  const horaLocalCO =
    fila.horaLocalCO ||
    formatearHoraLocalCO(fila.horaFin || fila.horaInicio || new Date());

  const celdas = [
    escaparCeldaCsv(fila.tareaId),
    escaparCeldaCsv(fila.ejecucionId),
    escaparCeldaCsv(fila.ciclo),
    escaparCeldaCsv(fila.fuente),
    escaparCeldaCsv(fila.fechaDatos),
    escaparCeldaCsv(fila.horaInicio),
    escaparCeldaCsv(fila.horaFin),
    escaparCeldaCsv(horaLocalCO),
    escaparCeldaCsv(fila.idProceso),
    escaparCeldaCsv(fila.entrada),
    escaparCeldaCsv(resultadoCompacto),
    escaparCeldaCsv(fila.exito),
    escaparCeldaCsv(fila.errorTipo),
    escaparCeldaCsv(fila.errorMensaje),
    escaparCeldaCsv(fila.recuperacion),
    escaparCeldaCsv(fila.tokensEntrada),
    escaparCeldaCsv(fila.tokensSalida),
    escaparCeldaCsv(fila.tokensTotal),
    escaparCeldaCsv(
      typeof fila.costoDirectoUSD === "number" ? Number(fila.costoDirectoUSD.toFixed(6)) : null,
    ),
    escaparCeldaCsv(
      typeof fila.costoAsignadoUSD === "number" ? Number(fila.costoAsignadoUSD.toFixed(6)) : null,
    ),
    escaparCeldaCsv(Number(fila.latenciaSeg.toFixed(3))),
  ];

  return celdas.join(",");
}

/**
 * Parser RFC 4180 completo para archivos CSV con soporte de comillas escapadas ("")
 * y saltos de línea embebidos dentro de celdas entrecomilladas.
 */
export function parsearContenidoCsv(contenido: string): string[][] {
  const filas: string[][] = [];
  let filaActual: string[] = [];
  let celdaActual = "";
  let enComillas = false;

  for (let i = 0; i < contenido.length; i++) {
    const char = contenido[i]!;

    if (enComillas) {
      if (char === '"') {
        if (contenido[i + 1] === '"') {
          celdaActual += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        celdaActual += char;
      }
    } else {
      if (char === '"') {
        enComillas = true;
      } else if (char === ",") {
        filaActual.push(celdaActual);
        celdaActual = "";
      } else if (char === "\r") {
        if (contenido[i + 1] === "\n") {
          i++;
        }
        filaActual.push(celdaActual);
        filas.push(filaActual);
        filaActual = [];
        celdaActual = "";
      } else if (char === "\n") {
        filaActual.push(celdaActual);
        filas.push(filaActual);
        filaActual = [];
        celdaActual = "";
      } else {
        celdaActual += char;
      }
    }
  }

  if (celdaActual.length > 0 || filaActual.length > 0) {
    filaActual.push(celdaActual);
    filas.push(filaActual);
  }

  return filas;
}

// ============================================================================
// 5. CÁLCULO DE COSTOS (DIRECTO Y ASIGNADO) Y REGLA DE ÉXITO
// ============================================================================

/**
 * Carga las tarifas del modelo desde `config/precios.json`.
 * Si el archivo no existe o tiene valores nulos, devuelve null conforme a la regla de honestidad.
 */
export async function cargarTarifasModelo(
  modelo: string = MODEL_NAME,
  rutaPreciosPersonalizada?: string,
): Promise<TarifasPreciosModelo | null> {
  const ruta = rutaPreciosPersonalizada
    ? path.resolve(process.cwd(), rutaPreciosPersonalizada)
    : path.resolve(process.cwd(), "config", "precios.json");

  try {
    const raw = await readFile(ruta, "utf8");
    const json = JSON.parse(raw);
    const info =
      json.modelos?.[modelo] ??
      json.modelos?.["default"] ??
      json[modelo] ??
      json["default"];

    const pEntrada = info?.porMillonEntrada ?? info?.inputPorMillon ?? null;
    const pSalida = info?.porMillonSalida ?? info?.outputPorMillon ?? null;

    if (typeof pEntrada === "number" && typeof pSalida === "number") {
      return { porMillonEntrada: pEntrada, porMillonSalida: pSalida };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Calcula el costo conservador en USD a partir de tokens (usando `tokensTotal` para incluir
 * razonamiento, tomando el máximo entre Estimación A y B).
 * Si las tarifas son null, devuelve null.
 */
export function calcularCostoTokensUSD(
  tokens: { entrada: number; salida: number; total: number },
  tarifas: TarifasPreciosModelo | null,
): number | null {
  if (
    !tarifas ||
    typeof tarifas.porMillonEntrada !== "number" ||
    typeof tarifas.porMillonSalida !== "number"
  ) {
    return null;
  }

  const entrada = Math.max(0, tokens.entrada || 0);
  const salidaVisible = Math.max(0, tokens.salida || 0);
  const total = Math.max(entrada + salidaVisible, tokens.total || 0);

  // Estimación A (conservadora: tokens no-entrada a tarifa de salida) vs Estimación B (solo visible)
  const tokensSalidaFacturados = Math.max(salidaVisible, total - entrada);
  const costo =
    (entrada * tarifas.porMillonEntrada + tokensSalidaFacturados * tarifas.porMillonSalida) /
    1_000_000;

  return Number(costo.toFixed(6));
}

/**
 * Evalúa si el veredicto del Agente 1 corresponde a un fallback por error u omisión del modelo.
 */
export function esFallbackAgente1(clasificacion: {
  aptoPyme?: string | null;
  razon?: string | null;
  senales?: string[];
}): boolean {
  if (!clasificacion.aptoPyme) return true;
  const razon = (clasificacion.razon ?? "").toLowerCase().trim();
  const senales = Array.isArray(clasificacion.senales) ? clasificacion.senales : [];

  if (
    razon === "sin respuesta del modelo" ||
    razon === "error en invocación del modelo" ||
    razon.includes("sin respuesta del modelo") ||
    razon.includes("error en invocación del modelo") ||
    senales.includes("error_modelo") ||
    senales.includes("omision_modelo")
  ) {
    return true;
  }
  return false;
}

/**
 * Regla oficial de éxito por tarea (S4-0):
 * Éxito (`true`) únicamente cuando el resultado estructurado final es válido y completo:
 * - Si hubo fallback en Agente 1 ("sin respuesta del modelo", etc.) -> `false`.
 * - Si el proceso requería Agentes 2 y 3 (`aptoPyme === "si"` o `"dudoso"` con `incluirDudosos`),
 *   debe tener `resumenOk === true` y `documentosOk === true`.
 * - Si fue estacionado o interrumpido -> `false`.
 */
export function evaluarExitoTarea(params: {
  aptoPyme: "si" | "no" | "dudoso" | null;
  falloAgente1: boolean;
  requiereEtapas2y3: boolean;
  resumenOk?: boolean;
  documentosOk?: boolean;
  estacionado?: boolean;
}): boolean {
  if (params.falloAgente1 || !params.aptoPyme || params.estacionado) {
    return false;
  }
  if (params.requiereEtapas2y3) {
    return params.resumenOk === true && params.documentosOk === true;
  }
  return true;
}

// ============================================================================
// 6. GESTOR DE BITÁCORA POR TAREA Y ESTADO PERSISTENTE ATÓMICO
// ============================================================================

export interface OpcionesGestorBitacora {
  /** Directorio base (por defecto `data/pruebas-reto/carga`) */
  dirCarga?: string;
  /** Ruta personalizada de `bitacora-tareas.csv` */
  rutaCsv?: string;
  /** Ruta personalizada de `bitacora-tareas.jsonl` */
  rutaJsonl?: string;
  /** Ruta personalizada de `estado.json` */
  rutaEstado?: string;
  /** Tarifas explícitas para pruebas (null fuerza modo sin precios; undefined lee config/precios.json) */
  tarifasOverride?: TarifasPreciosModelo | null;
}

function crearEstadoInicialVacio(): DatosEstadoPersistenteCarga {
  const ahora = new Date().toISOString();
  return {
    version: 1,
    actualizadoEn: ahora,
    inicioEjecucion: ahora,
    ultimoCiclo: 0,
    erroresConsecutivos: 0,
    ejecucionesInvolucradas: [],
    contadoresUnidades: {
      oficialFinAFin: 0,
      exitosasFinAFin: 0,
      fallidasFinAFin: 0,
      evaluadosAgente1: 0,
      clasificadosSi: 0,
      completadosAgentes123: 0,
    },
    gastoAcumulado: {
      tokensEntrada: 0,
      tokensSalida: numberZero(),
      tokensTotal: 0,
      costoDirectoUSD: 0,
      costoAsignadoUSD: 0,
      costoTotalUSD: 0,
    },
    procesadosPorEtapa: {
      agente1: [],
      agente2: [],
      agente3: [],
      finalizadosBitacora: [],
    },
    tareasEnVuelo: {},
  };
}

function numberZero(): number {
  return 0;
}

/**
 * Gestiona la escritura inmediata (append + sync) en `bitacora-tareas.csv` y `bitacora-tareas.jsonl`,
 * manteniendo la idempotencia y el estado parcial entre etapas en `estado.json` mediante
 * escritura atómica (archivo temporal + rename).
 */
export class GestorBitacoraTareas {
  private readonly dirBase: string;
  private readonly rutaCsv: string;
  private readonly rutaJsonl: string;
  private readonly rutaProgreso: string;
  private readonly rutaEstado: string;
  private readonly tarifasOverride: TarifasPreciosModelo | null | undefined;

  private inicializado = false;
  private estado: DatosEstadoPersistenteCarga = crearEstadoInicialVacio();
  private finalizadosSet = new Set<string>();
  private agente1Set = new Set<string>();
  private agente2Set = new Set<string>();
  private agente3Set = new Set<string>();

  /** Procesos que ya estaban en vuelo en disco al iniciar esta instancia (para marcar reanudación tras reinicio) */
  private enVueloPrevioAlInicio = new Set<string>();

  /** Cola de promesas para serializar escrituras concurrentes y evitar condiciones de carrera */
  private colaEscritura: Promise<void> = Promise.resolve();

  constructor(opciones: OpcionesGestorBitacora = {}) {
    this.dirBase = opciones.dirCarga ?? DIR_CARGA;
    this.rutaCsv = opciones.rutaCsv ?? (opciones.dirCarga ? path.join(this.dirBase, "bitacora-tareas.csv") : rutaBitacoraTareasCsv());
    this.rutaJsonl = opciones.rutaJsonl ?? (opciones.dirCarga ? path.join(this.dirBase, "bitacora-tareas.jsonl") : rutaBitacoraTareasJsonl());
    this.rutaProgreso = path.join(this.dirBase, "progreso.jsonl");
    this.rutaEstado = opciones.rutaEstado ?? (opciones.dirCarga ? path.join(this.dirBase, "estado.json") : rutaEstadoCarga());
    this.tarifasOverride = opciones.tarifasOverride;
  }

  public obtenerRutas(): { csv: string; jsonl: string; estado: string } {
    return {
      csv: this.rutaCsv,
      jsonl: this.rutaJsonl,
      estado: this.rutaEstado,
    };
  }

  /**
   * Carga el estado persistente y sincroniza los IDs ya registrados en `bitacora-tareas.jsonl`
   * para garantizar que un reinicio jamás duplique filas.
   */
  public async inicializar(): Promise<void> {
    if (this.inicializado) return;

    await mkdir(path.dirname(this.rutaCsv), { recursive: true });
    await mkdir(path.dirname(this.rutaJsonl), { recursive: true });
    await mkdir(path.dirname(this.rutaEstado), { recursive: true });

    // 1. Cargar estado.json si existe
    try {
      const rawEstado = await readFile(this.rutaEstado, "utf8");
      const parsed = JSON.parse(rawEstado) as Partial<DatosEstadoPersistenteCarga>;
      this.estado = {
        ...crearEstadoInicialVacio(),
        ...parsed,
        contadoresUnidades: {
          ...crearEstadoInicialVacio().contadoresUnidades,
          ...(parsed.contadoresUnidades ?? {}),
        },
        gastoAcumulado: {
          ...crearEstadoInicialVacio().gastoAcumulado,
          ...(parsed.gastoAcumulado ?? {}),
        },
        procesadosPorEtapa: {
          ...crearEstadoInicialVacio().procesadosPorEtapa,
          ...(parsed.procesadosPorEtapa ?? {}),
        },
        tareasEnVuelo: { ...(parsed.tareasEnVuelo ?? {}) },
      };

      for (const id of this.estado.procesadosPorEtapa.agente1) this.agente1Set.add(id);
      for (const id of this.estado.procesadosPorEtapa.agente2) this.agente2Set.add(id);
      for (const id of this.estado.procesadosPorEtapa.agente3) this.agente3Set.add(id);
      for (const id of this.estado.procesadosPorEtapa.finalizadosBitacora) this.finalizadosSet.add(id);

      // Cualquier tarea que quedó en vuelo en una corrida anterior se marca como previa al reinicio
      for (const id of Object.keys(this.estado.tareasEnVuelo)) {
        if (!this.finalizadosSet.has(id)) {
          this.enVueloPrevioAlInicio.add(id);
          const parcial = this.estado.tareasEnVuelo[id];
          if (parcial) {
            parcial.reanudadoTrasReinicio = true;
          }
        }
      }
    } catch {
      this.estado = crearEstadoInicialVacio();
    }

    // 2. Sincronizar contra bitacora-tareas.jsonl por si hubo entradas previas
    try {
      const rawJsonl = await readFile(this.rutaJsonl, "utf8");
      const lineas = rawJsonl
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const linea of lineas) {
        try {
          const reg = JSON.parse(linea) as FilaBitacoraTarea;
          if (reg.idProceso) {
            this.finalizadosSet.add(reg.idProceso);
            delete this.estado.tareasEnVuelo[reg.idProceso];
            if (
              reg.resultado?.aptoPyme === "si" &&
              reg.resultado?.resumenOk === true &&
              reg.resultado?.documentosOk === true &&
              reg.exito
            ) {
              this.agente3Set.add(reg.idProceso);
            }
          }
          if (reg.tareaId) {
            this.finalizadosSet.add(reg.tareaId);
          }
        } catch {
          // Ignorar línea corrupta aislada
        }
      }
      this.estado.contadoresUnidades.completadosAgentes123 = this.agente3Set.size;
      this.estado.procesadosPorEtapa.finalizadosBitacora = Array.from(
        new Set([
          ...this.estado.procesadosPorEtapa.finalizadosBitacora,
          ...Array.from(this.finalizadosSet).filter((k) => !k.startsWith("tarea_")),
        ]),
      );
    } catch {
      // bitacora-tareas.jsonl aún no existe
    }

    this.inicializado = true;
  }

  /**
   * Consulta las tarifas aplicables (respetando override de pruebas o `config/precios.json`).
   */
  public async obtenerTarifas(modelo: string = MODEL_NAME): Promise<TarifasPreciosModelo | null> {
    if (this.tarifasOverride !== undefined) {
      return this.tarifasOverride;
    }
    return cargarTarifasModelo(modelo);
  }

  /**
   * Verifica si un proceso ya fue registrado como tarea finalizada en la bitácora.
   */
  public async esTareaRegistrada(idProcesoOTarea: string): Promise<boolean> {
    await this.inicializar();
    return this.finalizadosSet.has(idProcesoOTarea);
  }

  /**
   * Verifica si un proceso ya completó una etapa específica ("agente1" | "agente2" | "agente3" | "finalizado").
   */
  public async esProcesadoEnEtapa(
    idProceso: string,
    etapa: "agente1" | "agente2" | "agente3" | "finalizado",
  ): Promise<boolean> {
    await this.inicializar();
    if (etapa === "agente1") return this.agente1Set.has(idProceso);
    if (etapa === "agente2") return this.agente2Set.has(idProceso);
    if (etapa === "agente3") return this.agente3Set.has(idProceso);
    return this.finalizadosSet.has(idProceso);
  }

  /**
   * Obtiene el estado parcial en vuelo de un proceso si existe.
   */
  public async obtenerEstadoParcial(idProceso: string): Promise<EstadoParcialTarea | undefined> {
    await this.inicializar();
    return this.estado.tareasEnVuelo[idProceso];
  }

  /**
   * Obtiene una copia del estado persistente actual.
   */
  public async obtenerEstadoPersistente(): Promise<DatosEstadoPersistenteCarga> {
    await this.inicializar();
    return JSON.parse(JSON.stringify(this.estado)) as DatosEstadoPersistenteCarga;
  }

  /**
   * Persiste `estado.json` de forma atómica: escribe en un archivo temporal en el mismo
   * directorio, hace flush a disco (`sync`) y ejecuta `rename` sobre el destino.
   */
  private async guardarEstadoAtomico(): Promise<void> {
    this.estado.actualizadoEn = new Date().toISOString();
    this.estado.procesadosPorEtapa.agente1 = Array.from(this.agente1Set);
    this.estado.procesadosPorEtapa.agente2 = Array.from(this.agente2Set);
    this.estado.procesadosPorEtapa.agente3 = Array.from(this.agente3Set);
    this.estado.procesadosPorEtapa.finalizadosBitacora = Array.from(this.finalizadosSet).filter(
      (id) => !id.startsWith("tarea_"),
    );

    const sufijo = `${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}`;
    const rutaTmp = `${this.rutaEstado}.tmp.${sufijo}`;
    const contenido = JSON.stringify(this.estado, null, 2) + "\n";

    const fh = await open(rutaTmp, "w");
    try {
      await fh.writeFile(contenido, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    await rename(rutaTmp, this.rutaEstado);
  }

  /**
   * Encola una operación de escritura para garantizar exclusión mutua dentro del proceso.
   */
  private encolarEscritura<T>(fn: () => Promise<T>): Promise<T> {
    const promesa = this.colaEscritura.then(fn, fn);
    this.colaEscritura = promesa.then(
      () => undefined,
      () => undefined,
    );
    return promesa;
  }

  /**
   * Escribe UNA fila en `bitacora-tareas.jsonl` y `bitacora-tareas.csv` en el momento
   * exacto en que finaliza la tarea (append + sync a disco), actualizando `estado.json`.
   * Si la tarea ya fue registrada previamente, no duplica la fila.
   */
  public async registrarTareaFinalizada(
    filaEntrada: FilaBitacoraTarea,
  ): Promise<{ escrito: boolean; duplicado: boolean; fila: FilaBitacoraTarea }> {
    return this.encolarEscritura(async () => {
      await this.inicializar();

      const claveProceso = filaEntrada.idProceso;
      const claveTarea = filaEntrada.tareaId;

      if (this.finalizadosSet.has(claveProceso) || this.finalizadosSet.has(claveTarea)) {
        return { escrito: false, duplicado: true, fila: filaEntrada };
      }

      // Normalizar y sanitizar campos antes de escribir a disco
      const horaFinNormalizada = filaEntrada.horaFin ?? new Date().toISOString();
      const horaLocalCO =
        filaEntrada.horaLocalCO ||
        formatearHoraLocalCO(horaFinNormalizada);

      const fila: FilaBitacoraTarea = {
        ...filaEntrada,
        horaFin: horaFinNormalizada,
        horaLocalCO,
        entrada: truncarTexto(filaEntrada.entrada, 120),
        errorMensaje: sanitizarMensajeError(filaEntrada.errorMensaje, 200),
        tokensEntrada: Math.max(0, Math.round(filaEntrada.tokensEntrada || 0)),
        tokensSalida: Math.max(0, Math.round(filaEntrada.tokensSalida || 0)),
        tokensTotal: Math.max(0, Math.round(filaEntrada.tokensTotal || 0)),
        costoDirectoUSD:
          typeof filaEntrada.costoDirectoUSD === "number"
            ? Number(filaEntrada.costoDirectoUSD.toFixed(6))
            : null,
        costoAsignadoUSD:
          typeof filaEntrada.costoAsignadoUSD === "number"
            ? Number(filaEntrada.costoAsignadoUSD.toFixed(6))
            : null,
        latenciaSeg: Number(Math.max(0, filaEntrada.latenciaSeg || 0).toFixed(3)),
      };

      // 1. Append + flush a bitacora-tareas.jsonl y progreso.jsonl
      const lineaJsonl = JSON.stringify(fila) + "\n";
      const fhJsonl = await open(this.rutaJsonl, "a");
      try {
        await fhJsonl.write(lineaJsonl, null, "utf8");
        await fhJsonl.sync();
      } finally {
        await fhJsonl.close();
      }

      try {
        const fhProgreso = await open(this.rutaProgreso, "a");
        try {
          await fhProgreso.write(lineaJsonl, null, "utf8");
          await fhProgreso.sync();
        } finally {
          await fhProgreso.close();
        }
      } catch {
        // Ignorar si falla la réplica a progreso.jsonl
      }

      // 2. Append + flush a bitacora-tareas.csv (escribiendo encabezado UTF-8 si el archivo es nuevo/vacío)
      let necesitaEncabezado = true;
      try {
        const st = await stat(this.rutaCsv);
        if (st.size > 0) {
          necesitaEncabezado = false;
        }
      } catch {
        necesitaEncabezado = true;
      }

      const lineaCsv = serializarFilaCsv(fila) + "\n";
      const bloqueCsv = necesitaEncabezado ? `${ENCABEZADO_CSV_BITACORA}\n${lineaCsv}` : lineaCsv;
      const fhCsv = await open(this.rutaCsv, "a");
      try {
        await fhCsv.write(bloqueCsv, null, "utf8");
        await fhCsv.sync();
      } finally {
        await fhCsv.close();
      }

      // 3. Actualizar conjuntos de idempotencia y contadores en estado.json
      this.finalizadosSet.add(claveProceso);
      this.finalizadosSet.add(claveTarea);
      delete this.estado.tareasEnVuelo[claveProceso];

      this.estado.ultimoCiclo = Math.max(this.estado.ultimoCiclo, fila.ciclo);
      if (
        fila.ejecucionId &&
        !this.estado.ejecucionesInvolucradas.includes(fila.ejecucionId)
      ) {
        this.estado.ejecucionesInvolucradas.push(fila.ejecucionId);
      }

      // Contadores de unidades
      this.estado.contadoresUnidades.oficialFinAFin += 1;
      if (fila.exito) {
        this.estado.contadoresUnidades.exitosasFinAFin += 1;
        this.estado.erroresConsecutivos = 0;
      } else {
        this.estado.contadoresUnidades.fallidasFinAFin += 1;
        this.estado.erroresConsecutivos += 1;
      }

      if (!this.agente1Set.has(claveProceso) && fila.resultado.aptoPyme !== null) {
        this.agente1Set.add(claveProceso);
        this.estado.contadoresUnidades.evaluadosAgente1 += 1;
        if (fila.resultado.aptoPyme === "si") {
          this.estado.contadoresUnidades.clasificadosSi += 1;
        }
      }

      if (
        fila.resultado.aptoPyme === "si" &&
        fila.resultado.resumenOk === true &&
        fila.resultado.documentosOk === true &&
        fila.exito
      ) {
        this.agente3Set.add(claveProceso);
        this.estado.contadoresUnidades.completadosAgentes123 += 1;
      }

      // Acumular gasto en estado
      this.estado.gastoAcumulado.tokensEntrada += fila.tokensEntrada;
      this.estado.gastoAcumulado.tokensSalida += fila.tokensSalida;
      this.estado.gastoAcumulado.tokensTotal += fila.tokensTotal;
      if (typeof fila.costoDirectoUSD === "number") {
        this.estado.gastoAcumulado.costoDirectoUSD = Number(
          (this.estado.gastoAcumulado.costoDirectoUSD + fila.costoDirectoUSD).toFixed(6),
        );
      }
      if (typeof fila.costoAsignadoUSD === "number") {
        this.estado.gastoAcumulado.costoAsignadoUSD = Number(
          (this.estado.gastoAcumulado.costoAsignadoUSD + fila.costoAsignadoUSD).toFixed(6),
        );
      }
      this.estado.gastoAcumulado.costoTotalUSD = Number(
        (
          this.estado.gastoAcumulado.costoDirectoUSD +
          this.estado.gastoAcumulado.costoAsignadoUSD
        ).toFixed(6),
      );

      try {
        const gestor = obtenerGestorEstado();
        await gestor.marcar(claveProceso, "finalizado_bitacora", {
          exito: fila.exito,
          ciclo: fila.ciclo,
          ejecucionId: fila.ejecucionId,
          aptoPyme: fila.resultado.aptoPyme,
          resumenOk: fila.resultado.resumenOk,
          documentosOk: fila.resultado.documentosOk,
          diferirGuardado: true,
        });
        // Sincronizar contadores oficiales en memoria
        const st = gestor.obtenerEstado();
        this.estado.contadoresUnidades = { ...st.contadoresUnidades };
      } catch {
        // Ignorar si gestorEstado no está inicializado
      }

      await this.guardarEstadoAtomico();

      return { escrito: true, duplicado: false, fila };
    });
  }

  /**
   * Registra el resultado de una página del Agente 1:
   * - Asigna el costo de la página en partes iguales (`costoAsignadoUSD`) entre sus procesos.
   * - Para los procesos que alcanzan su estado final en el Agente 1 ("no", "dudoso" cuando
   *   no se incluyen dudosos en A2/A3, o fallbacks de error de Agente 1), escribe inmediatamente
   *   su fila en la bitácora.
   * - Para los procesos "si" (o "dudoso" cuando pasa a A2/A3), guarda el estado parcial en
   *   `estado.json` para completarlo cuando terminen Agentes 2 y 3.
   */
  public async registrarResultadoPaginaAgente1(params: {
    ejecucionId: string;
    ciclo: number;
    fuente: FuenteDatosTarea;
    fechaDatos: string;
    horaInicio: string;
    horaFin: string;
    intentosPagina: number;
    tokensPagina: { entrada: number; salida: number; total: number };
    incluirDudosos?: boolean;
    resultados: Array<{
      id: string;
      nombreProceso: string;
      aptoPyme: "si" | "no" | "dudoso";
      categoriaObjeto: string;
      razon: string;
      senales: string[];
    }>;
  }): Promise<{ finalizadosInmediatos: number; enVueloParaEtapas2y3: number }> {
    await this.inicializar();

    const nProcesos = Math.max(1, params.resultados.length);
    const tarifas = await this.obtenerTarifas();
    const costoPaginaUSD = calcularCostoTokensUSD(params.tokensPagina, tarifas);
    const costoAsignadoPorProceso =
      costoPaginaUSD !== null ? Number((costoPaginaUSD / nProcesos).toFixed(6)) : null;

    const tokensAsignados = {
      entrada: Math.round(params.tokensPagina.entrada / nProcesos),
      salida: Math.round(params.tokensPagina.salida / nProcesos),
      total: Math.round(params.tokensPagina.total / nProcesos),
    };

    const duracionPaginaSeg = Math.max(
      0.001,
      (Date.parse(params.horaFin) - Date.parse(params.horaInicio)) / 1000,
    );
    const latenciaPorProceso = Number((duracionPaginaSeg / nProcesos).toFixed(3));

    let finalizadosInmediatos = 0;
    let enVueloParaEtapas2y3 = 0;

    for (const item of params.resultados) {
      if (this.finalizadosSet.has(item.id)) {
        continue;
      }

      const falloA1 = esFallbackAgente1(item);
      const requiereEtapas2y3 =
        !falloA1 &&
        (item.aptoPyme === "si" || ( Boolean(params.incluirDudosos) && item.aptoPyme === "dudoso" ));

      // Registrar en el contador de evaluados por Agente 1 si es válido
      await this.encolarEscritura(async () => {
        if (!this.agente1Set.has(item.id) && !falloA1) {
          this.agente1Set.add(item.id);
          this.estado.contadoresUnidades.evaluadosAgente1 += 1;
          if (item.aptoPyme === "si") {
            this.estado.contadoresUnidades.clasificadosSi += 1;
          }
        }
      });

      if (!requiereEtapas2y3) {
        // Alcanza su estado final aquí mismo (sea "no", "dudoso" válido, o fallo de Agente 1)
        const reanudado = this.enVueloPrevioAlInicio.has(item.id);
        const reintentosA1 = Math.max(0, params.intentosPagina - 1);

        const partesRecuperacion: string[] = [];
        if (reanudado) partesRecuperacion.push("reanudado tras reinicio");
        if (reintentosA1 > 0) partesRecuperacion.push(`reintentos_agente1=${reintentosA1}`);
        if (falloA1) {
          partesRecuperacion.push(`marcado fallido (${item.razon})`);
        } else if (partesRecuperacion.length === 0) {
          partesRecuperacion.push("sin reintentos");
        }

        const fila: FilaBitacoraTarea = {
          tareaId: `tarea_${params.fechaDatos}_${item.id}`,
          ejecucionId: params.ejecucionId,
          ciclo: params.ciclo,
          fuente: params.fuente,
          fechaDatos: params.fechaDatos,
          horaInicio: params.horaInicio,
          horaFin: params.horaFin,
          idProceso: item.id,
          entrada: truncarTexto(item.nombreProceso, 120),
          resultado: {
            aptoPyme: item.aptoPyme,
            categoriaObjeto: item.categoriaObjeto,
          },
          exito: !falloA1,
          errorTipo: falloA1
            ? item.razon.includes("sin respuesta")
              ? "omision_modelo_agente1"
              : "error_modelo_agente1"
            : null,
          errorMensaje: falloA1 ? item.razon : null,
          recuperacion: partesRecuperacion.join("; "),
          tokensEntrada: tokensAsignados.entrada,
          tokensSalida: tokensAsignados.salida,
          tokensTotal: tokensAsignados.total,
          costoDirectoUSD: costoAsignadoPorProceso !== null ? 0 : null,
          costoAsignadoUSD: costoAsignadoPorProceso,
          latenciaSeg: latenciaPorProceso,
        };

        const res = await this.registrarTareaFinalizada(fila);
        if (res.escrito) finalizadosInmediatos++;
      } else {
        // Proceso "si" (o "dudoso" incluido): queda en vuelo esperando Agentes 2 y 3
        await this.encolarEscritura(async () => {
          const previo = this.estado.tareasEnVuelo[item.id];
          this.estado.tareasEnVuelo[item.id] = {
            tareaId: previo?.tareaId ?? `tarea_${params.fechaDatos}_${item.id}`,
            idProceso: item.id,
            ejecucionId: params.ejecucionId,
            ciclo: params.ciclo,
            fuente: params.fuente,
            fechaDatos: params.fechaDatos,
            horaInicio: previo?.horaInicio ?? params.horaInicio,
            entrada: truncarTexto(item.nombreProceso, 120),
            aptoPyme: item.aptoPyme,
            categoriaObjeto: item.categoriaObjeto,
            falloAgente1: false,
            motivoFalloAgente1: null,
            intentosAgente1: params.intentosPagina,
            tokensAgente1: tokensAsignados,
            costoAsignadoUSD: costoAsignadoPorProceso,
            latenciaAgente1Seg: latenciaPorProceso,
            etapaActual: "agente1_completado",
            reanudadoTrasReinicio: Boolean(
              previo?.reanudadoTrasReinicio || this.enVueloPrevioAlInicio.has(item.id),
            ),
          };
          await this.guardarEstadoAtomico();
        });
        enVueloParaEtapas2y3++;
      }
    }

    return { finalizadosInmediatos, enVueloParaEtapas2y3 };
  }

  /**
   * Registra el avance de un proceso en el Agente 2 (resumidor).
   */
  public async registrarAvanceAgente2(params: {
    idProceso: string;
    nombreProceso?: string;
    ejecucionId: string;
    ciclo: number;
    fuente: FuenteDatosTarea;
    fechaDatos: string;
    horaInicio: string;
    horaFin: string;
    intentosAgente2: number;
    tokensAgente2: { entrada: number; salida: number; total: number };
    resumenOk: boolean;
    errorMensaje?: string | null;
  }): Promise<void> {
    await this.encolarEscritura(async () => {
      await this.inicializar();
      if (this.finalizadosSet.has(params.idProceso)) return;

      const tarifas = await this.obtenerTarifas();
      const costoA2 = calcularCostoTokensUSD(params.tokensAgente2, tarifas);
      const latenciaA2 = Math.max(
        0.001,
        (Date.parse(params.horaFin) - Date.parse(params.horaInicio)) / 1000,
      );

      const existente = this.estado.tareasEnVuelo[params.idProceso];
      const reanudado = Boolean(
        existente?.reanudadoTrasReinicio || this.enVueloPrevioAlInicio.has(params.idProceso),
      );

      this.agente2Set.add(params.idProceso);

      this.estado.tareasEnVuelo[params.idProceso] = {
        tareaId: existente?.tareaId ?? `tarea_${params.fechaDatos}_${params.idProceso}`,
        idProceso: params.idProceso,
        ejecucionId: params.ejecucionId,
        ciclo: params.ciclo,
        fuente: params.fuente,
        fechaDatos: params.fechaDatos,
        horaInicio: existente?.horaInicio ?? params.horaInicio,
        entrada: existente?.entrada ?? truncarTexto(params.nombreProceso ?? params.idProceso, 120),
        aptoPyme: existente?.aptoPyme ?? "si",
        categoriaObjeto: existente?.categoriaObjeto ?? "Proceso apto",
        falloAgente1: existente?.falloAgente1 ?? false,
        motivoFalloAgente1: existente?.motivoFalloAgente1 ?? null,
        intentosAgente1: existente?.intentosAgente1 ?? 1,
        tokensAgente1: existente?.tokensAgente1 ?? { entrada: 0, salida: 0, total: 0 },
        costoAsignadoUSD:
          existente?.costoAsignadoUSD !== undefined
            ? existente.costoAsignadoUSD
            : tarifas
              ? 0
              : null,
        latenciaAgente1Seg: existente?.latenciaAgente1Seg ?? 0,
        etapaActual: "agente2_completado",
        reanudadoTrasReinicio: reanudado,
        resumenOk: params.resumenOk,
        intentosAgente2: params.intentosAgente2,
        errorAgente2: params.errorMensaje ?? null,
        tokensAgente2: params.tokensAgente2,
        costoDirectoA2USD: costoA2,
        latenciaAgente2Seg: Number(latenciaA2.toFixed(3)),
      };

      await this.guardarEstadoAtomico();
    });
  }

  /**
   * Finaliza un proceso tras completar el Agente 3 (documentos) y escribe su fila
   * inmediatamente en `bitacora-tareas.csv` y `bitacora-tareas.jsonl`.
   */
  public async finalizarProcesoEnAgente3(params: {
    idProceso: string;
    nombreProceso?: string;
    ejecucionId: string;
    ciclo: number;
    fuente: FuenteDatosTarea;
    fechaDatos: string;
    horaInicio: string;
    horaFin: string;
    intentosAgente3: number;
    tokensAgente3: { entrada: number; salida: number; total: number };
    documentosOk: boolean;
    errorMensaje?: string | null;
  }): Promise<{ escrito: boolean; duplicado: boolean; fila: FilaBitacoraTarea }> {
    await this.inicializar();

    const parcial = this.estado.tareasEnVuelo[params.idProceso];
    const tarifas = await this.obtenerTarifas();
    const costoA3 = calcularCostoTokensUSD(params.tokensAgente3, tarifas);
    const latenciaA3 = Math.max(
      0.001,
      (Date.parse(params.horaFin) - Date.parse(params.horaInicio)) / 1000,
    );

    const resumenOk = parcial?.resumenOk ?? true;
    const documentosOk = params.documentosOk;
    const falloA1 = parcial?.falloAgente1 ?? false;
    const aptoPyme = parcial?.aptoPyme ?? "si";
    const categoriaObjeto = parcial?.categoriaObjeto ?? "Proceso apto";

    const exito = evaluarExitoTarea({
      aptoPyme,
      falloAgente1: falloA1,
      requiereEtapas2y3: true,
      resumenOk,
      documentosOk,
    });

    const reanudado = Boolean(
      parcial?.reanudadoTrasReinicio || this.enVueloPrevioAlInicio.has(params.idProceso),
    );
    const reintentosA1 = Math.max(0, (parcial?.intentosAgente1 ?? 1) - 1);
    const reintentosA2 = Math.max(0, (parcial?.intentosAgente2 ?? 1) - 1);
    const reintentosA3 = Math.max(0, params.intentosAgente3 - 1);

    const partesRec: string[] = [];
    if (reanudado) partesRec.push("reanudado tras reinicio");
    if (reintentosA1 > 0) partesRec.push(`reintentos_agente1=${reintentosA1}`);
    if (reintentosA2 > 0) partesRec.push(`reintentos_agente2=${reintentosA2}`);
    if (reintentosA3 > 0) partesRec.push(`reintentos_agente3=${reintentosA3}`);

    let errorTipo: string | null = null;
    let errorMensaje: string | null = null;

    if (!resumenOk) {
      errorTipo = "error_modelo_agente2";
      errorMensaje = parcial?.errorAgente2 ?? "Fallback por error de comunicación en Agente 2";
      partesRec.push("marcado fallido (fallback en Agente 2)");
    } else if (!documentosOk) {
      errorTipo = "error_modelo_agente3";
      errorMensaje = params.errorMensaje ?? "Fallback por error de comunicación en Agente 3";
      partesRec.push("marcado fallido (fallback en Agente 3)");
    } else if (partesRec.length === 0) {
      partesRec.push("sin reintentos");
    }

    const tokensEntrada =
      (parcial?.tokensAgente1.entrada ?? 0) +
      (parcial?.tokensAgente2?.entrada ?? 0) +
      params.tokensAgente3.entrada;
    const tokensSalida =
      (parcial?.tokensAgente1.salida ?? 0) +
      (parcial?.tokensAgente2?.salida ?? 0) +
      params.tokensAgente3.salida;
    const tokensTotal =
      (parcial?.tokensAgente1.total ?? 0) +
      (parcial?.tokensAgente2?.total ?? 0) +
      params.tokensAgente3.total;

    const costoDirectoUSD =
      tarifas !== null
        ? Number(((parcial?.costoDirectoA2USD ?? 0) + (costoA3 ?? 0)).toFixed(6))
        : null;
    const costoAsignadoUSD =
      tarifas !== null
        ? Number((parcial?.costoAsignadoUSD ?? 0).toFixed(6))
        : null;

    const latenciaTotalSeg = Number(
      (
        (parcial?.latenciaAgente1Seg ?? 0) +
        (parcial?.latenciaAgente2Seg ?? 0) +
        latenciaA3
      ).toFixed(3),
    );

    const fila: FilaBitacoraTarea = {
      tareaId: parcial?.tareaId ?? `tarea_${params.fechaDatos}_${params.idProceso}`,
      ejecucionId: params.ejecucionId,
      ciclo: params.ciclo,
      fuente: params.fuente,
      fechaDatos: params.fechaDatos,
      horaInicio: parcial?.horaInicio ?? params.horaInicio,
      horaFin: params.horaFin,
      idProceso: params.idProceso,
      entrada: parcial?.entrada ?? truncarTexto(params.nombreProceso ?? params.idProceso, 120),
      resultado: {
        aptoPyme,
        categoriaObjeto,
        resumenOk,
        documentosOk,
      },
      exito,
      errorTipo,
      errorMensaje,
      recuperacion: partesRec.join("; "),
      tokensEntrada,
      tokensSalida,
      tokensTotal,
      costoDirectoUSD,
      costoAsignadoUSD,
      latenciaSeg: latenciaTotalSeg,
    };

    return this.registrarTareaFinalizada(fila);
  }

  /**
   * Registra como tarea finalizada (con `exito: false`) un proceso que fue estacionado
   * por límite de lote (`maxAptos`) o que no pudo completar las etapas restantes.
   */
  public async registrarProcesoEstacionadoOFallido(params: {
    idProceso: string;
    nombreProceso?: string;
    aptoPyme?: "si" | "no" | "dudoso" | null;
    categoriaObjeto?: string | null;
    ejecucionId: string;
    ciclo: number;
    fuente: FuenteDatosTarea;
    fechaDatos: string;
    horaFin?: string;
    motivoTipo: string;
    motivoMensaje: string;
    recuperacion: string;
  }): Promise<{ escrito: boolean; duplicado: boolean; fila: FilaBitacoraTarea }> {
    await this.inicializar();

    const parcial = this.estado.tareasEnVuelo[params.idProceso];
    const tarifas = await this.obtenerTarifas();
    const ahora = params.horaFin ?? new Date().toISOString();

    const tokensEntrada =
      (parcial?.tokensAgente1.entrada ?? 0) + (parcial?.tokensAgente2?.entrada ?? 0);
    const tokensSalida =
      (parcial?.tokensAgente1.salida ?? 0) + (parcial?.tokensAgente2?.salida ?? 0);
    const tokensTotal =
      (parcial?.tokensAgente1.total ?? 0) + (parcial?.tokensAgente2?.total ?? 0);

    const costoDirectoUSD =
      tarifas !== null ? Number((parcial?.costoDirectoA2USD ?? 0).toFixed(6)) : null;
    const costoAsignadoUSD =
      tarifas !== null ? Number((parcial?.costoAsignadoUSD ?? 0).toFixed(6)) : null;

    const reanudado = Boolean(
      parcial?.reanudadoTrasReinicio || this.enVueloPrevioAlInicio.has(params.idProceso),
    );
    const recFinal = reanudado
      ? `reanudado tras reinicio; ${params.recuperacion}`
      : params.recuperacion;

    const fila: FilaBitacoraTarea = {
      tareaId: parcial?.tareaId ?? `tarea_${params.fechaDatos}_${params.idProceso}`,
      ejecucionId: params.ejecucionId,
      ciclo: params.ciclo,
      fuente: params.fuente,
      fechaDatos: params.fechaDatos,
      horaInicio: parcial?.horaInicio ?? ahora,
      horaFin: ahora,
      idProceso: params.idProceso,
      entrada: parcial?.entrada ?? truncarTexto(params.nombreProceso ?? params.idProceso, 120),
      resultado: {
        aptoPyme: parcial?.aptoPyme ?? params.aptoPyme ?? "si",
        categoriaObjeto: parcial?.categoriaObjeto ?? params.categoriaObjeto ?? null,
        resumenOk: parcial?.resumenOk ?? false,
        documentosOk: false,
      },
      exito: false,
      errorTipo: params.motivoTipo,
      errorMensaje: params.motivoMensaje,
      recuperacion: recFinal,
      tokensEntrada,
      tokensSalida,
      tokensTotal,
      costoDirectoUSD,
      costoAsignadoUSD,
      latenciaSeg: Number(
        ((parcial?.latenciaAgente1Seg ?? 0) + (parcial?.latenciaAgente2Seg ?? 0)).toFixed(3),
      ),
    };

    return this.registrarTareaFinalizada(fila);
  }

  /**
   * Lee todas las filas registradas en `bitacora-tareas.jsonl`.
   */
  public async leerFilasRegistradas(): Promise<FilaBitacoraTarea[]> {
    try {
      const raw = await readFile(this.rutaJsonl, "utf8");
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as FilaBitacoraTarea);
    } catch {
      return [];
    }
  }

  /**
   * Calcula el resumen consolidado con las tres definiciones de unidades en paralelo
   * (oficial fin a fin, solo veredicto Agente 1, y "si" completados en Agentes 1, 2 y 3).
   */
  public async obtenerResumenBitacora(): Promise<ResumenBitacoraTareas> {
    const filas = await this.leerFilasRegistradas();
    return calcularResumenBitacora(filas);
  }

  public async obtenerResumen(): Promise<ResumenBitacoraTareas> {
    return this.obtenerResumenBitacora();
  }
}

/**
 * Calcula las estadísticas y los tres conteos paralelos de unidades de trabajo
 * a partir de una lista de filas de la bitácora.
 */
export function calcularResumenBitacora(filas: FilaBitacoraTarea[]): ResumenBitacoraTareas {
  const total = filas.length;
  let exitosas = 0;
  let fallidas = 0;
  let soloVeredictoAgente1 = 0;
  let siCompletados123 = 0;

  let tokensEntrada = 0;
  let tokensSalida = 0;
  let tokensTotal = 0;
  let sumaDirecto = 0;
  let sumaAsignado = 0;
  let hayPrecios = false;

  for (const f of filas) {
    if (f.exito) exitosas++;
    else fallidas++;

    if (
      f.resultado.aptoPyme !== null &&
      f.errorTipo !== "omision_modelo_agente1" &&
      f.errorTipo !== "error_modelo_agente1"
    ) {
      soloVeredictoAgente1++;
    }

    if (
      f.resultado.aptoPyme === "si" &&
      f.resultado.resumenOk === true &&
      f.resultado.documentosOk === true &&
      f.exito
    ) {
      siCompletados123++;
    }

    tokensEntrada += f.tokensEntrada || 0;
    tokensSalida += f.tokensSalida || 0;
    tokensTotal += f.tokensTotal || 0;

    if (typeof f.costoDirectoUSD === "number") {
      sumaDirecto += f.costoDirectoUSD;
      hayPrecios = true;
    }
    if (typeof f.costoAsignadoUSD === "number") {
      sumaAsignado += f.costoAsignadoUSD;
      hayPrecios = true;
    }
  }

  const tasaExitoPorcentaje = total > 0 ? Number(((exitosas / total) * 100).toFixed(2)) : 0;
  const costoDirectoTotalUSD = hayPrecios ? Number(sumaDirecto.toFixed(6)) : null;
  const costoAsignadoTotalUSD = hayPrecios ? Number(sumaAsignado.toFixed(6)) : null;
  const costoTotalUSD = hayPrecios ? Number((sumaDirecto + sumaAsignado).toFixed(6)) : null;
  const costoPromedioPorTareaUSD =
    hayPrecios && total > 0 ? Number(((sumaDirecto + sumaAsignado) / total).toFixed(6)) : null;

  return {
    definicionOficial: DEFINICION_UNIDAD_TRABAJO,
    unidadesOficiales: {
      total,
      exitosas,
      fallidas,
      tasaExitoPorcentaje,
    },
    conteosSecundarios: {
      soloVeredictoAgente1,
      siCompletadosAgentes123: siCompletados123,
    },
    tokens: {
      entrada: tokensEntrada,
      salida: tokensSalida,
      total: tokensTotal,
    },
    costos: {
      preciosConfigurados: hayPrecios,
      costoDirectoTotalUSD,
      costoAsignadoTotalUSD,
      costoTotalUSD,
      costoPromedioPorTareaUSD,
    },
  };
}

// ============================================================================
// 7. INSTANCIA COMPARTIDA Y CONTEXTO PARA HOOKS DEL PIPELINE
// ============================================================================

export interface ContextoEjecucionBitacora {
  gestor: GestorBitacoraTareas;
  ejecucionId: string;
  ciclo: number;
  fuente: FuenteDatosTarea;
  fechaDatos: string;
  incluirDudosos?: boolean;
}

const almacenamientoBitacora = new AsyncLocalStorage<ContextoEjecucionBitacora>();

let gestorPorDefecto: GestorBitacoraTareas | null = null;

/**
 * Obtiene el gestor de bitácora activo en el contexto actual o la instancia por defecto.
 */
export function obtenerGestorBitacora(): GestorBitacoraTareas {
  const ctx = almacenamientoBitacora.getStore();
  if (ctx?.gestor) return ctx.gestor;
  if (!gestorPorDefecto) {
    gestorPorDefecto = new GestorBitacoraTareas();
  }
  return gestorPorDefecto;
}

/**
 * Ejecuta una función dentro de un contexto de bitácora específico (útil para ciclos
 * de carga, modo daemon o pruebas aisladas).
 */
export function ejecutarConContextoBitacora<T>(
  contexto: ContextoEjecucionBitacora,
  fn: () => Promise<T>,
): Promise<T> {
  return almacenamientoBitacora.run(contexto, fn);
}

/**
 * Resuelve los metadatos de contexto para los hooks del pipeline cuando se invoca
 * desde el grafo o desde los CLIs individuales.
 */
export function resolverMetaContextoBitacora(fechaFallback: string, incluirDudosos?: boolean): {
  gestor: GestorBitacoraTareas;
  ejecucionId: string;
  ciclo: number;
  fuente: FuenteDatosTarea;
  fechaDatos: string;
  incluirDudosos: boolean;
} {
  const ctx = almacenamientoBitacora.getStore();
  const ctxTokens = obtenerContextoTokens();
  const fechaPrueba = leerFechaPrueba();

  return {
    gestor: ctx?.gestor ?? obtenerGestorBitacora(),
    ejecucionId: ctx?.ejecucionId ?? ctxTokens?.ejecucionId ?? "ejecucion-local",
    ciclo: ctx?.ciclo ?? 1,
    fuente: ctx?.fuente ?? (fechaPrueba ? "historico" : "hoy"),
    fechaDatos: ctx?.fechaDatos ?? fechaFallback,
    incluirDudosos: Boolean(incluirDudosos ?? ctx?.incluirDudosos),
  };
}

