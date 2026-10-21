/**
 * Herramienta de Contabilidad y Métricas de Costos en USD (src/tools/costos.ts).
 *
 * Lee logs/tokens.jsonl y calcula:
 * 1. Consumo por Agente (llamadas, entrada, salida, razonamiento, total, USD A y B).
 * 2. Consumo por Proceso (media, mediana, P90, máximo).
 * 3. Costo por Unidad de Trabajo (1 candidato en Agente 1 vs. 1 proceso completo en los 3 agentes).
 * 4. Calibración contra el gasto observado en el dashboard (--gasto-panel-usd).
 * 5. Proyecciones para N unidades de trabajo (--proyectar=N).
 *
 * Guarda automáticamente evidencias committeables en:
 *   data/pruebas-reto/costos/reporte-<timestamp>.md y .json
 *
 * Uso:
 *   pnpm exec tsx src/tools/costos.ts [--ejecucion=ID] [--desde=FECHA] [--hasta=FECHA]
 *                                     [--tipo=TIPO] [--gasto-panel-usd=X.XX] [--proyectar=N]
 *                                     [--config=config/precios.json]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { leerRegistrosTokens, type RegistroTokens } from "../cost.js";
import { leerRegistrosEjecuciones } from "../pruebas/registro-ejecuciones.js";
import { DIR_COSTOS, verificarTamanoArchivo } from "../pruebas/rutas.js";

/** Constante documentada: 1 unidad de trabajo base = 1 candidato evaluado por el Agente 1 */
export const UNIDAD_TRABAJO_BASE_NOMBRE = "1 candidato evaluado por Agente 1 (triaje)";
export const PROCESO_COMPLETO_NOMBRE = "1 proceso estructurado completo (Agente 1 + 2 + 3)";

export interface PreciosModelo {
  porMillonEntrada: number | null;
  porMillonSalida: number | null;
}

export interface ConfiguracionPrecios {
  moneda: string;
  actualizado: string | null;
  fuente: string;
  modelos: Record<string, PreciosModelo>;
}

export interface OpcionesCLI {
  ejecucionId?: string;
  desde?: string;
  hasta?: string;
  tipo?: string;
  gastoPanelUSD?: number;
  proyectarN?: number;
  rutaConfig?: string;
}

export interface ResumenAgente {
  agente: string;
  llamadas: number;
  tokensEntrada: number;
  tokensSalida: number;
  tokensRazonamiento: number;
  tokensTotal: number;
  costoUSD_A: number | null;
  costoUSD_B: number | null;
  porcentajeRazonamiento: number;
}

export interface EstadisticasDistribucion {
  conteo: number;
  media: number;
  mediana: number;
  p90: number;
  max: number;
}

export interface ReporteCostosFinal {
  timestamp: string;
  filtros: OpcionesCLI;
  preciosConfigurados: boolean;
  moneda: string;
  tarifasUtilizadas: Record<string, PreciosModelo>;
  totales: {
    llamadas: number;
    tokensEntrada: number;
    tokensSalida: number;
    tokensRazonamiento: number;
    tokensTotal: number;
    porcentajeRazonamientoGlobal: number;
    costoTotalUSD_A: number | null;
    costoTotalUSD_B: number | null;
  };
  porAgente: ResumenAgente[];
  porProceso: {
    procesosMedidos: number;
    estadisticasTokens: EstadisticasDistribucion;
    estadisticasUSD_A: EstadisticasDistribucion | null;
    estadisticasUSD_B: EstadisticasDistribucion | null;
  };
  unidadDeTrabajo: {
    candidatoAgente1: {
      tokens: number;
      costoUSD_A: number | null;
      costoUSD_B: number | null;
    };
    procesoCompleto: {
      tokens: number;
      costoUSD_A: number | null;
      costoUSD_B: number | null;
    };
  };
  calibracion?: {
    gastoPanelUSD: number;
    ratioEstimacionA: number;
    ratioEstimacionB: number;
    estimacionMasCercana: string;
  };
  proyeccion?: {
    unidades: number;
    procesosMedidosBase: number;
    alertaPocoMuestreo: boolean;
    soloAgente1: {
      escenarioMedia: { tokens: number; costoUSD_A: number | null; costoUSD_B: number | null };
      escenarioP90: { tokens: number; costoUSD_A: number | null; costoUSD_B: number | null };
    };
    pipelineCompleto: {
      tasaAptosMedida: number;
      escenarioMedia: { tokens: number; costoUSD_A: number | null; costoUSD_B: number | null };
      escenarioP90: { tokens: number; costoUSD_A: number | null; costoUSD_B: number | null };
    };
  };
}

