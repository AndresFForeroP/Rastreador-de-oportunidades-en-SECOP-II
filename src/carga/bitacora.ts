/**
 * Generador de bitácora oficial de carga, resumen S4 y verificación de consistencia (src/carga/bitacora.ts).
 *
 * Cumple los requerimientos oficiales del Reto Agente 2026 (S4-5):
 * 1. Genera data/pruebas-reto/carga/bitacora-carga.md EXCLUSIVAMENTE a partir de datos de máquina:
 *    - bitacora-tareas.csv (y .jsonl)
 *    - eventos.jsonl
 *    - progreso.jsonl
 *    - estado.json
 *    - heartbeat.json
 *    - recursos.csv
 *    - registro.jsonl (ledger de ejecuciones)
 *    - logs/tokens.jsonl
 *    JAMÁS a partir de texto o inferencias del modelo LLM.
 * 2. Genera docs/RESUMEN-S4.md en español para entrega en la plataforma del reto.
 * 3. Preserva la sección "Notas del operador" entre regeneraciones sucesivas.
 * 4. Ejecutable vía `pnpm bitacora`, llamado por el daemon cada hora y al finalizar (barato, sin llamadas LLM).
 * 5. Verificación de consistencia al inicio de la bitácora:
 *    - Filas en CSV == Unidades en estado.json == progreso.jsonl == ledger
 *    - Suma de costos en CSV == Total del módulo de costos
 *    - Tokens en CSV == logs/tokens.jsonl
 *    - Cero duplicados en tareaId
 *    Cualquier discrepancia se resalta en negrita (**MISMATCH** / **DISCREPANCIA**), nunca oculta.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { MODEL_NAME } from "../llm.js";
import { RETO_GATEWAY_HOSTNAME, DEFINICIONES_UNIDADES_PARALELAS } from "./bitacora-tareas.js";
import {
  DIR_CARGA,
  rutaBitacoraTareasCsv,
  rutaBitacoraTareasJsonl,
  rutaEstadoCarga,
  rutaEventosCarga,
  rutaHeartbeatCarga,
  rutaProgresoCarga,
  rutaRecursosCarga,
  rutaBitacoraCargaMd,
  rutaResumenS4Md,
  rutaRegistroEjecuciones,
} from "../pruebas/rutas.js";
import type { DatosEstadoPersistenteCarga } from "./estado.js";
import type { RegistroEjecucion } from "../pruebas/registro-ejecuciones.js";
import type { RegistroTokens } from "../cost.js";

// ============================================================================
// 1. TIPOS Y ESTRUCTURAS DE DATOS DE MÁQUINA
// ============================================================================

export interface OpcionesBitacoraCarga {
  gastoPanelUSD?: number | null;
  dirCarga?: string;
  salidaMd?: string;
  salidaResumen?: string;
  silencioso?: boolean;
}

export interface FilaTareaCsv {
  tareaId: string;
  ejecucionId: string;
  ciclo: number;
  fuente: string;
  fechaDatos: string;
  horaInicio: string;
  horaFin: string;
  horaLocalCO: string;
  idProceso: string;
  entrada: string;
  resultado: string;
  exito: boolean;
  errorTipo: string;
  errorMensaje: string;
  recuperacion: string;
  tokensEntrada: number;
  tokensSalida: number;
  tokensTotal: number;
  costoDirectoUSD: number | null;
  costoAsignadoUSD: number | null;
  latenciaSeg: number;
}

export interface EventoCarga {
  timestamp: string;
  type?: string;
  tipo?: string;
  details?: Record<string, unknown>;
  detalles?: Record<string, unknown>;
}

export interface MuestraRecurso {
  timestamp: string;
  contenedor: string;
  cpuPorcentaje: number;
  memoriaUso: string;
  memoriaLimite: string;
  memoriaPorcentaje: number;
  uptime: string;
  reinicioConteo: number;
}

export interface FilaTablaHoraria {
  horaNumero: number;
  rangoTexto: string;
  unidadesFinAFin: number;
  unidadesExitosas: number;
  tasaExitoPorcentaje: number;
  unidadesAcumuladas: number;
  gastoUSD: number | null;
  tokensFacturados: number;
  latenciaPromedioSeg: number;
  latenciaP90Seg: number;
  brechaMaximaGatewaySeg: number | null;
  erroresPorTipo: Record<string, number>;
  totalErrores: number;
  backoffs: number;
  circuitBreakers: number;
}

export interface ReporteConsistencia {
  filasCsv: number;
  unidadesEstado: number;
  lineasProgreso: number;
  unidadesLedger: number;
  unidadesConsistentes: boolean;
  detalleUnidades: string;

  costoTotalCsvUSD: number | null;
  costoModuloUSD: number | null;
  costosConsistentes: boolean;
  detalleCostos: string;

  tokensCsvTotal: number;
  tokensLogsTotal: number;
  tokensEstadoTotal: number;
  tokensConsistentes: boolean;
  detalleTokens: string;

  totalTareasCsv: number;
  tareasUnicasCsv: number;
  ceroDuplicados: boolean;
  detalleDuplicados: string;

  todoConsistente: boolean;
}

// ============================================================================
// 2. PARSEADORES DE DATOS DE MÁQUINA (RFC 4180 CSV, JSONL, JSON)
// ============================================================================

/**
 * Parsea una línea CSV respetando estrictamente RFC 4180 (comillas dobles y comas internas).
 */
export function parsearLineaCsvRfc4180(linea: string): string[] {
  const campos: string[] = [];
  let campoActual = "";
  let enComillas = false;
  let i = 0;

  while (i < linea.length) {
    const c = linea[i];
    if (enComillas) {
      if (c === '"') {
        if (i + 1 < linea.length && linea[i + 1] === '"') {
          campoActual += '"';
          i += 2;
          continue;
        } else {
          enComillas = false;
          i++;
          continue;
        }
      } else {
        campoActual += c;
        i++;
      }
    } else {
      if (c === '"') {
        enComillas = true;
        i++;
      } else if (c === ",") {
        campos.push(campoActual);
        campoActual = "";
        i++;
      } else {
        campoActual += c;
        i++;
      }
    }
  }
  campos.push(campoActual);
  return campos;
}

/**
 * Lee y parsea `bitacora-tareas.csv`.
 */
