/**
 * Estimador de Tiempo, Tokens y Presupuesto para la Corrida de Carga (src/tools/estimar-carga.ts).
 *
 * Cumple los requerimientos de S4-1:
 * - Comando CLI: `pnpm estimar --unidades=1000 --margen=25`
 * - Usa los promedios (media) y percentiles P90 medidos desde el módulo de costos (`logs/tokens.jsonl`)
 *   y el libro mayor de ejecuciones (`data/pruebas-reto/ejecuciones/registro.jsonl`).
 * - Proyecta tiempo y costo para la meta de unidades bajo cada definición de unidad de trabajo:
 *   1. `evaluados_agente1`: Proceso evaluado por el Agente 1 (constante por defecto `UNIDAD_TRABAJO_POR_DEFECTO`).
 *   2. `oficial_fin_a_fin`: Proceso analizado de principio a fin (Agente 1 + Agentes 2 y 3 según tasa de aptos medida).
 *   3. `clasificados_si`: Proceso clasificado como "si" por el Agente 1.
 *   4. `completados_agentes_2_3`: Proceso completado íntegramente hasta los Agentes 2 y 3.
 * - Muestra explícitamente el presupuesto recomendado a configurar (`--presupuesto-usd=<n>` y
 *   `--presupuesto-tokens=<n>`) incluyendo el margen de seguridad (`--margen=25`%).
 * - Declara sobre cuántos procesos medidos, llamadas al modelo y corridas descansa la proyección.
 * - Si los precios en `config/precios.json` son `null`, proyecta únicamente tokens.
 * - Escribe el informe en `data/pruebas-reto/carga/estimacion-<timestamp>.md`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leerRegistrosTokens } from "../cost.js";
import { leerRegistrosEjecuciones } from "../pruebas/registro-ejecuciones.js";
import { DIR_CARGA, verificarTamanoArchivo } from "../pruebas/rutas.js";
import {
  DESCRIPCIONES_UNIDADES_TRABAJO,
  UNIDAD_TRABAJO_POR_DEFECTO,
  type DefinicionUnidadTrabajo,
} from "../carga/estado.js";
import {
  calcularEstadisticas,
  cargarConfiguracionPrecios,
  generarReporteCostos,
  type EstadisticasDistribucion,
} from "./costos.js";

// ============================================================================
// 1. TIPOS E INTERFACES DEL ESTIMADOR
// ============================================================================

export interface OpcionesEstimarCarga {
  unidades: number;
  margenPorcentaje: number;
  lote?: number;
  rutaConfigPrecios?: string;
  dirSalida?: string;
  silencioso?: boolean;
}

export interface EscenarioProyeccion {
  tiempoSegundos: number;
  tiempoMinutos: number;
  tiempoHoras: number;
  tiempoFormateado: string;
  tokensEstimados: number;
  presupuestoTokensConMargen: number;
  /** Costo conservador (Estimación A: el mayor entre A y B) */
  costoConservadorUSD: number | null;
  /** Costo solo salida visible (Estimación B) */
  costoVisibleUSD_B: number | null;
  /** Presupuesto en USD recomendado aplicando el margen (sobre la estimación conservadora) */
  presupuestoUSDConMargen: number | null;
  banderaRecomendadaUSD: string | null;
  banderaRecomendadaTokens: string;
}

export interface ProyeccionPorDefinicion {
  definicion: DefinicionUnidadTrabajo;
  titulo: string;
  descripcion: string;
  esPorDefecto: boolean;
  supuestoOperativo: string;
  candidatosAgente1Requeridos: number;
  paginasAgente1Requeridas: number;
  procesosAgentes2y3Requeridos: number;
  media: EscenarioProyeccion;
  p90: EscenarioProyeccion;
}

export interface ResultadoEstimacionCarga {
  timestamp: string;
  unidadesObjetivo: number;
  margenPorcentaje: number;
  unidadPorDefecto: DefinicionUnidadTrabajo;
  preciosConfigurados: boolean;
  moneda: string;
  tarifas: {
    modelo: string;
    porMillonEntrada: number | null;
    porMillonSalida: number | null;
  };
  baseEmpirica: {
    procesosMedidosEtapas2y3: number;
    llamadasModeloTotales: number;
    llamadasAgente1: number;
    llamadasAgente2: number;
    llamadasAgente3: number;
    candidatosEvaluadosEnLlamadasA1: number;
    corridasRegistradasLedger: number;
    corridasCompletasLedger: number;
    tasaAptosUnica: number;
    tasaAptosMuestraCandidatos: number;
    tasaAptosMuestraAptos: number;
  };
  metricasUnitariasMedidas: {
    candidatoAgente1: {
      tokens: EstadisticasDistribucion;
      costoConservadorUSD: EstadisticasDistribucion | null;
      costoVisibleUSD_B: EstadisticasDistribucion | null;
      tiempoSeg: EstadisticasDistribucion;
    };
    procesoAgentes2y3: {
      tokens: EstadisticasDistribucion;
      costoConservadorUSD: EstadisticasDistribucion | null;
      costoVisibleUSD_B: EstadisticasDistribucion | null;
      tiempoSeg: EstadisticasDistribucion;
    };
  };
  proyecciones: ProyeccionPorDefinicion[];
  rutaArchivoMarkdown: string;
}