function parsearArgumentos(): OpcionesCLI {
  const args = process.argv.slice(2);
  const opts: OpcionesCLI = {};

  for (const arg of args) {
    if (arg.startsWith("--ejecucion=")) {
      opts.ejecucionId = arg.slice(12).trim();
    } else if (arg.startsWith("--desde=")) {
      opts.desde = arg.slice(8).trim();
    } else if (arg.startsWith("--hasta=")) {
      opts.hasta = arg.slice(8).trim();
    } else if (arg.startsWith("--tipo=")) {
      opts.tipo = arg.slice(7).trim();
    } else if (arg.startsWith("--gasto-panel-usd=")) {
      const v = Number.parseFloat(arg.slice(18));
      if (!Number.isNaN(v)) opts.gastoPanelUSD = v;
    } else if (arg.startsWith("--proyectar=")) {
      const n = Number.parseInt(arg.slice(12), 10);
      if (!Number.isNaN(n) && n > 0) opts.proyectarN = n;
    } else if (arg.startsWith("--config=")) {
      opts.rutaConfig = arg.slice(9).trim();
    }
  }

  return opts;
}

export async function cargarConfiguracionPrecios(rutaPersonalizada?: string): Promise<{
  config: ConfiguracionPrecios | null;
  configurados: boolean;
  ruta: string;
}> {
  const ruta = path.resolve(process.cwd(), rutaPersonalizada ?? path.join("config", "precios.json"));
  try {
    const raw = await readFile(ruta, "utf8");
    const json = JSON.parse(raw) as ConfiguracionPrecios;
    const modelos = json.modelos ?? {};
    let algunConfigurado = false;

    for (const [, p] of Object.entries(modelos)) {
      if (typeof p.porMillonEntrada === "number" && typeof p.porMillonSalida === "number") {
        algunConfigurado = true;
      }
    }

    return { config: json, configurados: algunConfigurado, ruta };
  } catch {
    return { config: null, configurados: false, ruta };
  }
}