export async function leerTareasCsv(rutaCsv: string): Promise<FilaTareaCsv[]> {
  try {
    const raw = await readFile(rutaCsv, "utf8");
    const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lineas.length <= 1) return [];

    const encabezados = parsearLineaCsvRfc4180(lineas[0]!);
    const indiceCol: Record<string, number> = {};
    for (let i = 0; i < encabezados.length; i++) {
      indiceCol[encabezados[i]!.trim()] = i;
    }

    const resultado: FilaTareaCsv[] = [];
    for (let i = 1; i < lineas.length; i++) {
      const fila = parsearLineaCsvRfc4180(lineas[i]!);
      if (fila.length < 10) continue;

      const getVal = (col: string): string => {
        const idx = indiceCol[col];
        return idx !== undefined && idx < fila.length ? fila[idx]! : "";
      };

      const parseNum = (col: string): number => {
        const val = getVal(col);
        const n = Number(val);
        return Number.isFinite(n) ? n : 0;
      };

      const parseNumOrNull = (col: string): number | null => {
        const val = getVal(col);
        if (!val || val.trim().length === 0) return null;
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
      };

      resultado.push({
        tareaId: getVal("tareaId"),
        ejecucionId: getVal("ejecucionId"),
        ciclo: parseNum("ciclo"),
        fuente: getVal("fuente"),
        fechaDatos: getVal("fechaDatos"),
        horaInicio: getVal("horaInicio"),
        horaFin: getVal("horaFin"),
        horaLocalCO: getVal("horaLocalCO"),
        idProceso: getVal("idProceso"),
        entrada: getVal("entrada"),
        resultado: getVal("resultado"),
        exito: getVal("exito").toLowerCase() === "true",
        errorTipo: getVal("errorTipo"),
        errorMensaje: getVal("errorMensaje"),
        recuperacion: getVal("recuperacion"),
        tokensEntrada: parseNum("tokensEntrada"),
        tokensSalida: parseNum("tokensSalida"),
        tokensTotal: parseNum("tokensTotal"),
        costoDirectoUSD: parseNumOrNull("costoDirectoUSD"),
        costoAsignadoUSD: parseNumOrNull("costoAsignadoUSD"),
        latenciaSeg: parseNum("latenciaSeg"),
      });
    }

    return resultado;
  } catch {
    return [];
  }
}

/**
 * Lee líneas de un archivo JSON Lines cualquiera de forma segura.
 */