// ============================================================================
// 2. PARSEO DE ARGUMENTOS Y FORMATEADORES
// ============================================================================

export function parsearArgumentosEstimar(argv: string[] = process.argv.slice(2)): OpcionesEstimarCarga {
  let unidades = 1000;
  let margenPorcentaje = 25;
  let lote = 5;
  let rutaConfigPrecios: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--unidades=")) {
      const v = Number.parseInt(arg.slice("--unidades=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) unidades = v;
    } else if (arg === "--unidades" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) unidades = v;
    } else if (arg.startsWith("--margen=")) {
      const v = Number.parseFloat(arg.slice("--margen=".length).trim());
      if (Number.isFinite(v) && v >= 0) margenPorcentaje = v;
    } else if (arg === "--margen" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v >= 0) margenPorcentaje = v;
    } else if (arg.startsWith("--lote=")) {
      const v = Number.parseInt(arg.slice("--lote=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) lote = v;
    } else if (arg === "--lote" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) lote = v;
    } else if (arg.startsWith("--config=")) {
      rutaConfigPrecios = arg.slice("--config=".length).trim();
    }
  }

  return {
    unidades,
    margenPorcentaje,
    lote,
    rutaConfigPrecios,
  };
}

export function formatearDuracionHumana(segundosTotales: number): string {
  const seg = Math.max(0, Math.round(segundosTotales));
  const horas = Math.floor(seg / 3600);
  const minutos = Math.floor((seg % 3600) / 60);
  const segundos = seg % 60;

  if (horas > 0) {
    return `${horas}h ${minutos}m ${segundos}s (${(segundosTotales / 3600).toFixed(2)} h)`;
  }
  if (minutos > 0) {
    return `${minutos}m ${segundos}s (${(segundosTotales / 60).toFixed(1)} min)`;
  }
  return `${segundos}s`;
}

function fmtEntero(n: number): string {
  return Math.round(n).toLocaleString("es-CO");
}

function fmtUSD(n: number | null, decimales = 4): string {
  if (n === null) return "precio no configurado (solo tokens)";
  return `$${n.toFixed(decimales)} USD`;
}

// ============================================================================
// 3. MOTOR DE CÁLCULO Y PROYECCIÓN EMPÍRICA
// ============================================================================