export function calcularPercentil(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const ordenado = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (ordenado.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return ordenado[lower]! * (1 - weight) + ordenado[upper]! * weight;
}

export function calcularEstadisticas(valores: number[]): EstadisticasDistribucion {
  if (valores.length === 0) {
    return { conteo: 0, media: 0, mediana: 0, p90: 0, max: 0 };
  }
  const suma = valores.reduce((acc, v) => acc + v, 0);
  const media = suma / valores.length;
  const mediana = calcularPercentil(valores, 50);
  const p90 = calcularPercentil(valores, 90);
  const max = Math.max(...valores);

  return {
    conteo: valores.length,
    media: Number(media.toFixed(4)),
    mediana: Number(mediana.toFixed(4)),
    p90: Number(p90.toFixed(4)),
    max: Number(max.toFixed(4)),
  };
}

function formatearNum(n: number): string {
  return n.toLocaleString("es-CO");
}

function formatearUSD(n: number | null): string {
  if (n === null) return "precio no configurado";
  return `$ ${n.toFixed(4)}`;
}

export async function generarReporteCostos(opciones: OpcionesCLI = {}): Promise<ReporteCostosFinal> {
  const { config: configPrecios, configurados, ruta: rutaUsada } =
    await cargarConfiguracionPrecios(opciones.rutaConfig);

  const todosLosTokens = await leerRegistrosTokens();
  const ejecucionesLedger = await leerRegistrosEjecuciones();

  // Filtrado de registros
  let filtrados = todosLosTokens;

  if (opciones.ejecucionId) {
    filtrados = filtrados.filter((r) => r.ejecucionId === opciones.ejecucionId);
  }
  if (opciones.desde) {
    filtrados = filtrados.filter((r) => r.fecha && r.fecha.slice(0, 10) >= opciones.desde!);
  }
  if (opciones.hasta) {
    filtrados = filtrados.filter((r) => r.fecha && r.fecha.slice(0, 10) <= opciones.hasta!);
  }
  if (opciones.tipo) {
    filtrados = filtrados.filter((r) => r.tipo === opciones.tipo);
  }

  // Agrupación por agente
  const gruposAgente = new Map<
    string,
    {
      llamadas: number;
      entrada: number;
      salida: number;
      razonamiento: number;
      total: number;
      costoUSD_A: number;
      costoUSD_B: number;
    }
  >();

  // Agrupación por proceso individual (cuando existe procesoId)
  const gruposProceso = new Map<
    string,
    {
      tokens: number;
      costoUSD_A: number;
      costoUSD_B: number;
    }
  >();

  let totalEntrada = 0;
  let totalSalida = 0;
  let totalRazonamiento = 0;
  let totalFacturado = 0;
  let sumaUSD_A = 0;
  let sumaUSD_B = 0;

  for (const r of filtrados) {
    const agenteNombre = r.agente ?? r.tarea ?? "desconocido";
    const modelo = r.modelo ?? "grok-4.6";
    const precio = configPrecios?.modelos?.[modelo] ?? configPrecios?.modelos?.["default"];

    const pEntrada = configurados && typeof precio?.porMillonEntrada === "number" ? precio.porMillonEntrada : null;
    const pSalida = configurados && typeof precio?.porMillonSalida === "number" ? precio.porMillonSalida : null;

    const inTok = r.tokens_entrada || 0;
    const outTok = r.tokens_salida || 0;
    const totTok = r.tokens_total || (inTok + outTok);
    const razTok = r.tokens_razonamiento ?? r.detalles_salida?.razonamiento ?? Math.max(0, totTok - (inTok + outTok));

    // Estimación A (Conservadora): todo lo no-entrada facturado a tarifa de salida
    const costoA =
      pEntrada !== null && pSalida !== null
        ? (inTok * pEntrada + (totTok - inTok) * pSalida) / 1_000_000
        : null;

    // Estimación B (Solo salida visible): salida visible a tarifa de salida
    const costoB =
      pEntrada !== null && pSalida !== null
        ? (inTok * pEntrada + outTok * pSalida) / 1_000_000
        : null;

    totalEntrada += inTok;
    totalSalida += outTok;
    totalRazonamiento += razTok;
    totalFacturado += totTok;

    if (costoA !== null) sumaUSD_A += costoA;
    if (costoB !== null) sumaUSD_B += costoB;

    // Acumular por agente
    const ag = gruposAgente.get(agenteNombre) ?? {
      llamadas: 0,
      entrada: 0,
      salida: 0,
      razonamiento: 0,
      total: 0,
      costoUSD_A: 0,
      costoUSD_B: 0,
    };
    ag.llamadas++;
    ag.entrada += inTok;
    ag.salida += outTok;
    ag.razonamiento += razTok;
    ag.total += totTok;
    if (costoA !== null) ag.costoUSD_A += costoA;
    if (costoB !== null) ag.costoUSD_B += costoB;
    gruposAgente.set(agenteNombre, ag);

    // Acumular por procesoId si está disponible
    if (r.procesoId) {
      const proc = gruposProceso.get(r.procesoId) ?? { tokens: 0, costoUSD_A: 0, costoUSD_B: 0 };
      proc.tokens += totTok;
      if (costoA !== null) proc.costoUSD_A += costoA;
      if (costoB !== null) proc.costoUSD_B += costoB;
      gruposProceso.set(r.procesoId, proc);
    }
  }

  const porcentajeRazGlobal = totalFacturado > 0 ? (totalRazonamiento / totalFacturado) * 100 : 0;

  // Lista estructurada por agente
  const listaPorAgente: ResumenAgente[] = Array.from(gruposAgente.entries()).map(([nombre, g]) => ({
    agente: nombre,
    llamadas: g.llamadas,
    tokensEntrada: g.entrada,
    tokensSalida: g.salida,
    tokensRazonamiento: g.razonamiento,
    tokensTotal: g.total,
    costoUSD_A: configurados ? Number(g.costoUSD_A.toFixed(4)) : null,
    costoUSD_B: configurados ? Number(g.costoUSD_B.toFixed(4)) : null,
    porcentajeRazonamiento: g.total > 0 ? Number(((g.razonamiento / g.total) * 100).toFixed(1)) : 0,
  }));

  // Estadísticas por proceso
  const procesosArray = Array.from(gruposProceso.values());
  const estadisticasTokens = calcularEstadisticas(procesosArray.map((p) => p.tokens));
  const estadisticasUSD_A = configurados
    ? calcularEstadisticas(procesosArray.map((p) => p.costoUSD_A))
    : null;
  const estadisticasUSD_B = configurados
    ? calcularEstadisticas(procesosArray.map((p) => p.costoUSD_B))
    : null;

  // 3. Costo por Unidad de Trabajo
  // Agente 1 evalúa en páginas de 25 candidatos.
  const resumenFiltrador = gruposAgente.get("agente_filtrador");
  const candidatosEvaluadosA1 = Math.max(1, (resumenFiltrador?.llamadas ?? 1) * 25);
  const tokensPorCandidatoA1 = Math.round((resumenFiltrador?.total ?? 0) / candidatosEvaluadosA1);
  const costodUSD_A_CandidatoA1 = configurados && resumenFiltrador
    ? Number((resumenFiltrador.costoUSD_A / candidatosEvaluadosA1).toFixed(6))
    : null;
  const costodUSD_B_CandidatoA1 = configurados && resumenFiltrador
    ? Number((resumenFiltrador.costoUSD_B / candidatosEvaluadosA1).toFixed(6))
    : null;

  // Proceso completo multi-agente (media de los procesos estructurados en etapas 2 y 3 + triaje)
  const tokensProcesoCompleto = tokensPorCandidatoA1 + Math.round(estadisticasTokens.media);
  const costoUSD_A_ProcesoCompleto =
    configurados && costodUSD_A_CandidatoA1 !== null && estadisticasUSD_A
      ? Number((costodUSD_A_CandidatoA1 + estadisticasUSD_A.media).toFixed(4))
      : null;
  const costoUSD_B_ProcesoCompleto =
    configurados && costodUSD_B_CandidatoA1 !== null && estadisticasUSD_B
      ? Number((costodUSD_B_CandidatoA1 + estadisticasUSD_B.media).toFixed(4))
      : null;

  const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);

  const reporte: ReporteCostosFinal = {
    timestamp: new Date().toISOString(),
    filtros: opciones,
    preciosConfigurados: configurados,
    moneda: configPrecios?.moneda ?? "USD",
    tarifasUtilizadas: configPrecios?.modelos ?? {},
    totales: {
      llamadas: filtrados.length,
      tokensEntrada: totalEntrada,
      tokensSalida: totalSalida,
      tokensRazonamiento: totalRazonamiento,
      tokensTotal: totalFacturado,
      porcentajeRazonamientoGlobal: Number(porcentajeRazGlobal.toFixed(1)),
      costoTotalUSD_A: configurados ? Number(sumaUSD_A.toFixed(4)) : null,
      costoTotalUSD_B: configurados ? Number(sumaUSD_B.toFixed(4)) : null,
    },
    porAgente: listaPorAgente,
    porProceso: {
      procesosMedidos: gruposProceso.size,
      estadisticasTokens,
      estadisticasUSD_A,
      estadisticasUSD_B,
    },
    unidadDeTrabajo: {
      candidatoAgente1: {
        tokens: tokensPorCandidatoA1,
        costoUSD_A: costodUSD_A_CandidatoA1,
        costoUSD_B: costodUSD_B_CandidatoA1,
      },
      procesoCompleto: {
        tokens: tokensProcesoCompleto,
        costoUSD_A: costoUSD_A_ProcesoCompleto,
        costoUSD_B: costoUSD_B_ProcesoCompleto,
      },
    },
  };

  // 4. Calibración con el panel
  if (opciones.gastoPanelUSD !== undefined && configurados && sumaUSD_A > 0 && sumaUSD_B > 0) {
    const ratioA = Number((opciones.gastoPanelUSD / sumaUSD_A).toFixed(4));
    const ratioB = Number((opciones.gastoPanelUSD / sumaUSD_B).toFixed(4));
    const diffA = Math.abs(ratioA - 1.0);
    const diffB = Math.abs(ratioB - 1.0);
    const masCercana =
      diffA <= diffB
        ? "Estimación A (Conservadora — factura razonamiento a tarifa de salida)"
        : "Estimación B (Solo salida visible — omite cobro de razonamiento)";

    reporte.calibracion = {
      gastoPanelUSD: opciones.gastoPanelUSD,
      ratioEstimacionA: ratioA,
      ratioEstimacionB: ratioB,
      estimacionMasCercana: masCercana,
    };
  }

  // 5. Proyección para N unidades
  if (opciones.proyectarN) {
    const N = opciones.proyectarN;
    const procesosMedidos = gruposProceso.size;

    // Tasa histórica de aptos ("SÍ")
    let totalCandidatosHist = 0;
    let totalAptosHist = 0;
    for (const e of ejecucionesLedger) {
      totalCandidatosHist += e.etapas.candidatos;
      totalAptosHist += e.etapas.aptos;
    }
    const tasaAptos =
      totalCandidatosHist > 0 ? totalAptosHist / totalCandidatosHist : 0.5; // fallback razonable

    const tokSoloA1Media = Math.round(N * tokensPorCandidatoA1);
    const tokSoloA1P90 = Math.round(N * (tokensPorCandidatoA1 * 1.25));

    const usdA_SoloA1Media = costodUSD_A_CandidatoA1 !== null ? Number((N * costodUSD_A_CandidatoA1).toFixed(4)) : null;
    const usdB_SoloA1Media = costodUSD_B_CandidatoA1 !== null ? Number((N * costodUSD_B_CandidatoA1).toFixed(4)) : null;
    const usdA_SoloA1P90 = usdA_SoloA1Media !== null ? Number((usdA_SoloA1Media * 1.25).toFixed(4)) : null;
    const usdB_SoloA1P90 = usdB_SoloA1Media !== null ? Number((usdB_SoloA1Media * 1.25).toFixed(4)) : null;

    // Pipeline completo: N evaluados en A1 + (N * tasaAptos) en A2 y A3
    const aptosProyectados = Math.round(N * tasaAptos);
    const tokPipelineMedia = Math.round(tokSoloA1Media + aptosProyectados * estadisticasTokens.media);
    const tokPipelineP90 = Math.round(tokSoloA1P90 + aptosProyectados * estadisticasTokens.p90);

    const usdA_PipelineMedia =
      usdA_SoloA1Media !== null && estadisticasUSD_A
        ? Number((usdA_SoloA1Media + aptosProyectados * estadisticasUSD_A.media).toFixed(4))
        : null;
    const usdB_PipelineMedia =
      usdB_SoloA1Media !== null && estadisticasUSD_B
        ? Number((usdB_SoloA1Media + aptosProyectados * estadisticasUSD_B.media).toFixed(4))
        : null;
    const usdA_PipelineP90 =
      usdA_SoloA1P90 !== null && estadisticasUSD_A
        ? Number((usdA_SoloA1P90 + aptosProyectados * estadisticasUSD_A.p90).toFixed(4))
        : null;
    const usdB_PipelineP90 =
      usdB_SoloA1P90 !== null && estadisticasUSD_B
        ? Number((usdB_SoloA1P90 + aptosProyectados * estadisticasUSD_B.p90).toFixed(4))
        : null;

    reporte.proyeccion = {
      unidades: N,
      procesosMedidosBase: procesosMedidos,
      alertaPocoMuestreo: procesosMedidos < 30,
      soloAgente1: {
        escenarioMedia: { tokens: tokSoloA1Media, costoUSD_A: usdA_SoloA1Media, costoUSD_B: usdB_SoloA1Media },
        escenarioP90: { tokens: tokSoloA1P90, costoUSD_A: usdA_SoloA1P90, costoUSD_B: usdB_SoloA1P90 },
      },
      pipelineCompleto: {
        tasaAptosMedida: Number(tasaAptos.toFixed(3)),
        escenarioMedia: { tokens: tokPipelineMedia, costoUSD_A: usdA_PipelineMedia, costoUSD_B: usdB_PipelineMedia },
        escenarioP90: { tokens: tokPipelineP90, costoUSD_A: usdA_PipelineP90, costoUSD_B: usdB_PipelineP90 },
      },
    };
  }

  // Guardar evidencias en data/pruebas-reto/costos/
  await mkdir(DIR_COSTOS, { recursive: true });
  const rutaJson = path.join(DIR_COSTOS, `reporte-${timestamp}.json`);
  const rutaMd = path.join(DIR_COSTOS, `reporte-${timestamp}.md`);

  await writeFile(rutaJson, JSON.stringify(reporte, null, 2), "utf8");
  await verificarTamanoArchivo(rutaJson);

  // Generar Markdown en español
  let md = `# Reporte Consolidado de Costos y Tokens — Reto Agente 2026\n\n`;
  md += `> **Generado**: ${reporte.timestamp}\n`;
  md += `> **Estado de Precios**: ${configurados ? "Tarifas oficiales configuradas" : "PRECIO NO CONFIGURADO (solo tokens)"}\n`;
  if (configurados) {
    md += `> **Archivo de Precios**: \`${rutaUsada}\`\n\n`;
  } else {
    md += `> *Para calcular valores monetarios, configure las tarifas oficiales en \`config/precios.json\`.*\n\n`;
  }

  md += `## 1. Consumo por Agente\n\n`;
  md += `| Agente / Tarea | Llamadas | Entrada | Salida Visible | Razonamiento | Total Facturado | % Razonamiento | Estimación A (USD) | Estimación B (USD) |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;

  for (const a of reporte.porAgente) {
    md +=
      `| **${a.agente}** | ${a.llamadas} | ${formatearNum(a.tokensEntrada)} | ${formatearNum(a.tokensSalida)} | ` +
      `${formatearNum(a.tokensRazonamiento)} | ${formatearNum(a.tokensTotal)} | ${a.porcentajeRazonamiento}% | ` +
      `${formatearUSD(a.costoUSD_A)} | ${formatearUSD(a.costoUSD_B)} |\n`;
  }

  md +=
    `| **TOTALES** | **${reporte.totales.llamadas}** | **${formatearNum(reporte.totales.tokensEntrada)}** | ` +
    `**${formatearNum(reporte.totales.tokensSalida)}** | **${formatearNum(reporte.totales.tokensRazonamiento)}** | ` +
    `**${formatearNum(reporte.totales.tokensTotal)}** | **${reporte.totales.porcentajeRazonamientoGlobal}%** | ` +
    `**${formatearUSD(reporte.totales.costoTotalUSD_A)}** | **${formatearUSD(reporte.totales.costoTotalUSD_B)}** |\n\n`;

  md += `## 2. Métricas por Proceso Individual\n\n`;
  md += `- **Procesos con ID medidos**: ${reporte.porProceso.procesosMedidos}\n`;
  md += `- **Tokens por proceso**: Media: **${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.media))}**, Mediana: **${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.mediana))}**, P90: **${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.p90))}**, Máx: **${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.max))}**\n`;
  if (configurados) {
    md += `- **Costo Estimación A por proceso**: Media: **${formatearUSD(reporte.porProceso.estadisticasUSD_A?.media ?? null)}**, Mediana: **${formatearUSD(reporte.porProceso.estadisticasUSD_A?.mediana ?? null)}**, P90: **${formatearUSD(reporte.porProceso.estadisticasUSD_A?.p90 ?? null)}**\n`;
    md += `- **Costo Estimación B por proceso**: Media: **${formatearUSD(reporte.porProceso.estadisticasUSD_B?.media ?? null)}**, Mediana: **${formatearUSD(reporte.porProceso.estadisticasUSD_B?.mediana ?? null)}**, P90: **${formatearUSD(reporte.porProceso.estadisticasUSD_B?.p90 ?? null)}**\n\n`;
  } else {
    md += `- **Costo en USD**: *precio no configurado*\n\n`;
  }

  md += `## 3. Costo por Unidad de Trabajo Documentada\n\n`;
  md += `| Concepto | Definición | Tokens | Estimación A (USD) | Estimación B (USD) |\n`;
  md += `|---|---|---:|---:|---:|\n`;
  md +=
    `| **Unidad Base** | ${UNIDAD_TRABAJO_BASE_NOMBRE} | ${formatearNum(reporte.unidadDeTrabajo.candidatoAgente1.tokens)} | ` +
    `${formatearUSD(reporte.unidadDeTrabajo.candidatoAgente1.costoUSD_A)} | ${formatearUSD(reporte.unidadDeTrabajo.candidatoAgente1.costoUSD_B)} |\n`;
  md +=
    `| **Proceso Completo** | ${PROCESO_COMPLETO_NOMBRE} | ${formatearNum(reporte.unidadDeTrabajo.procesoCompleto.tokens)} | ` +
    `${formatearUSD(reporte.unidadDeTrabajo.procesoCompleto.costoUSD_A)} | ${formatearUSD(reporte.unidadDeTrabajo.procesoCompleto.costoUSD_B)} |\n\n`;

  if (reporte.calibracion) {
    md += `## 4. Calibración Empírica contra el Panel del Reto\n\n`;
    md += `- **Gasto observado en el panel**: $ ${reporte.calibracion.gastoPanelUSD.toFixed(4)} USD\n`;
    md += `- **Ratio Panel / Estimación A**: ${reporte.calibracion.ratioEstimacionA}\n`;
    md += `- **Ratio Panel / Estimación B**: ${reporte.calibracion.ratioEstimacionB}\n`;
    md += `- **Conclusión**: La tarificación real se aproxima a la **${reporte.calibracion.estimacionMasCercana}**.\n\n`;
  }

  if (reporte.proyeccion) {
    md += `## 5. Proyección de Costo para ${formatearNum(reporte.proyeccion.unidades)} Unidades de Trabajo\n\n`;
    if (reporte.proyeccion.alertaPocoMuestreo) {
      md += `> ⚠️ **Advertencia estadística**: La proyección se basa en ${reporte.proyeccion.procesosMedidosBase} procesos medidos (menos de 30). Se recomienda calibrar con un set de evaluación más amplio.\n\n`;
    }
    md += `### A. Solo Agente 1 (Triaje básico)\n`;
    md += `- Escenario Media: ${formatearNum(reporte.proyeccion.soloAgente1.escenarioMedia.tokens)} tokens | Est. A: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioMedia.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioMedia.costoUSD_B)}\n`;
    md += `- Escenario P90: ${formatearNum(reporte.proyeccion.soloAgente1.escenarioP90.tokens)} tokens | Est. A: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioP90.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioP90.costoUSD_B)}\n\n`;

    md += `### B. Pipeline Completo Multi-Agente (Tasa medida de aptos: ${(reporte.proyeccion.pipelineCompleto.tasaAptosMedida * 100).toFixed(1)}%)\n`;
    md += `- Escenario Media: ${formatearNum(reporte.proyeccion.pipelineCompleto.escenarioMedia.tokens)} tokens | Est. A: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioMedia.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioMedia.costoUSD_B)}\n`;
    md += `- Escenario P90: ${formatearNum(reporte.proyeccion.pipelineCompleto.escenarioP90.tokens)} tokens | Est. A: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioP90.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioP90.costoUSD_B)}\n\n`;
  }

  await writeFile(rutaMd, md, "utf8");
  await verificarTamanoArchivo(rutaMd);

  return reporte;
}