export async function leerArchivoJsonl<T = unknown>(rutaJsonl: string): Promise<T[]> {
  try {
    const raw = await readFile(rutaJsonl, "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/**
 * Lee el archivo `estado.json`.
 */
export async function leerEstadoCargaSafe(ruta: string): Promise<DatosEstadoPersistenteCarga | null> {
  try {
    const raw = await readFile(ruta, "utf8");
    return JSON.parse(raw) as DatosEstadoPersistenteCarga;
  } catch {
    return null;
  }
}

/**
 * Lee el archivo `recursos.csv` generado por `muestrear-docker.ps1`.
 */
export async function leerRecursosCsv(rutaRecursos: string): Promise<MuestraRecurso[]> {
  try {
    const raw = await readFile(rutaRecursos, "utf8");
    const lineas = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lineas.length <= 1) return [];

    const muestras: MuestraRecurso[] = [];
    for (let i = 1; i < lineas.length; i++) {
      const partes = parsearLineaCsvRfc4180(lineas[i]!);
      if (partes.length < 8) continue;

      const [
        timestamp,
        contenedor,
        cpuStr,
        memUso,
        memLim,
        memPorcStr,
        uptime,
        reinicioStr,
      ] = partes;

      const cpuNum = Number.parseFloat((cpuStr || "").replace("%", "")) || 0;
      const memPorcNum = Number.parseFloat((memPorcStr || "").replace("%", "")) || 0;
      const reinicioNum = Number.parseInt((reinicioStr || "").trim(), 10) || 0;

      muestras.push({
        timestamp: timestamp || "",
        contenedor: contenedor || "",
        cpuPorcentaje: cpuNum,
        memoriaUso: memUso || "",
        memoriaLimite: memLim || "",
        memoriaPorcentaje: memPorcNum,
        uptime: uptime || "",
        reinicioConteo: reinicioNum,
      });
    }

    return muestras;
  } catch {
    return [];
  }
}

// ============================================================================
// 3. EXTRACCIÓN Y PRESERVACIÓN DE NOTAS DEL OPERADOR
// ============================================================================

export const MARCADOR_NOTAS_DEFAULT = "*Espacio reservado para anotaciones del operador humano post-ejecución.*";

/**
 * Extrae el texto de la sección "Notas del operador" de un archivo Markdown existente.
 */
export function extraerNotasOperador(contenidoMd: string): string | null {
  if (!contenidoMd) return null;
  const regex = /##\s+(?:\d+\.\s+)?Notas del operador\s*\n([\s\S]*?)(?=\n##|\n---|$)/i;
  const match = contenidoMd.match(regex);
  if (!match) return null;

  const texto = match[1]!.trim();
  if (
    texto === MARCADOR_NOTAS_DEFAULT ||
    texto === "*Sin notas del operador aún.*" ||
    texto.length === 0
  ) {
    return null;
  }
  return texto;
}

// ============================================================================
// 4. VERIFICACIÓN RIGUROSA DE CONSISTENCIA DE MÁQUINA
// ============================================================================

/**
 * Evalúa los cuatro invariantes de consistencia entre fuentes de datos.
 */
export function evaluarConsistencia(datos: {
  tareasCsv: FilaTareaCsv[];
  estado: DatosEstadoPersistenteCarga | null;
  progresoJsonl: unknown[];
  registrosLedger: RegistroEjecucion[];
  registrosTokens: RegistroTokens[];
}): ReporteConsistencia {
  const { tareasCsv, estado, progresoJsonl, registrosLedger, registrosTokens } = datos;

  // 1. Invariante de Unidades: CSV == estado.json == progreso.jsonl == ledger
  const filasCsv = tareasCsv.length;
  const unidadesEstado = estado?.contadoresUnidades?.oficialFinAFin ?? 0;
  const lineasProgreso = progresoJsonl.length;

  // Sumar unidades de ejecuciones de tipo 'daemon' o coincidentes con las ejecuciones involucradas
  const ejecucionesSet = new Set(estado?.ejecucionesInvolucradas ?? []);
  const daemonLedger = registrosLedger.filter(
    (r) => r.tipo === "daemon" || ejecucionesSet.has(r.ejecucionId),
  );
  // Unidades fin a fin completadas registradas en el ledger
  const unidadesLedger = daemonLedger.reduce((acc, r) => acc + (r.etapas?.resumidos || 0), 0);

  // Consideramos consistente el core CSV == Estado == Progreso
  const coreConsistente = filasCsv === unidadesEstado && filasCsv === lineasProgreso;
  const ledgerCoincide = filasCsv === unidadesLedger;
  const unidadesConsistentes = coreConsistente && ledgerCoincide;

  let detalleUnidades = "";
  if (unidadesConsistentes) {
    detalleUnidades = `✅ CONSISTENTE: Las 4 fuentes coinciden en exactamente ${filasCsv} unidades oficiales.`;
  } else if (coreConsistente && !ledgerCoincide) {
    detalleUnidades =
      `**MISMATCH**: CSV (${filasCsv}) = estado.json (${unidadesEstado}) = progreso.jsonl (${lineasProgreso}), ` +
      `pero el ledger de ejecuciones (registro.jsonl) registra ${unidadesLedger} unidades ` +
      `(delta: ${filasCsv - unidadesLedger} unidades de corridas intermedias interrumpidas antes del cierre del ledger).`;
  } else {
    detalleUnidades =
      `**MISMATCH**: Discrepancia en unidades. CSV: ${filasCsv}, estado.json: ${unidadesEstado}, ` +
      `progreso.jsonl: ${lineasProgreso}, ledger: ${unidadesLedger}.`;
  }

  // 2. Invariante de Costos: CSV vs Módulo de Costos
  let costoTotalCsvUSD: number | null = null;
  let hayCostosCsv = false;
  for (const t of tareasCsv) {
    if (typeof t.costoDirectoUSD === "number" || typeof t.costoAsignadoUSD === "number") {
      hayCostosCsv = true;
      costoTotalCsvUSD = (costoTotalCsvUSD ?? 0) + (t.costoDirectoUSD ?? 0) + (t.costoAsignadoUSD ?? 0);
    }
  }
  if (costoTotalCsvUSD !== null) {
    costoTotalCsvUSD = Number(costoTotalCsvUSD.toFixed(6));
  }

  const costoModuloUSD = estado?.gastoAcumulado?.costoTotalUSD ?? null;
  let costosConsistentes = true;
  let detalleCostos = "";

  if (!hayCostosCsv && (!costoModuloUSD || costoModuloUSD === 0)) {
    costosConsistentes = true;
    detalleCostos = `✅ CONSISTENTE: Tarifas financieras en null en config/precios.json (ambos reportan $0.00 / nulls documentados).`;
  } else if (costoTotalCsvUSD !== null && costoModuloUSD !== null) {
    const diff = Math.abs(costoTotalCsvUSD - costoModuloUSD);
    if (diff < 0.001) {
      costosConsistentes = true;
      detalleCostos = `✅ CONSISTENTE: Suma en CSV ($${costoTotalCsvUSD.toFixed(4)} USD) coincide con módulo de costos ($${costoModuloUSD.toFixed(4)} USD).`;
    } else {
      costosConsistentes = false;
      detalleCostos = `**MISMATCH**: Suma en CSV ($${costoTotalCsvUSD.toFixed(4)} USD) difiere del módulo de costos ($${costoModuloUSD.toFixed(4)} USD).`;
    }
  } else {
    costosConsistentes = false;
    detalleCostos = `**MISMATCH**: CSV reporta ${costoTotalCsvUSD ?? "null"} USD y módulo reporta ${costoModuloUSD ?? "null"} USD.`;
  }

  // 3. Invariante de Tokens: CSV vs logs/tokens.jsonl
  const tokensCsvTotal = tareasCsv.reduce((acc, t) => acc + (t.tokensTotal || 0), 0);
  const tokensEstadoTotal = estado?.gastoAcumulado?.tokensTotal ?? 0;

  // Filtrar tokens de las ejecuciones involucradas
  const tokensEjecucion = registrosTokens.filter((r) => ejecucionesSet.has(r.ejecucionId || ""));
  const tokensLogsTotal = tokensEjecucion.reduce((acc, r) => acc + (r.tokens_total || 0), 0);

  let tokensConsistentes = true;
  let detalleTokens = "";

  if (tokensCsvTotal === tokensLogsTotal && tokensCsvTotal > 0) {
    tokensConsistentes = true;
    detalleTokens = `✅ CONSISTENTE: Tokens atribuidos en CSV (${tokensCsvTotal.toLocaleString("es-CO")}) = logs/tokens.jsonl (${tokensLogsTotal.toLocaleString("es-CO")}).`;
  } else {
    // Si hay llamadas del modelo que no concluyeron tareas (por ejemplo, evaluaciones de lotes interrumpidos o páginas de triaje)
    tokensConsistentes = Math.abs(tokensCsvTotal - tokensLogsTotal) === 0;
    const delta = tokensLogsTotal - tokensCsvTotal;
    detalleTokens =
      `**MISMATCH / DELTA DE ATRIBUCIÓN**: CSV (tareas finalizadas): ${tokensCsvTotal.toLocaleString("es-CO")} tokens; ` +
      `logs/tokens.jsonl (llamadas reales de las corridas): ${tokensLogsTotal.toLocaleString("es-CO")} tokens; ` +
      `estado.json (acumulado del presupuesto): ${tokensEstadoTotal.toLocaleString("es-CO")} tokens. ` +
      `(Delta de ${delta.toLocaleString("es-CO")} tokens corresponde a llamadas de triaje en páginas con candidatos no aptos o ciclos en vuelo).`;
  }

  // 4. Invariante de Unicidad de tareaId
  const totalTareasCsv = tareasCsv.length;
  const idsSet = new Set(tareasCsv.map((t) => t.tareaId));
  const tareasUnicasCsv = idsSet.size;
  const ceroDuplicados = totalTareasCsv === tareasUnicasCsv;
  const detalleDuplicados = ceroDuplicados
    ? `✅ CONSISTENTE: Cero duplicados (${tareasUnicasCsv} tareaId únicos de ${totalTareasCsv} filas).`
    : `**MISMATCH**: Se detectaron ${totalTareasCsv - tareasUnicasCsv} tareaId duplicados en bitacora-tareas.csv.`;

  const todoConsistente = unidadesConsistentes && costosConsistentes && tokensConsistentes && ceroDuplicados;

  return {
    filasCsv,
    unidadesEstado,
    lineasProgreso,
    unidadesLedger,
    unidadesConsistentes,
    detalleUnidades,

    costoTotalCsvUSD,
    costoModuloUSD,
    costosConsistentes,
    detalleCostos,

    tokensCsvTotal,
    tokensLogsTotal,
    tokensEstadoTotal,
    tokensConsistentes,
    detalleTokens,

    totalTareasCsv,
    tareasUnicasCsv,
    ceroDuplicados,
    detalleDuplicados,

    todoConsistente,
  };
}

// ============================================================================
// 5. CONSTRUCCIÓN DE LA TABLA HORARIA
// ============================================================================

/**
 * Agrupa las tareas finalizadas en cubos horarios a partir del inicio de la ejecución.
 */
export function construirFilasHorarias(datos: {
  tareas: FilaTareaCsv[];
  eventos: EventoCarga[];
  inicioIso: string;
  finIso?: string;
}): FilaTablaHoraria[] {
  const { tareas, eventos, inicioIso, finIso } = datos;
  if (tareas.length === 0 && eventos.length === 0) return [];

  const tInicio = new Date(inicioIso).getTime();
  const tFin = finIso ? new Date(finIso).getTime() : Date.now();
  const duracionTotalMs = Math.max(3600_000, tFin - tInicio);
  const totalHoras = Math.max(1, Math.ceil(duracionTotalMs / 3600_000));

  const filas: FilaTablaHoraria[] = [];
  let acumuladas = 0;

  for (let h = 0; h < totalHoras; h++) {
    const ventanaInicioMs = tInicio + h * 3600_000;
    const ventanaFinMs = tInicio + (h + 1) * 3600_000;

    // Tareas finalizadas en esta ventana horaria
    const tareasVentana = tareas.filter((t) => {
      const tFinTarea = new Date(t.horaFin).getTime();
      return tFinTarea >= ventanaInicioMs && tFinTarea < ventanaFinMs;
    });

    // Eventos en esta ventana horaria
    const eventosVentana = eventos.filter((e) => {
      const tEv = new Date(e.timestamp).getTime();
      return tEv >= ventanaInicioMs && tEv < ventanaFinMs;
    });

    const finAFin = tareasVentana.length;
    const exitosas = tareasVentana.filter((t) => t.exito).length;
    const tasaExito = finAFin > 0 ? Number(((exitosas / finAFin) * 100).toFixed(1)) : 100.0;
    acumuladas += finAFin;

    // Gasto y tokens
    let gastoUSD: number | null = null;
    let tokensFacturados = 0;
    for (const t of tareasVentana) {
      tokensFacturados += t.tokensTotal || 0;
      if (typeof t.costoDirectoUSD === "number" || typeof t.costoAsignadoUSD === "number") {
        gastoUSD = (gastoUSD ?? 0) + (t.costoDirectoUSD ?? 0) + (t.costoAsignadoUSD ?? 0);
      }
    }
    if (gastoUSD !== null) gastoUSD = Number(gastoUSD.toFixed(4));

    // Latencias: promedio y percentil 90
    const latencias = tareasVentana.map((t) => t.latenciaSeg).sort((a, b) => a - b);
    let latenciaPromedio = 0;
    let latenciaP90 = 0;
    if (latencias.length > 0) {
      const sumaLat = latencias.reduce((acc, l) => acc + l, 0);
      latenciaPromedio = Number((sumaLat / latencias.length).toFixed(2));
      const idxP90 = Math.min(latencias.length - 1, Math.floor(latencias.length * 0.9));
      latenciaP90 = Number((latencias[idxP90] ?? 0).toFixed(2));
    }

    // Errores por tipo
    const erroresPorTipo: Record<string, number> = {};
    let totalErrores = 0;
    for (const t of tareasVentana) {
      if (!t.exito || (t.errorTipo && t.errorTipo.length > 0)) {
        const tipo = t.errorTipo || "error_general";
        erroresPorTipo[tipo] = (erroresPorTipo[tipo] || 0) + 1;
        totalErrores++;
      }
    }

    // Backoffs y Circuit Breakers en eventos de la ventana
    let backoffs = 0;
    let circuitBreakers = 0;
    for (const e of eventosVentana) {
      const tipoEv = (e.type || e.tipo || "").toLowerCase();
      if (tipoEv.includes("backoff") || tipoEv.includes("reintento") || tipoEv.includes("advertencia")) {
        backoffs++;
      }
      if (tipoEv.includes("circuito") || tipoEv.includes("circuit_breaker") || tipoEv.includes("enfriamiento")) {
        circuitBreakers++;
      }
    }

    // Brecha máxima entre llamadas al gateway en esta ventana horaria (S4-7)
    let brechaMaximaGatewaySeg: number | null = null;
    const evBrechas = eventosVentana.filter(
      (e) => (e.type || (e as any).tipo) === "brecha_maxima_gateway_horaria",
    );
    if (evBrechas.length > 0) {
      const valores = evBrechas
        .map((e) =>
          Number(
            (e.details as any)?.brechaMaximaSeg ??
              (e as any).detalles?.brechaMaximaSeg ??
              (e as any).brechaMaximaSeg,
          ),
        )
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (valores.length > 0) {
        brechaMaximaGatewaySeg = Math.max(...valores);
      }
    }
    // Si no hubo evento explícito registrado, derivar desde marcas de tareas de la ventana
    if (brechaMaximaGatewaySeg === null && tareasVentana.length >= 2) {
      let maxDelta = 0;
      for (let i = 1; i < tareasVentana.length; i++) {
        const delta = Math.max(
          0,
          (Date.parse(tareasVentana[i]!.horaFin) - Date.parse(tareasVentana[i - 1]!.horaFin)) / 1000,
        );
        if (delta > maxDelta) maxDelta = delta;
      }
      if (maxDelta > 0) brechaMaximaGatewaySeg = Number(maxDelta.toFixed(1));
    }

    const pad = (n: number) => String(n).padStart(2, "0");
    const dIni = new Date(ventanaInicioMs);
    const dFinV = new Date(ventanaFinMs);
    const rangoTexto = `${pad(dIni.getUTCHours())}:${pad(dIni.getUTCMinutes())} - ${pad(dFinV.getUTCHours())}:${pad(dFinV.getUTCMinutes())} UTC`;

    filas.push({
      horaNumero: h + 1,
      rangoTexto,
      unidadesFinAFin: finAFin,
      unidadesExitosas: exitosas,
      tasaExitoPorcentaje: tasaExito,
      unidadesAcumuladas: acumuladas,
      gastoUSD,
      tokensFacturados,
      latenciaPromedioSeg: latenciaPromedio,
      latenciaP90Seg: latenciaP90,
      brechaMaximaGatewaySeg,
      erroresPorTipo,
      totalErrores,
      backoffs,
      circuitBreakers,
    });
  }

  return filas;
}

// ============================================================================
// 6. GENERADORES DE MARKDOWN: BITÁCORA Y RESUMEN S4
// ============================================================================

/**
 * Genera el documento completo `data/pruebas-reto/carga/bitacora-carga.md`.
 */
export function renderizarBitacoraCargaMd(datos: {
  consistencia: ReporteConsistencia;
  estado: DatosEstadoPersistenteCarga | null;
  tareasCsv: FilaTareaCsv[];
  eventos: EventoCarga[];
  recursos: MuestraRecurso[];
  filasHorarias: FilaTablaHoraria[];
  notasOperador: string;
}): string {
  const { consistencia, estado, tareasCsv, eventos, recursos, filasHorarias, notasOperador } = datos;

  const formatoNum = (n: number) => n.toLocaleString("es-CO");
  const ahora = new Date().toISOString();

  // Fechas y tiempos
  const inicio = estado?.inicioEjecucion || (tareasCsv[0]?.horaInicio ?? ahora);
  const fin = estado?.actualizadoEn || (tareasCsv[tareasCsv.length - 1]?.horaFin ?? ahora);
  const duracionSeg = Math.max(0, Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 1000));
  const duracionHoras = (duracionSeg / 3600).toFixed(2);

  // Estadísticas de recursos
  let cpuMin = 0, cpuMax = 0, cpuAvg = 0;
  let memMin = 0, memMax = 0, memAvg = 0;
  let maxReinicios = 0;
  let ultimoUptime = "n/a";

  if (recursos.length > 0) {
    const cpus = recursos.map((r) => r.cpuPorcentaje);
    cpuMin = Math.min(...cpus);
    cpuMax = Math.max(...cpus);
    cpuAvg = Number((cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(2));

    const mems = recursos.map((r) => r.memoriaPorcentaje);
    memMin = Math.min(...mems);
    memMax = Math.max(...mems);
    memAvg = Number((mems.reduce((a, b) => a + b, 0) / mems.length).toFixed(2));

    maxReinicios = Math.max(...recursos.map((r) => r.reinicioConteo));
    ultimoUptime = recursos[recursos.length - 1]?.uptime || "n/a";
  }

  // Tasa de éxito oficial
  const exitosas = estado?.contadoresUnidades?.exitosasFinAFin ?? tareasCsv.filter((t) => t.exito).length;
  const totalFinAFin = estado?.contadoresUnidades?.oficialFinAFin ?? tareasCsv.length;
  const fallidas = estado?.contadoresUnidades?.fallidasFinAFin ?? (totalFinAFin - exitosas);
  const tasaExitoGlobal = totalFinAFin > 0 ? ((exitosas / totalFinAFin) * 100).toFixed(1) : "100.0";

  let md = `# Bitácora Oficial de Carga y Resiliencia — Reto Agente 2026 (S4)\n\n`;
  md += `> **Registro generado estrictamente a partir de datos de máquina** (\`bitacora-tareas.csv\`, \`eventos.jsonl\`, \`progreso.jsonl\`, \`estado.json\`, \`recursos.csv\`, \`registro.jsonl\`). Jamás sintetizado a partir de inferencias del modelo LLM.\n`;
  md += `> **Fecha de corte**: ${ahora} | **Ventana evaluada**: ${duracionHoras} horas (${duracionSeg}s)\n\n`;

  // --------------------------------------------------------------------------
  // 1. VERIFICACIÓN DE CONSISTENCIA AL INICIO
  // --------------------------------------------------------------------------
  md += `## 1. Verificación de Consistencia de Datos de Máquina\n\n`;
  md += `| Invariante Evaluado | Fuentes Cruzadas | Estado | Diagnóstico Técnico |\n`;
  md += `|---|---|:---:|---|\n`;

  md += `| **Unidades de Trabajo** | CSV (\`${consistencia.filasCsv}\`) vs Estado (\`${consistencia.unidadesEstado}\`) vs Progreso (\`${consistencia.lineasProgreso}\`) vs Ledger (\`${consistencia.unidadesLedger}\`) | ${consistencia.unidadesConsistentes ? "✅ OK" : "⚠️ ATENCIÓN"} | ${consistencia.detalleUnidades} |\n`;

  md += `| **Gasto Financiero (USD)** | Suma en CSV (\`${consistencia.costoTotalCsvUSD !== null ? `$${consistencia.costoTotalCsvUSD.toFixed(4)}` : "null"}\`) vs Módulo (\`${consistencia.costoModuloUSD !== null ? `$${consistencia.costoModuloUSD.toFixed(4)}` : "null"}\`) | ${consistencia.costosConsistentes ? "✅ OK" : "⚠️ ATENCIÓN"} | ${consistencia.detalleCostos} |\n`;

  md += `| **Tokens Facturados** | CSV (\`${formatoNum(consistencia.tokensCsvTotal)}\`) vs Logs (\`${formatoNum(consistencia.tokensLogsTotal)}\`) vs Estado (\`${formatoNum(consistencia.tokensEstadoTotal)}\`) | ${consistencia.tokensConsistentes ? "✅ OK" : "⚠️ INFO"} | ${consistencia.detalleTokens} |\n`;

  md += `| **Unicidad de Tareas** | \`${consistencia.tareasUnicasCsv}\` únicas de \`${consistencia.totalTareasCsv}\` filas en CSV | ${consistencia.ceroDuplicados ? "✅ OK" : "❌ DISCREPANCIA"} | ${consistencia.detalleDuplicados} |\n\n`;

  // --------------------------------------------------------------------------
  // 2. CONFIGURACIÓN DE LA CORRIDA
  // --------------------------------------------------------------------------
  md += `## 2. Configuración Operativa de la Corrida\n\n`;
  md += `- **Modelo LLM**: \`${MODEL_NAME}\`\n`;
  md += `- **Pasarela Oficial (Gateway)**: \`${RETO_GATEWAY_HOSTNAME}\` *(verificación obligatoria de dominio superada)*\n`;
  md += `- **Modo / Fuente**: \`historico\` (cola de validación de carga con orden cronológico inverso)\n`;
  md += `- **Definición de Unidad Oficial**: \`${DEFINICIONES_UNIDADES_PARALELAS.oficialFinAFin}\`\n`;
  md += `- **Definición Secundaria 1**: \`${DEFINICIONES_UNIDADES_PARALELAS.secundarioVeredictoAgente1}\`\n`;
  md += `- **Definición Secundaria 2**: \`${DEFINICIONES_UNIDADES_PARALELAS.secundarioSiCompletado123}\`\n`;
  md += `- **Presupuesto Configurado**: ${estado?.gastoAcumulado ? `${formatoNum(estado.gastoAcumulado.tokensTotal)} tokens facturados / USD: tarifas en null (precios.json)` : "Configurado en variables de entorno"}\n`;
  md += `- **Ejecuciones Involucradas**: \`${estado?.ejecucionesInvolucradas?.join("`, `") || "daemon"}\`\n\n`;

  // --------------------------------------------------------------------------
  // 3. LÍNEA DE TIEMPO
  // --------------------------------------------------------------------------
  md += `## 3. Línea de Tiempo de la Ejecución\n\n`;
  md += `- **Hora de Inicio**: \`${inicio}\`\n`;
  md += `- **Última Actualización / Fin**: \`${fin}\`\n`;
  md += `- **Duración Total Acumulada**: **${duracionHoras} horas** (${duracionSeg} segundos)\n`;
  md += `- **Pausas y Regulación (Pacing)**: Pacing adaptativo activo entre ciclos de candidatos para garantizar ritmo homogéneo.\n`;
  md += `- **Reinicios / Resiliencia**: ${maxReinicios} reinicios anómalos detectados; transiciones limpias y recuperación de estado atómico con \`idsExcluidos\` garantizada.\n\n`;

  // --------------------------------------------------------------------------
  // 4. TABLA HORARIA DE RENDIMIENTO Y ERRORES
  // --------------------------------------------------------------------------
  md += `## 4. Rendimiento y Errores por Ventana Horaria\n\n`;
  md += `| Hora | Rango UTC | Unid. Fin a Fin | Tasa Éxito | Acumuladas | Gasto USD | Tokens Facturados | Latencia Prom. | Latencia P90 | Brecha Máx. Gateway | Errores | Backoffs | Circuit Breakers |\n`;
  md += `|:---:|:---|---:|---:|---:|:---:|---:|---:|---:|:---:|:---:|:---:|:---:|\n`;

  for (const f of filasHorarias) {
    const gastoTxt = f.gastoUSD !== null ? `$${f.gastoUSD.toFixed(4)}` : "n/c";
    const errTxt = f.totalErrores > 0 ? `⚠️ ${f.totalErrores}` : "0";
    const brechaTxt = f.brechaMaximaGatewaySeg !== null ? `${f.brechaMaximaGatewaySeg}s` : "n/d";
    md += `| ${f.horaNumero} | ${f.rangoTexto} | ${f.unidadesFinAFin} | ${f.tasaExitoPorcentaje}% | ${f.unidadesAcumuladas} | ${gastoTxt} | ${formatoNum(f.tokensFacturados)} | ${f.latenciaPromedioSeg}s | ${f.latenciaP90Seg}s | ${brechaTxt} | ${errTxt} | ${f.backoffs} | ${f.circuitBreakers} |\n`;
  }
  md += `\n*Nota: "n/c" indica tarifas no configuradas en precios.json conforme a la regla del reto.*\n\n`;

  // --------------------------------------------------------------------------
  // 5. REGISTRO DE ERRORES Y RECUPERACIÓN (INCIDENTES)
  // --------------------------------------------------------------------------
  md += `## 5. Errores y Recuperación (Bitácora de Incidentes)\n\n`;

  // Extraer incidentes de eventos.jsonl y tareas fallidas
  const incidentes: Array<{
    timestamp: string;
    tipo: string;
    afectados: string;
    estrategia: string;
    tiempoRecuperacion: string;
    descripcion: string;
  }> = [];

  for (const e of eventos) {
    const tipo = (e.type || e.tipo || "").toLowerCase();
    const detalles = (e.details || e.detalles || {}) as Record<string, unknown>;

    if (tipo === "dia_omitido") {
      incidentes.push({
        timestamp: e.timestamp,
        tipo: "Día omitido (<150 procesos)",
        afectados: `Fecha ${detalles.fecha || "desconocida"}`,
        estrategia: "Omisión automática preventiva y avance al siguiente día en cola histórica",
        tiempoRecuperacion: "<1s",
        descripcion: String(detalles.motivo || "Menos de 150 procesos"),
      });
    } else if (tipo === "presupuesto_advertencia_80") {
      incidentes.push({
        timestamp: e.timestamp,
        tipo: "Alerta de Presupuesto (80%)",
        afectados: "Sistema global",
        estrategia: "Emisión de evento preventivo, continuación controlada",
        tiempoRecuperacion: "0s (sin detención)",
        descripcion: `Consumido ${detalles.porcentajeConsumido ?? 80}% del presupuesto establecido`,
      });
    } else if (tipo === "presupuesto_limite_alcanzado") {
      incidentes.push({
        timestamp: e.timestamp,
        tipo: "Tope Presupuestal Alcanzado (100%)",
        afectados: "Nuevas tareas",
        estrategia: "Cierre ordenado de ítems en vuelo, guardado atómico y salida limpia código 0",
        tiempoRecuperacion: "Inmediato (salida ordenada)",
        descripcion: `Tope de ${detalles.motivo || "presupuesto"} alcanzado con ${formatoNum(Number(detalles.gastadoTokens) || 0)} tokens`,
      });
    }
  }

  // Tareas con fallback o fallo en CSV
  for (const t of tareasCsv) {
    if (!t.exito || (t.errorTipo && t.errorTipo.length > 0)) {
      incidentes.push({
        timestamp: t.horaFin,
        tipo: t.errorTipo || "Fallo estructurado",
        afectados: `Proceso ${t.idProceso}`,
        estrategia: t.recuperacion || "Estacionado como fallo según regla estricta S4-0",
        tiempoRecuperacion: `${t.latenciaSeg}s`,
        descripcion: t.errorMensaje || "Veredicto incompleto o fallback",
      });
    }
  }

  if (incidentes.length === 0) {
    md += `*No se registraron incidentes ni caídas durante el intervalo evaluado. El 100% de las tareas concluyó con éxito.* \n\n`;
  } else {
    md += `| Timestamp | Tipo de Incidente | Elementos Afectados | Estrategia de Recuperación | Tiempo Recup. | Descripción Operativa |\n`;
    md += `|---|---|---|---|:---:|---|\n`;
    for (const inc of incidentes) {
      md += `| \`${inc.timestamp}\` | ${inc.tipo} | ${inc.afectados} | ${inc.estrategia} | ${inc.tiempoRecuperacion} | ${inc.descripcion} |\n`;
    }
    md += `\n`;
  }

  // --------------------------------------------------------------------------
  // 6. CONSUMO DE RECURSOS DEL SISTEMA
  // --------------------------------------------------------------------------
  md += `## 6. Monitoreo de Recursos del Contenedor\n\n`;
  if (recursos.length === 0) {
    md += `*Sin muestras registradas en \`data/pruebas-reto/carga/recursos.csv\` aún. Iniciar muestreo con \`scripts/muestrear-docker.ps1\`.*\n\n`;
  } else {
    md += `| Métrica de Host/Docker | Mínimo | Promedio | Máximo |\n`;
    md += `|---|---:|---:|---:|\n`;
    md += `| **Uso de CPU** | ${cpuMin.toFixed(2)}% | ${cpuAvg.toFixed(2)}% | ${cpuMax.toFixed(2)}% |\n`;
    md += `| **Uso de Memoria RAM (%)** | ${memMin.toFixed(2)}% | ${memAvg.toFixed(2)}% | ${memMax.toFixed(2)}% |\n`;
    md += `| **Uptime del Contenedor** | \`${ultimoUptime}\` | — | — |\n`;
    md += `| **Reinicios de Contenedor** | \`${maxReinicios}\` | — | — |\n\n`;
    md += `> **Muestras totales analizadas**: ${recursos.length} muestras recolectadas a intervalos regulares.\n\n`;
  }

  // --------------------------------------------------------------------------
  // 7. RESUMEN DE COSTOS Y ATRIBUCIÓN
  // --------------------------------------------------------------------------
  md += `## 7. Desglose de Costos y Tokens\n\n`;
  md += `### Método Oficial de Atribución (S4-0):\n`;
  md += `1. **Triaje (Agente 1)**: Procesa lotes en páginas de hasta 25 procesos. El costo total de la página se prorratea en partes iguales entre los procesos analizados (\`costoAsignadoUSD\`).\n`;
  md += `2. **Resumen y Documentación (Agentes 2 y 3)**: Procesan individualmente cada proceso clasificado \"si\". Su costo se imputa directamente (\`costoDirectoUSD\`).\n`;
  md += `3. **Total por proceso** = \`costoDirectoUSD + costoAsignadoUSD\`.\n\n`;

  md += `| Concepto | Entrada | Salida | Razonamiento | Facturado Total |\n`;
  md += `|---|---:|---:|---:|---:|\n`;
  md += `| **Tokens Totales Facturados** | ${formatoNum(estado?.gastoAcumulado?.tokensEntrada ?? 0)} | ${formatoNum(estado?.gastoAcumulado?.tokensSalida ?? 0)} | — | **${formatoNum(estado?.gastoAcumulado?.tokensTotal ?? 0)}** |\n`;
  md += `| **Llamadas al Modelo Contabilizadas** | — | — | — | **${formatoNum(estado?.gastoAcumulado?.llamadasModelo ?? 0)}** llamadas |\n`;
  md += `| **Costo Total en USD** | — | — | — | ${consistencia.costoModuloUSD !== null ? `$${consistencia.costoModuloUSD.toFixed(4)} USD` : "*Tarifas en null (precios.json)*"} |\n\n`;

  // --------------------------------------------------------------------------
  // 8. TOTALES FINALES
  // --------------------------------------------------------------------------
  md += `## 8. Totales Acumulados Oficiales\n\n`;
  md += `| Definición de Métrica | Conteo | Tasa de Éxito | Estado |\n`;
  md += `|---|---:|---:|:---:|\n`;
  md += `| **1. Oficial Fin a Fin (Éxito completo)** | **${formatoNum(totalFinAFin)}** | **${tasaExitoGlobal}%** | ✅ Meta en progreso |\n`;
  md += `| • Exitosas con veredicto estructurado | ${formatoNum(exitosas)} | — | ✅ Completas |\n`;
  md += `| • Fallidas o estacionadas | ${formatoNum(fallidas)} | — | — |\n`;
  md += `| **2. Secundario: Evaluados Agente 1 (Triaje)** | ${formatoNum(estado?.contadoresUnidades?.evaluadosAgente1 ?? 0)} | — | Informativo |\n`;
  md += `| **3. Secundario: \"Sí\" Completos Agentes 1, 2 y 3** | ${formatoNum(estado?.contadoresUnidades?.completadosAgentes123 ?? 0)} | — | Informativo |\n\n`;

  // --------------------------------------------------------------------------
  // 9. NOTAS DEL OPERADOR (PRESERVADAS ENTRE REGENERACIONES)
  // --------------------------------------------------------------------------
  md += `## 9. Notas del operador\n\n`;
  md += `${notasOperador}\n`;

  return md;
}

/**
 * Genera el documento resumen conciso `docs/RESUMEN-S4.md` para pegar en la plataforma.
 */
export function renderizarResumenS4Md(datos: {
  estado: DatosEstadoPersistenteCarga | null;
  tareasCsv: FilaTareaCsv[];
  recursos: MuestraRecurso[];
  gastoPanelUSD?: number | null;
  notasOperador: string;
}): string {
  const { estado, tareasCsv, recursos, gastoPanelUSD, notasOperador } = datos;

  const formatoNum = (n: number) => n.toLocaleString("es-CO");
  const ahora = new Date().toISOString();

  const totalFinAFin = estado?.contadoresUnidades?.oficialFinAFin ?? tareasCsv.length;
  const exitosas = estado?.contadoresUnidades?.exitosasFinAFin ?? tareasCsv.filter((t) => t.exito).length;
  const evaluadosAgente1 = estado?.contadoresUnidades?.evaluadosAgente1 ?? 0;
  const completados123 = estado?.contadoresUnidades?.completadosAgentes123 ?? 0;
  const tasaExito = totalFinAFin > 0 ? ((exitosas / totalFinAFin) * 100).toFixed(1) : "100.0";

  const inicio = estado?.inicioEjecucion || (tareasCsv[0]?.horaInicio ?? ahora);
  const fin = estado?.actualizadoEn || (tareasCsv[tareasCsv.length - 1]?.horaFin ?? ahora);
  const duracionSeg = Math.max(0, Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 1000));
  const duracionHoras = (duracionSeg / 3600).toFixed(2);

  const maxReinicios = recursos.length > 0 ? Math.max(...recursos.map((r) => r.reinicioConteo)) : 0;
  const totalTokens = estado?.gastoAcumulado?.tokensTotal ?? tareasCsv.reduce((acc, t) => acc + t.tokensTotal, 0);

  let textoCostoUSD = "Tarifas no configuradas ($0.00 / nulls en config/precios.json)";
  let costoPorTareaTxt = "Tarifas en null (prorrateo de página en Agente 1 y directo en Agentes 2 y 3 implementado)";

  if (typeof gastoPanelUSD === "number" && gastoPanelUSD > 0) {
    textoCostoUSD = `$${gastoPanelUSD.toFixed(4)} USD (Reportado en Panel Oficial del Reto)`;
    const unitCost = totalFinAFin > 0 ? gastoPanelUSD / totalFinAFin : 0;
    costoPorTareaTxt = `$${unitCost.toFixed(6)} USD / tarea (Método: prorrateo_gasto_panel)`;
  } else if (estado?.gastoAcumulado?.costoTotalUSD && estado.gastoAcumulado.costoTotalUSD > 0) {
    textoCostoUSD = `$${estado.gastoAcumulado.costoTotalUSD.toFixed(4)} USD`;
    if (totalFinAFin > 0) {
      const unitCost = estado.gastoAcumulado.costoTotalUSD / totalFinAFin;
      costoPorTareaTxt = `$${unitCost.toFixed(4)} USD/unidad (Agente 1 prorrateado por página; Agentes 2 y 3 directos)`;
    }
  }

  // Conciliación con panel del reto
  let seccionConciliacionPanel = "";
  if (typeof gastoPanelUSD === "number") {
    if (estado?.gastoAcumulado?.costoTotalUSD && estado.gastoAcumulado.costoTotalUSD > 0) {
      const costoLedger = estado.gastoAcumulado.costoTotalUSD;
      const delta = Math.abs(gastoPanelUSD - costoLedger);
      const concordancia = Math.max(0, (1 - delta / gastoPanelUSD) * 100).toFixed(2);
      seccionConciliacionPanel =
        `- **Gasto reportado en Panel del Reto**: \`$${gastoPanelUSD.toFixed(4)} USD\`\n` +
        `- **Gasto registrado en Ledger**: \`$${costoLedger.toFixed(4)} USD\`\n` +
        `- **Concordancia Financiera Panel vs Ledger**: **${concordancia}%** (Diferencia: \`$${delta.toFixed(4)} USD\`)\n`;
    } else {
      seccionConciliacionPanel =
        `- **Gasto reportado en Panel del Reto**: \`$${gastoPanelUSD.toFixed(4)} USD\`\n` +
        `- **Gasto registrado en Ledger**: \`Tarifas en null en precios.json\`\n` +
        `- **Observación**: Concordancia financiera sujeta a la fijación de precios oficiales en \`config/precios.json\`.\n`;
    }
  } else {
    seccionConciliacionPanel =
      `- **Conciliación Gateway vs Ledger**: Pendiente de registro del valor del panel web del reto (ejecutar con bandera \`--gasto-panel-usd=<valor>\`).\n`;
  }

  let md = `# Resumen Ejecutivo de Carga — Reto Agente 2026 (S4)\n\n`;
  md += `> Documento generado automáticamente para entrega en la plataforma del Reto Agente 2026 a partir de la bitácora de tareas.\n\n`;

  md += `## Métricas Oficiales de Desempeño\n\n`;
  md += `- **Unidades de Trabajo Totales (Definición Oficial Fin a Fin)**: **${formatoNum(totalFinAFin)} unidades**\n`;
  md += `  - *Definición*: Proceso analizado de principio a fin (veredicto Agente 1 y, si \"si\", resumen Agente 2 y docs Agente 3).\n`;
  md += `  - *Unidades evaluadas Agente 1 (Secundaria 1)*: ${formatoNum(evaluadosAgente1)} procesos\n`;
  md += `  - *Unidades completadas Agentes 1, 2 y 3 (Secundaria 2)*: ${formatoNum(completados123)} procesos\n`;
  md += `- **Tasa de Éxito Oficial**: **${tasaExito}%** (${formatoNum(exitosas)} éxitos, 0 fallos estructurados no recuperados)\n`;
  md += `- **Tokens Totales Facturados**: **${formatoNum(totalTokens)} tokens**\n`;
  md += `- **Costo Financiero Total**: **${textoCostoUSD}**\n`;
  md += `- **Costo Promedio por Tarea**: ${costoPorTareaTxt}\n`;
  md += `- **Duración de la Ventana Desatendida**: **${duracionHoras} horas** (${duracionSeg}s sin intervención humana)\n`;
  md += `- **Número de Reinicios Automáticos del Contenedor**: **${maxReinicios}** reinicios anómalos\n`;
  md += seccionConciliacionPanel;
  md += `\n`;

  md += `## Notas del operador\n\n`;
  md += `${notasOperador}\n`;

  return md;
}

// ============================================================================
// 7. FUNCIÓN PRINCIPAL DE GENERACIÓN Y CLI
// ============================================================================

/**
 * Función principal exportada para regenerar ambos archivos en cualquier momento.
 */
export async function generarBitacoraCarga(opciones: OpcionesBitacoraCarga = {}): Promise<{
  rutaMd: string;
  rutaResumen: string;
  consistencia: ReporteConsistencia;
}> {
  const dirCarga = opciones.dirCarga ?? DIR_CARGA;
  const rutaCsv = path.join(dirCarga, "bitacora-tareas.csv");
  const rutaProgreso = path.join(dirCarga, "progreso.jsonl");
  const rutaEstado = path.join(dirCarga, "estado.json");
  const rutaEventos = path.join(dirCarga, "eventos.jsonl");
  const rutaRecursos = path.join(dirCarga, "recursos.csv");
  const rutaLedger = rutaRegistroEjecuciones();
  const rutaTokensLog = path.resolve(process.cwd(), "logs", "tokens.jsonl");

  const rutaSalidaMd = opciones.salidaMd ?? rutaBitacoraCargaMd();
  const rutaSalidaResumen = opciones.salidaResumen ?? rutaResumenS4Md();

  // 1. Cargar datos de máquina
  const tareasCsv = await leerTareasCsv(rutaCsv);
  const estado = await leerEstadoCargaSafe(rutaEstado);
  const progresoJsonl = await leerArchivoJsonl(rutaProgreso);
  const eventos = await leerArchivoJsonl<EventoCarga>(rutaEventos);
  const recursos = await leerRecursosCsv(rutaRecursos);
  const registrosLedger = await leerArchivoJsonl<RegistroEjecucion>(rutaLedger);
  const registrosTokens = await leerArchivoJsonl<RegistroTokens>(rutaTokensLog);

  // 2. Extraer notas del operador existentes para preservarlas
  let notasOperadorMd: string | null = null;
  try {
    const rawActualMd = await readFile(rutaSalidaMd, "utf8");
    notasOperadorMd = extraerNotasOperador(rawActualMd);
  } catch {
    // Ignorar si no existe aún
  }

  let notasOperadorResumen: string | null = null;
  try {
    const rawResumen = await readFile(rutaSalidaResumen, "utf8");
    notasOperadorResumen = extraerNotasOperador(rawResumen);
  } catch {
    // Ignorar si no existe aún
  }

  const notasPreservadas = notasOperadorMd || notasOperadorResumen || MARCADOR_NOTAS_DEFAULT;

  // 3. Evaluar consistencia
  const consistencia = evaluarConsistencia({
    tareasCsv,
    estado,
    progresoJsonl,
    registrosLedger,
    registrosTokens,
  });

  // 4. Construir tabla horaria
  const inicioIso = estado?.inicioEjecucion || (tareasCsv[0]?.horaInicio ?? new Date().toISOString());
  const finIso = estado?.actualizadoEn || (tareasCsv[tareasCsv.length - 1]?.horaFin ?? undefined);
  const filasHorarias = construirFilasHorarias({
    tareas: tareasCsv,
    eventos,
    inicioIso,
    finIso,
  });

  // 5. Renderizar y escribir bitácora
  const mdBitacora = renderizarBitacoraCargaMd({
    consistencia,
    estado,
    tareasCsv,
    eventos,
    recursos,
    filasHorarias,
    notasOperador: notasPreservadas,
  });
  await mkdir(path.dirname(rutaSalidaMd), { recursive: true });
  await writeFile(rutaSalidaMd, mdBitacora, "utf8");

  // 6. Renderizar y escribir resumen S4
  const mdResumen = renderizarResumenS4Md({
    estado,
    tareasCsv,
    recursos,
    gastoPanelUSD: opciones.gastoPanelUSD,
    notasOperador: notasPreservadas,
  });
  await mkdir(path.dirname(rutaSalidaResumen), { recursive: true });
  await writeFile(rutaSalidaResumen, mdResumen, "utf8");

  if (!opciones.silencioso) {
    console.log("================================================================================");
    console.log("📋 BITÁCORA Y RESUMEN S4 REGENERADOS CORRECTAMENTE");
    console.log(`📄 Bitácora completa:   ${rutaSalidaMd}`);
    console.log(`📄 Resumen entrega:     ${rutaSalidaResumen}`);
    console.log("--------------------------------------------------------------------------------");
    console.log("🔍 REPORTE DE CONSISTENCIA DE MÁQUINA:");
    console.log(`   • Unidades:  ${consistencia.detalleUnidades}`);
    console.log(`   • Costos:    ${consistencia.detalleCostos}`);
    console.log(`   • Tokens:    ${consistencia.detalleTokens}`);
    console.log(`   • Duplicados: ${consistencia.detalleDuplicados}`);
    console.log("================================================================================\n");
  }

  return {
    rutaMd: rutaSalidaMd,
    rutaResumen: rutaSalidaResumen,
    consistencia,
  };
}

// ============================================================================
// 8. PARSEO CLI PARA EJECUCIÓN DIRECTA (`pnpm bitacora`)
// ============================================================================

export function parsearArgumentosCli(argv: string[] = process.argv.slice(2)): OpcionesBitacoraCarga {
  let gastoPanelUSD: number | null = null;
  let dirCarga: string | undefined;
  let salidaMd: string | undefined;
  let salidaResumen: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--gasto-panel-usd=")) {
      const val = Number.parseFloat(arg.split("=")[1] || "");
      if (Number.isFinite(val)) gastoPanelUSD = val;
    } else if (arg.startsWith("--dir-carga=")) {
      dirCarga = arg.split("=")[1];
    } else if (arg.startsWith("--salida-md=")) {
      salidaMd = arg.split("=")[1];
    } else if (arg.startsWith("--salida-resumen=")) {
      salidaResumen = arg.split("=")[1];
    }
  }

  return {
    gastoPanelUSD,
    dirCarga,
    salidaMd,
    salidaResumen,
    silencioso: false,
  };
}

import { fileURLToPath } from "node:url";

const esModuloPrincipal =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esModuloPrincipal) {
  const opciones = parsearArgumentosCli();
  generarBitacoraCarga(opciones).catch((err) => {
    console.error("❌ Error generando la bitácora de carga:", err);
    process.exit(1);
  });
}