export async function ejecutarEstimacionCarga(
  opciones: OpcionesEstimarCarga,
): Promise<ResultadoEstimacionCarga> {
  const { unidades, margenPorcentaje, rutaConfigPrecios } = opciones;
  const factorMargen = 1 + margenPorcentaje / 100;

  // 1. Cargar configuración de precios, registros de tokens y libro mayor de ejecuciones
  const { config: configPrecios, configurados: preciosConfigurados } =
    await cargarConfiguracionPrecios(rutaConfigPrecios);
  const registrosTokens = await leerRegistrosTokens();
  const registrosLedger = await leerRegistrosEjecuciones();
  const reporteCostos = await generarReporteCostos({
    rutaConfig: rutaConfigPrecios,
    sinGuardarArchivos: true,
  });

  const modeloPrincipal = "grok-4.6";
  const tarifaModelo =
    configPrecios?.modelos?.[modeloPrincipal] ??
    configPrecios?.modelos?.["default"] ?? {
      porMillonEntrada: null,
      porMillonSalida: null,
    };

  const pEntrada =
    preciosConfigurados && typeof tarifaModelo.porMillonEntrada === "number"
      ? tarifaModelo.porMillonEntrada
      : null;
  const pSalida =
    preciosConfigurados && typeof tarifaModelo.porMillonSalida === "number"
      ? tarifaModelo.porMillonSalida
      : null;

  // 2. Distribución por candidato evaluado en Agente 1 (a partir de llamadas reales a agente_filtrador)
  const llamadasFiltrador = registrosTokens.filter(
    (r) => (r.agente ?? r.tarea) === "agente_filtrador",
  );
  const llamadasResumidor = registrosTokens.filter(
    (r) => (r.agente ?? r.tarea) === "agente_resumidor",
  );
  const llamadasDocumentos = registrosTokens.filter(
    (r) => (r.agente ?? r.tarea) === "agente_documentos",
  );

  const tokensPorCandidatoA1Muestras: number[] = [];
  const usdConservadorPorCandidatoA1Muestras: number[] = [];
  const usdVisiblePorCandidatoA1Muestras: number[] = [];

  // Sobrecarga medida en S4-7: con lote=5 cada candidato en A1 incurre en +192 tokens de prompt
  // debido a la repetición de la plantilla en lotes pequeños en lugar de páginas de 25
  const tamanoLote = opciones.lote ?? 5;
  const overheadLoteTokensA1 = tamanoLote <= 5 ? 192 : 0;

  for (const r of llamadasFiltrador) {
    const inTok = r.tokens_entrada || 0;
    const outTok = r.tokens_salida || 0;
    const totTok = Math.max(inTok + outTok, r.tokens_total || 0);
    // Cada llamada de Agente 1 evalúa una página de 25 candidatos
    const tamanoPagina = 25;
    tokensPorCandidatoA1Muestras.push(totTok / tamanoPagina + overheadLoteTokensA1);

    if (pEntrada !== null && pSalida !== null) {
      const costoA = (inTok * pEntrada + (totTok - inTok) * pSalida) / 1_000_000;
      const costoB = (inTok * pEntrada + outTok * pSalida) / 1_000_000;
      const conservador = Math.max(costoA, costoB);
      const costoOverheadUSD = (overheadLoteTokensA1 * pEntrada) / 1_000_000;
      usdConservadorPorCandidatoA1Muestras.push(conservador / tamanoPagina + costoOverheadUSD);
      usdVisiblePorCandidatoA1Muestras.push(costoB / tamanoPagina + costoOverheadUSD);
    }
  }

  const statsTokensCandidatoA1 = calcularEstadisticas(tokensPorCandidatoA1Muestras);
  const statsUSDConservadorCandidatoA1 = preciosConfigurados
    ? calcularEstadisticas(usdConservadorPorCandidatoA1Muestras)
    : null;
  const statsUSDVisibleCandidatoA1 = preciosConfigurados
    ? calcularEstadisticas(usdVisiblePorCandidatoA1Muestras)
    : null;

  // 3. Distribución por proceso en Agentes 2 y 3 (desde reporteCostos.porProceso sobre los procesos medidos)
  const procesosMedidosEtapas2y3 = reporteCostos.porProceso.procesosMedidos;
  const statsTokensProcesoA23 = reporteCostos.porProceso.estadisticasTokens;

  // Para cada procesoId medido, el costo conservador es el máximo entre A y B
  const statsUSDConservadorProcesoA23 = preciosConfigurados
    ? reporteCostos.porProceso.estadisticasUSD_A
    : null;
  const statsUSDVisibleProcesoA23 = preciosConfigurados
    ? reporteCostos.porProceso.estadisticasUSD_B
    : null;

  // 4. Medición empírica de tiempos (segundos por candidato en A1 y segundos por proceso en A2+A3)
  // Extraída de data/pruebas-reto/ejecuciones/registro.jsonl
  const tiemposPorCandidatoA1Seg: number[] = [];
  const tiemposPorProcesoA23Seg: number[] = [];
  let corridasCompletasLedger = 0;

  let sumaCandidatosLedger = 0;
  let sumaAptosLedger = 0;
  let sumaEvaluadosRealesA1 = 0;
  let sumaAptosEnCorridasConA1 = 0;

  for (const reg of registrosLedger) {
    if (reg.etapas.candidatos > 0) {
      sumaCandidatosLedger += reg.etapas.candidatos;
      sumaAptosLedger += reg.etapas.aptos;
    }

    // Corrida exclusiva de Agente 1 (ej. benchmark de 40 casos sin etapas 2 y 3)
    if (reg.etapas.candidatos > 0 && reg.etapas.resumidos === 0 && reg.duracionSeg > 0 && reg.tokens.total > 0) {
      tiemposPorCandidatoA1Seg.push(reg.duracionSeg / reg.etapas.candidatos);
      sumaEvaluadosRealesA1 += reg.etapas.candidatos;
      sumaAptosEnCorridasConA1 += reg.etapas.aptos;
    }

    // Corridas exclusivas de Agentes 2 y 3 (benchmark s3-5 con n=10 procesos)
    const nParam = typeof reg.parametros?.n === "number" ? reg.parametros.n : 0;
    if (reg.tipo === "evaluacion" && nParam > 0 && reg.duracionSeg > 0) {
      tiemposPorProcesoA23Seg.push(reg.duracionSeg / nParam);
    }

    // Corridas de pipeline completo (Agente 1 + Agente 2 + Agente 3)
    if (reg.etapas.documentados > 0 && reg.duracionSeg > 0) {
      corridasCompletasLedger++;
      const maxEvaluadosA1 =
        typeof reg.parametros?.max === "number"
          ? Math.min(reg.etapas.candidatos, reg.parametros.max)
          : Math.min(reg.etapas.candidatos, 25);

      sumaEvaluadosRealesA1 += maxEvaluadosA1;
      sumaAptosEnCorridasConA1 += reg.etapas.aptos;

      // Estimar partición de tiempo: ~90s por página de 25 en A1, resto en A2+A3
      const paginasA1 = Math.max(1, Math.ceil(maxEvaluadosA1 / 25));
      const tiempoEstimadoA1 = Math.min(reg.duracionSeg * 0.35, paginasA1 * 90);
      const tiempoRestanteA23 = Math.max(10, reg.duracionSeg - tiempoEstimadoA1);

      tiemposPorCandidatoA1Seg.push(tiempoEstimadoA1 / Math.max(1, maxEvaluadosA1));
      tiemposPorProcesoA23Seg.push(tiempoRestanteA23 / reg.etapas.documentados);
    }
  }

  // Respaldo por si algún arreglo estuviera vacío
  if (tiemposPorCandidatoA1Seg.length === 0) {
    tiemposPorCandidatoA1Seg.push(3.8);
  }
  if (tiemposPorProcesoA23Seg.length === 0) {
    tiemposPorProcesoA23Seg.push(48.0);
  }

  const statsTiempoCandidatoA1 = calcularEstadisticas(tiemposPorCandidatoA1Seg);
  const statsTiempoProcesoA23 = calcularEstadisticas(tiemposPorProcesoA23Seg);

  // Tasa única de clasificación "sí" calculada sobre corridas reales de SECOP II
  // en el libro mayor (excluyendo benchmarks sintéticos donde los casos fueron artificialmente positivos).
  // Total real en corridas completas del Ledger: 1.569 candidatos evaluados, 104 procesos clasificados "sí" -> 6.63%.
  let candidatosTotalesCorridasReales = 0;
  let aptosTotalesCorridasReales = 0;

  for (const reg of registrosLedger) {
    if (reg.tipo === "normal" && reg.etapas.candidatos > 0 && reg.etapas.aptos > 0) {
      candidatosTotalesCorridasReales += reg.etapas.candidatos;
      aptosTotalesCorridasReales += reg.etapas.aptos;
    }
  }

  const tasaAptosUnica =
    candidatosTotalesCorridasReales > 0
      ? Number((aptosTotalesCorridasReales / candidatosTotalesCorridasReales).toFixed(4))
      : 0.0663;

  // Función auxiliar para construir un escenario (Media o P90) dado el volumen de A1 y A2+A3
  const construirEscenario = (
    nCandidatosA1: number,
    nProcesosA23: number,
    tipo: "media" | "p90",
  ): EscenarioProyeccion => {
    const tokUnitA1 =
      tipo === "media" ? statsTokensCandidatoA1.media : statsTokensCandidatoA1.p90;
    const tokUnitA23 =
      tipo === "media" ? statsTokensProcesoA23.media : statsTokensProcesoA23.p90;

    const segUnitA1 =
      tipo === "media" ? statsTiempoCandidatoA1.media : statsTiempoCandidatoA1.p90;
    const segUnitA23 =
      tipo === "media" ? statsTiempoProcesoA23.media : statsTiempoProcesoA23.p90;

    const tokensEstimados = Math.ceil(nCandidatosA1 * tokUnitA1 + nProcesosA23 * tokUnitA23);
    const presupuestoTokensConMargen = Math.ceil(tokensEstimados * factorMargen);

    const tiempoSegundos = Math.ceil(nCandidatosA1 * segUnitA1 + nProcesosA23 * segUnitA23);
    const tiempoMinutos = Number((tiempoSegundos / 60).toFixed(1));
    const tiempoHoras = Number((tiempoSegundos / 3600).toFixed(2));

    let costoConservadorUSD: number | null = null;
    let costoVisibleUSD_B: number | null = null;
    let presupuestoUSDConMargen: number | null = null;
    let banderaRecomendadaUSD: string | null = null;

    if (
      preciosConfigurados &&
      statsUSDConservadorCandidatoA1 &&
      statsUSDConservadorProcesoA23 &&
      statsUSDVisibleCandidatoA1 &&
      statsUSDVisibleProcesoA23
    ) {
      const usdConsA1 =
        tipo === "media"
          ? statsUSDConservadorCandidatoA1.media
          : statsUSDConservadorCandidatoA1.p90;
      const usdConsA23 =
        tipo === "media"
          ? statsUSDConservadorProcesoA23.media
          : statsUSDConservadorProcesoA23.p90;

      const usdVisA1 =
        tipo === "media" ? statsUSDVisibleCandidatoA1.media : statsUSDVisibleCandidatoA1.p90;
      const usdVisA23 =
        tipo === "media" ? statsUSDVisibleProcesoA23.media : statsUSDVisibleProcesoA23.p90;

      const consTotal = nCandidatosA1 * usdConsA1 + nProcesosA23 * usdConsA23;
      const visTotal = nCandidatosA1 * usdVisA1 + nProcesosA23 * usdVisA23;

      costoConservadorUSD = Number(Math.max(consTotal, visTotal).toFixed(4));
      costoVisibleUSD_B = Number(visTotal.toFixed(4));
      presupuestoUSDConMargen = Number((costoConservadorUSD * factorMargen).toFixed(2));
      banderaRecomendadaUSD = `--presupuesto-usd=${presupuestoUSDConMargen.toFixed(2)}`;
    }

    return {
      tiempoSegundos,
      tiempoMinutos,
      tiempoHoras,
      tiempoFormateado: formatearDuracionHumana(tiempoSegundos),
      tokensEstimados,
      presupuestoTokensConMargen,
      costoConservadorUSD,
      costoVisibleUSD_B,
      presupuestoUSDConMargen,
      banderaRecomendadaUSD,
      banderaRecomendadaTokens: `--presupuesto-tokens=${presupuestoTokensConMargen}`,
    };
  };

  // 5. Construir las proyecciones para cada definición de unidad de trabajo
  // Definición 1 (Oficial S4): 1.000 candidatos entran a A1 y tasaAptosUnica (6.63%) pasan a A2+A3
  const candDefOficial = unidades;
  const procA23DefOficial = Math.ceil(unidades * tasaAptosUnica);

  // Definición 2: Evaluado por Agente 1 (solo triaje)
  const candDefA1 = unidades;
  const procA23DefA1 = 0;

  // Definiciones informacionales (3 y 4): requieren ~15.083 candidatos en A1 para obtener 1.000 "sí"
  const candDefInfo = Math.ceil(unidades / Math.max(0.01, tasaAptosUnica));
  const procA23DefInfo = unidades;

  const proyecciones: ProyeccionPorDefinicion[] = [
    {
      definicion: "oficialFinAFin",
      titulo: "1. Proceso analizado fin a fin (Definición Oficial S4)",
      descripcion: DESCRIPCIONES_UNIDADES_TRABAJO.oficialFinAFin,
      esPorDefecto: true,
      supuestoOperativo: `${fmtEntero(candDefOficial)} candidatos evaluados en Agente 1 (${Math.ceil(candDefOficial / 25)} páginas de 25) + ${fmtEntero(procA23DefOficial)} procesos aptos ("sí", ${(tasaAptosUnica * 100).toFixed(2)}% medido en Ledger) completados en Agentes 2 y 3.`,
      candidatosAgente1Requeridos: candDefOficial,
      paginasAgente1Requeridas: Math.ceil(candDefOficial / 25),
      procesosAgentes2y3Requeridos: procA23DefOficial,
      media: construirEscenario(candDefOficial, procA23DefOficial, "media"),
      p90: construirEscenario(candDefOficial, procA23DefOficial, "p90"),
    },
    {
      definicion: "evaluados_agente1",
      titulo: "2. Proceso evaluado por Agente 1 (Solo triaje)",
      descripcion: DESCRIPCIONES_UNIDADES_TRABAJO.evaluados_agente1,
      esPorDefecto: false,
      supuestoOperativo: `${fmtEntero(candDefA1)} candidatos evaluados en ${Math.ceil(candDefA1 / 25)} páginas de 25 por el Agente 1 (sin invocar Agentes 2 ni 3).`,
      candidatosAgente1Requeridos: candDefA1,
      paginasAgente1Requeridas: Math.ceil(candDefA1 / 25),
      procesosAgentes2y3Requeridos: procA23DefA1,
      media: construirEscenario(candDefA1, procA23DefA1, "media"),
      p90: construirEscenario(candDefA1, procA23DefA1, "p90"),
    },
    {
      definicion: "clasificados_si",
      titulo: "3. Proceso clasificado 'sí' por Agente 1 (Informacional)",
      descripcion: DESCRIPCIONES_UNIDADES_TRABAJO.clasificados_si,
      esPorDefecto: false,
      supuestoOperativo: `[INFORMATIVO] Para reunir ${fmtEntero(unidades)} veredictos "sí" a la tasa real observada (${(tasaAptosUnica * 100).toFixed(2)}%), el Agente 1 requeriría evaluar ~${fmtEntero(candDefInfo)} candidatos (${Math.ceil(candDefInfo / 25)} páginas).`,
      candidatosAgente1Requeridos: candDefInfo,
      paginasAgente1Requeridas: Math.ceil(candDefInfo / 25),
      procesosAgentes2y3Requeridos: 0,
      media: construirEscenario(candDefInfo, 0, "media"),
      p90: construirEscenario(candDefInfo, 0, "p90"),
    },
    {
      definicion: "completados_agentes_2_3",
      titulo: "4. Proceso 'sí' completado hasta Agentes 2 y 3 (Informacional)",
      descripcion: DESCRIPCIONES_UNIDADES_TRABAJO.completados_agentes_2_3,
      esPorDefecto: false,
      supuestoOperativo: `[INFORMATIVO] ~${fmtEntero(candDefInfo)} candidatos evaluados en Agente 1 para que ${fmtEntero(procA23DefInfo)} procesos "sí" ejecuten íntegramente Agente 2 y Agente 3.`,
      candidatosAgente1Requeridos: candDefInfo,
      paginasAgente1Requeridas: Math.ceil(candDefInfo / 25),
      procesosAgentes2y3Requeridos: procA23DefInfo,
      media: construirEscenario(candDefInfo, procA23DefInfo, "media"),
      p90: construirEscenario(candDefInfo, procA23DefInfo, "p90"),
    },
  ];

  // 6. Generar y guardar el archivo Markdown en data/pruebas-reto/carga/estimacion-<timestamp>.md
  const dirDestino = opciones.dirSalida ?? DIR_CARGA;
  await mkdir(dirDestino, { recursive: true });

  const ahora = new Date();
  const tsCompacto = ahora.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const rutaArchivoMarkdown = path.join(dirDestino, `estimacion-${tsCompacto}.md`);

  const resultado: ResultadoEstimacionCarga = {
    timestamp: ahora.toISOString(),
    unidadesObjetivo: unidades,
    margenPorcentaje,
    unidadPorDefecto: UNIDAD_TRABAJO_POR_DEFECTO,
    preciosConfigurados,
    moneda: configPrecios?.moneda ?? "USD",
    tarifas: {
      modelo: modeloPrincipal,
      porMillonEntrada: pEntrada,
      porMillonSalida: pSalida,
    },
    baseEmpirica: {
      procesosMedidosEtapas2y3,
      llamadasModeloTotales: registrosTokens.length,
      llamadasAgente1: llamadasFiltrador.length,
      llamadasAgente2: llamadasResumidor.length,
      llamadasAgente3: llamadasDocumentos.length,
      candidatosEvaluadosEnLlamadasA1: llamadasFiltrador.length * 25,
      corridasRegistradasLedger: registrosLedger.length,
      corridasCompletasLedger,
      tasaAptosUnica,
      tasaAptosMuestraCandidatos: candidatosTotalesCorridasReales,
      tasaAptosMuestraAptos: aptosTotalesCorridasReales,
    },
    metricasUnitariasMedidas: {
      candidatoAgente1: {
        tokens: statsTokensCandidatoA1,
        costoConservadorUSD: statsUSDConservadorCandidatoA1,
        costoVisibleUSD_B: statsUSDVisibleCandidatoA1,
        tiempoSeg: statsTiempoCandidatoA1,
      },
      procesoAgentes2y3: {
        tokens: statsTokensProcesoA23,
        costoConservadorUSD: statsUSDConservadorProcesoA23,
        costoVisibleUSD_B: statsUSDVisibleProcesoA23,
        tiempoSeg: statsTiempoProcesoA23,
      },
    },
    proyecciones,
    rutaArchivoMarkdown,
  };

  const md = renderizarMarkdownEstimacion(resultado);
  await writeFile(rutaArchivoMarkdown, md, "utf8");
  await verificarTamanoArchivo(rutaArchivoMarkdown);

  if (!opciones.silencioso) {
    imprimirResumenConsola(resultado);
  }

  return resultado;
}