export function imprimirReporteConsola(reporte: ReporteCostosFinal): void {
  console.log("================================================================================");
  console.log(`📊 REPORTE DE COSTOS Y TOKENS — RETO AGENTE 2026`);
  console.log(`📅 Generado: ${reporte.timestamp}`);
  console.log(
    `💰 Estado de Precios: ${reporte.preciosConfigurados ? "TARIFAS CONFIGURADAS (USD)" : "PRECIO NO CONFIGURADO (solo tokens)"}`,
  );
  console.log("================================================================================\n");

  console.log("--- 1. CONSUMO POR AGENTE ---");
  console.log(
    "| Agente".padEnd(22) +
      "| Llamadas".padStart(10) +
      "| Entrada".padStart(12) +
      "| Salida".padStart(10) +
      "| Razonamiento".padStart(15) +
      "| Total".padStart(12) +
      "| % Raz.".padStart(9) +
      (reporte.preciosConfigurados ? "| USD A (Cons.)".padStart(16) + "| USD B (Vis.)".padStart(16) : "") +
      " |",
  );
  console.log(
    "|" +
      "-".repeat(21) +
      "|" +
      "-".repeat(10) +
      "|" +
      "-".repeat(12) +
      "|" +
      "-".repeat(10) +
      "|" +
      "-".repeat(15) +
      "|" +
      "-".repeat(12) +
      "|" +
      "-".repeat(9) +
      (reporte.preciosConfigurados ? "|" + "-".repeat(16) + "|" + "-".repeat(16) : "") +
      "|",
  );

  for (const a of reporte.porAgente) {
    const usdA = reporte.preciosConfigurados ? formatearUSD(a.costoUSD_A).padStart(15) + " " : "";
    const usdB = reporte.preciosConfigurados ? formatearUSD(a.costoUSD_B).padStart(15) + " " : "";
    console.log(
      `| ${a.agente.padEnd(20)}| ${formatearNum(a.llamadas).padStart(9)} ` +
        `| ${formatearNum(a.tokensEntrada).padStart(11)} ` +
        `| ${formatearNum(a.tokensSalida).padStart(9)} ` +
        `| ${formatearNum(a.tokensRazonamiento).padStart(14)} ` +
        `| ${formatearNum(a.tokensTotal).padStart(11)} ` +
        `| ${(a.porcentajeRazonamiento + "%").padStart(8)} ` +
        (reporte.preciosConfigurados ? `| ${usdA}| ${usdB}` : "") +
        `|`,
    );
  }

  const totUsdA = reporte.preciosConfigurados ? formatearUSD(reporte.totales.costoTotalUSD_A).padStart(15) + " " : "";
  const totUsdB = reporte.preciosConfigurados ? formatearUSD(reporte.totales.costoTotalUSD_B).padStart(15) + " " : "";
  console.log(
    "|" +
      "-".repeat(21) +
      "|" +
      "-".repeat(10) +
      "|" +
      "-".repeat(12) +
      "|" +
      "-".repeat(10) +
      "|" +
      "-".repeat(15) +
      "|" +
      "-".repeat(12) +
      "|" +
      "-".repeat(9) +
      (reporte.preciosConfigurados ? "|" + "-".repeat(16) + "|" + "-".repeat(16) : "") +
      "|",
  );
  console.log(
    `| ${"TOTALES GLOBALES".padEnd(20)}| ${formatearNum(reporte.totales.llamadas).padStart(9)} ` +
      `| ${formatearNum(reporte.totales.tokensEntrada).padStart(11)} ` +
      `| ${formatearNum(reporte.totales.tokensSalida).padStart(9)} ` +
      `| ${formatearNum(reporte.totales.tokensRazonamiento).padStart(14)} ` +
      `| ${formatearNum(reporte.totales.tokensTotal).padStart(11)} ` +
      `| ${(reporte.totales.porcentajeRazonamientoGlobal + "%").padStart(8)} ` +
      (reporte.preciosConfigurados ? `| ${totUsdA}| ${totUsdB}` : "") +
      `|\n`,
  );

  console.log("--- 2. MÉTRICAS POR PROCESO INDIVIDUAL ---");
  console.log(`• Procesos únicos medidos con ID: ${reporte.porProceso.procesosMedidos}`);
  console.log(
    `• Tokens por proceso: Media: ${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.media))} | ` +
      `Mediana: ${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.mediana))} | ` +
      `P90: ${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.p90))} | ` +
      `Máx: ${formatearNum(Math.round(reporte.porProceso.estadisticasTokens.max))}`,
  );
  if (reporte.preciosConfigurados) {
    console.log(
      `• Costo USD A (Conservador): Media: ${formatearUSD(reporte.porProceso.estadisticasUSD_A?.media ?? null)} | ` +
        `Mediana: ${formatearUSD(reporte.porProceso.estadisticasUSD_A?.mediana ?? null)} | ` +
        `P90: ${formatearUSD(reporte.porProceso.estadisticasUSD_A?.p90 ?? null)}`,
    );
    console.log(
      `• Costo USD B (Solo visible): Media: ${formatearUSD(reporte.porProceso.estadisticasUSD_B?.media ?? null)} | ` +
        `Mediana: ${formatearUSD(reporte.porProceso.estadisticasUSD_B?.mediana ?? null)} | ` +
        `P90: ${formatearUSD(reporte.porProceso.estadisticasUSD_B?.p90 ?? null)}\n`,
    );
  } else {
    console.log(`• Costo USD por proceso: precio no configurado\n`);
  }

  console.log("--- 3. UNIDAD DE TRABAJO DOCUMENTADA ---");
  console.log(
    `• Unidad Base (${UNIDAD_TRABAJO_BASE_NOMBRE}): ` +
      `${formatearNum(reporte.unidadDeTrabajo.candidatoAgente1.tokens)} tokens` +
      (reporte.preciosConfigurados
        ? ` | Est. A: ${formatearUSD(reporte.unidadDeTrabajo.candidatoAgente1.costoUSD_A)} | Est. B: ${formatearUSD(reporte.unidadDeTrabajo.candidatoAgente1.costoUSD_B)}`
        : " | precio no configurado"),
  );
  console.log(
    `• Proceso Completo (${PROCESO_COMPLETO_NOMBRE}): ` +
      `${formatearNum(reporte.unidadDeTrabajo.procesoCompleto.tokens)} tokens` +
      (reporte.preciosConfigurados
        ? ` | Est. A: ${formatearUSD(reporte.unidadDeTrabajo.procesoCompleto.costoUSD_A)} | Est. B: ${formatearUSD(reporte.unidadDeTrabajo.procesoCompleto.costoUSD_B)}`
        : " | precio no configurado"),
  );
  console.log("");

  if (reporte.calibracion) {
    console.log("--- 4. CALIBRACIÓN EMPÍRICA CON EL PANEL ---");
    console.log(`• Gasto observado en panel: $ ${reporte.calibracion.gastoPanelUSD.toFixed(4)} USD`);
    console.log(`• Ratio Panel / Estimación A: ${reporte.calibracion.ratioEstimacionA}`);
    console.log(`• Ratio Panel / Estimación B: ${reporte.calibracion.ratioEstimacionB}`);
    console.log(`• Estimación más cercana: ${reporte.calibracion.estimacionMasCercana}\n`);
  }

  if (reporte.proyeccion) {
    console.log(`--- 5. PROYECCIÓN PARA ${formatearNum(reporte.proyeccion.unidades)} UNIDADES ---`);
    if (reporte.proyeccion.alertaPocoMuestreo) {
      console.log(
        `⚠️ ADVERTENCIA: La proyección se basa en ${reporte.proyeccion.procesosMedidosBase} procesos medidos (menos de 30). El margen de error estadístico puede ser elevado.\n`,
      );
    }
    console.log(`[A] Solo Agente 1 (Triaje básico):`);
    console.log(
      `   • Escenario Media: ${formatearNum(reporte.proyeccion.soloAgente1.escenarioMedia.tokens)} tokens` +
        (reporte.preciosConfigurados
          ? ` | Est. A: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioMedia.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioMedia.costoUSD_B)}`
          : " | precio no configurado"),
    );
    console.log(
      `   • Escenario P90:   ${formatearNum(reporte.proyeccion.soloAgente1.escenarioP90.tokens)} tokens` +
        (reporte.preciosConfigurados
          ? ` | Est. A: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioP90.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.soloAgente1.escenarioP90.costoUSD_B)}`
          : " | precio no configurado"),
    );
    console.log(
      `[B] Pipeline Completo Multi-Agente (Tasa viabilidad medida: ${(reporte.proyeccion.pipelineCompleto.tasaAptosMedida * 100).toFixed(1)}%):`,
    );
    console.log(
      `   • Escenario Media: ${formatearNum(reporte.proyeccion.pipelineCompleto.escenarioMedia.tokens)} tokens` +
        (reporte.preciosConfigurados
          ? ` | Est. A: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioMedia.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioMedia.costoUSD_B)}`
          : " | precio no configurado"),
    );
    console.log(
      `   • Escenario P90:   ${formatearNum(reporte.proyeccion.pipelineCompleto.escenarioP90.tokens)} tokens` +
        (reporte.preciosConfigurados
          ? ` | Est. A: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioP90.costoUSD_A)} | Est. B: ${formatearUSD(reporte.proyeccion.pipelineCompleto.escenarioP90.costoUSD_B)}`
          : " | precio no configurado"),
    );
    console.log("");
  }

  console.log(`📑 Reportes committeables guardados en: data/pruebas-reto/costos/`);
  console.log("================================================================================\n");
}

async function main(): Promise<void> {
  const opciones = parsearArgumentos();
  const reporte = await generarReporteCostos(opciones);
  imprimirReporteConsola(reporte);
}

// Ejecución directa por CLI
main().catch((err) => {
  console.error("Error al calcular costos y tokens:", err);
  process.exit(1);
});