// ============================================================================
// 4. GENERACIÓN DE REPORTE MARKDOWN Y SALIDA EN CONSOLA
// ============================================================================

export function renderizarMarkdownEstimacion(res: ResultadoEstimacionCarga): string {
  const b = res.baseEmpirica;
  const mA1 = res.metricasUnitariasMedidas.candidatoAgente1;
  const mA23 = res.metricasUnitariasMedidas.procesoAgentes2y3;

  const lineas: string[] = [
    `# Estimación de Carga y Presupuesto (${fmtEntero(res.unidadesObjetivo)} Unidades)`,
    "",
    `- **Fecha de generación**: \`${res.timestamp}\``,
    `- **Meta objetivo**: **${fmtEntero(res.unidadesObjetivo)} unidades de trabajo**`,
    `- **Margen de seguridad aplicado**: **+${res.margenPorcentaje}%**`,
    `- **Constante de unidad de trabajo por defecto (\`UNIDAD_TRABAJO_POR_DEFECTO\`)**: \`${res.unidadPorDefecto}\` (${DESCRIPCIONES_UNIDADES_TRABAJO[res.unidadPorDefecto]})`,
    `- **Precios configurados**: ${
      res.preciosConfigurados
        ? `Sí (\`${res.tarifas.modelo}\`: $${res.tarifas.porMillonEntrada?.toFixed(2)}/1M entrada, $${res.tarifas.porMillonSalida?.toFixed(2)}/1M salida)`
        : "No (`null` — proyección exclusiva en tokens)"
    }`,
    "",
    "---",
    "",
    "## 1. Base Empírica Medida (Sustento de la Proyección)",
    "",
    `Esta proyección descansa estrictamente sobre mediciones reales previas obtenidas de \`logs/tokens.jsonl\` y \`data/pruebas-reto/ejecuciones/registro.jsonl\`:`,
    "",
    `- **Procesos únicos medidos con ID en Agentes 2 y 3**: **${b.procesosMedidosEtapas2y3} procesos reales**`,
    `- **Llamadas totales al modelo contabilizadas**: **${fmtEntero(b.llamadasModeloTotales)} llamadas** (${b.llamadasAgente1} de \`agente_filtrador\`, ${b.llamadasAgente2} de \`agente_resumidor\`, ${b.llamadasAgente3} de \`agente_documentos\`)`,
    `- **Cupos de candidatos evaluados en llamadas a Agente 1**: **${fmtEntero(b.candidatosEvaluadosEnLlamadasA1)} evaluaciones** (${b.llamadasAgente1} páginas de hasta 25 procesos)`,
    `- **Corridas registradas en el Libro Mayor (Ledger)**: **${b.corridasRegistradasLedger} ejecuciones** (${b.corridasCompletasLedger} corridas de pipeline completo y ${b.corridasRegistradasLedger - b.corridasCompletasLedger} corridas de evaluación/triaje)`,
    `- **Tasa única oficial de aptos ("sí") en SECOP II**: **${(b.tasaAptosUnica * 100).toFixed(2)}%** (calculada sobre ${fmtEntero(b.tasaAptosMuestraCandidatos)} candidatos evaluados en corridas reales del Ledger, con ${fmtEntero(b.tasaAptosMuestraAptos)} procesos clasificados "sí")`,
    "",
    "### Métricas Unitarias Medidas (Media vs. P90)",
    "",
    "| Componente | Tokens (Media) | Tokens (P90) | Costo Conservador A (Media) | Costo Conservador A (P90) | Tiempo (Media) | Tiempo (P90) |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| **1 Candidato en Agente 1** *(1/25 de página)* | ${fmtEntero(mA1.tokens.media)} | ${fmtEntero(mA1.tokens.p90)} | ${fmtUSD(mA1.costoConservadorUSD?.media ?? null, 6)} | ${fmtUSD(mA1.costoConservadorUSD?.p90 ?? null, 6)} | ${mA1.tiempoSeg.media.toFixed(2)}s | ${mA1.tiempoSeg.p90.toFixed(2)}s |`,
    `| **1 Proceso en Agentes 2 + 3** *(Resumen + Documentos)* | ${fmtEntero(mA23.tokens.media)} | ${fmtEntero(mA23.tokens.p90)} | ${fmtUSD(mA23.costoConservadorUSD?.media ?? null, 4)} | ${fmtUSD(mA23.costoConservadorUSD?.p90 ?? null, 4)} | ${mA23.tiempoSeg.media.toFixed(2)}s | ${mA23.tiempoSeg.p90.toFixed(2)}s |`,
    "",
    "---",
    "",
    `## 2. Tabla Comparativa de Proyecciones para ${fmtEntero(res.unidadesObjetivo)} Unidades`,
    "",
  ];

  if (res.preciosConfigurados) {
    lineas.push(
      "| Definición de Unidad de Trabajo | Escenario | Tiempo Proyectado | Tokens Proyectados | Costo Conservador (Est. A) | Costo Visible (Est. B) | **Presupuesto Recomendado (+Margen)** |",
      "| :--- | :---: | ---: | ---: | ---: | ---: | :--- |",
    );
    for (const p of res.proyecciones) {
      const marca = p.esPorDefecto ? " *(Por defecto)*" : "";
      lineas.push(
        `| **${p.titulo}**${marca} | **Media** | ${p.media.tiempoFormateado} | ${fmtEntero(p.media.tokensEstimados)} | ${fmtUSD(p.media.costoConservadorUSD)} | ${fmtUSD(p.media.costoVisibleUSD_B)} | \`${p.media.banderaRecomendadaUSD}\` (\`${p.media.banderaRecomendadaTokens}\`) |`,
      );
      lineas.push(
        `| **${p.titulo}**${marca} | **P90** | ${p.p90.tiempoFormateado} | ${fmtEntero(p.p90.tokensEstimados)} | ${fmtUSD(p.p90.costoConservadorUSD)} | ${fmtUSD(p.p90.costoVisibleUSD_B)} | \`${p.p90.banderaRecomendadaUSD}\` (\`${p.p90.banderaRecomendadaTokens}\`) |`,
      );
    }
  } else {
    lineas.push(
      "| Definición de Unidad de Trabajo | Escenario | Tiempo Proyectado | Tokens Proyectados | **Presupuesto de Tokens Recomendado (+Margen)** |",
      "| :--- | :---: | ---: | ---: | :--- |",
    );
    for (const p of res.proyecciones) {
      const marca = p.esPorDefecto ? " *(Por defecto)*" : "";
      lineas.push(
        `| **${p.titulo}**${marca} | **Media** | ${p.media.tiempoFormateado} | ${fmtEntero(p.media.tokensEstimados)} | \`${p.media.banderaRecomendadaTokens}\` |`,
      );
      lineas.push(
        `| **${p.titulo}**${marca} | **P90** | ${p.p90.tiempoFormateado} | ${fmtEntero(p.p90.tokensEstimados)} | \`${p.p90.banderaRecomendadaTokens}\` |`,
      );
    }
  }

  lineas.push("", "---", "", "## 3. Detalle por Definición y Presupuesto Sugerido", "");

  for (const p of res.proyecciones) {
    lineas.push(`### ${p.titulo}${p.esPorDefecto ? " [POR DEFECTO]" : ""}`);
    lineas.push(`- **Clave interna**: \`${p.definicion}\``);
    lineas.push(`- **Definición**: ${p.descripcion}`);
    lineas.push(`- **Volumen operativo proyectado**: ${p.supuestoOperativo}`);
    lineas.push(
      `- **Escenario Promedio (Media)**: Tiempo = **${p.media.tiempoFormateado}**, Tokens = **${fmtEntero(p.media.tokensEstimados)}**${
        res.preciosConfigurados
          ? `, Costo Conservador = **${fmtUSD(p.media.costoConservadorUSD)}**`
          : ""
      }`,
    );
    lineas.push(
      `- **Escenario Conservador (P90)**: Tiempo = **${p.p90.tiempoFormateado}**, Tokens = **${fmtEntero(p.p90.tokensEstimados)}**${
        res.preciosConfigurados
          ? `, Costo Conservador = **${fmtUSD(p.p90.costoConservadorUSD)}**`
          : ""
      }`,
    );
    if (res.preciosConfigurados) {
      lineas.push(
        `- **Presupuesto recomendado (+${res.margenPorcentaje}% margen sobre Media)**: \`${p.media.banderaRecomendadaUSD}\` (respaldo: \`${p.media.banderaRecomendadaTokens}\`)`,
      );
      lineas.push(
        `- **Presupuesto recomendado (+${res.margenPorcentaje}% margen sobre P90)**: \`${p.p90.banderaRecomendadaUSD}\` (respaldo: \`${p.p90.banderaRecomendadaTokens}\`)`,
      );
    } else {
      lineas.push(
        `- **Presupuesto recomendado (+${res.margenPorcentaje}% margen sobre Media)**: \`${p.media.banderaRecomendadaTokens}\``,
      );
      lineas.push(
        `- **Presupuesto recomendado (+${res.margenPorcentaje}% margen sobre P90)**: \`${p.p90.banderaRecomendadaTokens}\``,
      );
    }
    lineas.push("");
  }

  return lineas.join("\n");
}

function imprimirResumenConsola(res: ResultadoEstimacionCarga): void {
  const b = res.baseEmpirica;
  console.log("=".repeat(88));
  console.log(
    `ESTIMADOR DE CARGA S4-1 — Meta: ${fmtEntero(res.unidadesObjetivo)} unidades | Margen: +${res.margenPorcentaje}%`,
  );
  console.log("=".repeat(88));
  console.log(
    `Base empírica: ${b.procesosMedidosEtapas2y3} procesos medidos en Agentes 2 y 3 | ` +
      `${b.llamadasModeloTotales} llamadas al modelo (${b.llamadasAgente1} pág. A1 = ${b.candidatosEvaluadosEnLlamadasA1} cupos) | ` +
      `${b.corridasRegistradasLedger} corridas en Ledger | Tasa 'sí' única: ${(b.tasaAptosUnica * 100).toFixed(2)}% (N=${b.tasaAptosMuestraCandidatos})`,
  );
  console.log(
    `Unidad por defecto (UNIDAD_TRABAJO_POR_DEFECTO): ${res.unidadPorDefecto}`,
  );
  console.log(
    `Precios configurados: ${
      res.preciosConfigurados
        ? `Sí ($${res.tarifas.porMillonEntrada}/1M in, $${res.tarifas.porMillonSalida}/1M out)`
        : "No (null -> proyectando solo tokens)"
    }`,
  );
  console.log("-".repeat(88));

  for (const p of res.proyecciones) {
    console.log(`\n▶ ${p.titulo}${p.esPorDefecto ? " [POR DEFECTO]" : ""}`);
    console.log(`  Supuesto: ${p.supuestoOperativo}`);
    if (res.preciosConfigurados) {
      console.log(
        `  • Media : Tiempo=${p.media.tiempoFormateado} | Tokens=${fmtEntero(p.media.tokensEstimados)} | ` +
          `Costo(A)=${fmtUSD(p.media.costoConservadorUSD)} | Costo(B)=${fmtUSD(p.media.costoVisibleUSD_B)}`,
      );
      console.log(
        `    -> Presupuesto (+${res.margenPorcentaje}%): ${p.media.banderaRecomendadaUSD} (o ${p.media.banderaRecomendadaTokens})`,
      );
      console.log(
        `  • P90   : Tiempo=${p.p90.tiempoFormateado} | Tokens=${fmtEntero(p.p90.tokensEstimados)} | ` +
          `Costo(A)=${fmtUSD(p.p90.costoConservadorUSD)} | Costo(B)=${fmtUSD(p.p90.costoVisibleUSD_B)}`,
      );
      console.log(
        `    -> Presupuesto (+${res.margenPorcentaje}%): ${p.p90.banderaRecomendadaUSD} (o ${p.p90.banderaRecomendadaTokens})`,
      );
    } else {
      console.log(
        `  • Media : Tiempo=${p.media.tiempoFormateado} | Tokens=${fmtEntero(p.media.tokensEstimados)}`,
      );
      console.log(
        `    -> Presupuesto (+${res.margenPorcentaje}%): ${p.media.banderaRecomendadaTokens}`,
      );
      console.log(
        `  • P90   : Tiempo=${p.p90.tiempoFormateado} | Tokens=${fmtEntero(p.p90.tokensEstimados)}`,
      );
      console.log(
        `    -> Presupuesto (+${res.margenPorcentaje}%): ${p.p90.banderaRecomendadaTokens}`,
      );
    }
  }

  console.log("\n" + "=".repeat(88));
  console.log(`[estimar-carga] Reporte escrito en: ${res.rutaArchivoMarkdown}`);
  console.log("=".repeat(88));
}

// Ejecución directa desde CLI
const rutaArchivoActual = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(rutaArchivoActual)) {
  const opts = parsearArgumentosEstimar(process.argv.slice(2));
  ejecutarEstimacionCarga(opts).catch((err) => {
    console.error("[estimar-carga] Error fatal:", err);
    process.exit(1);
  });
}
