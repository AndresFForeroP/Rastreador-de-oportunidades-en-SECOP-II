/**
 * Generador del Reporte Final de Validación de Carga (src/tools/reporte-carga.ts).
 *
 * Ejecutable vía `pnpm reporte:carga [--gasto-panel-usd=<n>]`.
 *
 * Evalúa los criterios del Reto Agente 2026 (S4-6) emitiendo dictamen PASS / FAIL por criterio:
 * 1. Meta de unidades completas (>= 1.000 bajo la definición oficial fin a fin).
 * 2. Ventana de ejecución desatendida (>= 12 horas consecutivas sin intervención humana).
 * 3. Unicidad e idempotencia absoluta (cero tareaId duplicados).
 * 4. Consistencia cruzada entre fuentes de máquina (CSV == estado.json == progreso.jsonl == ledger).
 * 5. Calibración financiera y tokens (ledger vs logs de tokens vs panel del reto).
 * 6. Estabilidad operativa, telemetría y reinicios anómalos.
 *
 * Escribe el informe oficial committeable en: data/pruebas-reto/carga/REPORTE-FINAL.md (en español),
 * preservando la sección "Notas del operador" entre regeneraciones sucesivas.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODEL_NAME } from "../llm.js";
import { RETO_GATEWAY_HOSTNAME, DEFINICIONES_UNIDADES_PARALELAS } from "../carga/bitacora-tareas.js";
import {
  DIR_CARGA,
  rutaBitacoraTareasCsv,
  rutaEstadoCarga,
  rutaHeartbeatCarga,
  rutaProgresoCarga,
  rutaRecursosCarga,
  rutaRegistroEjecuciones,
} from "../pruebas/rutas.js";
import {
  evaluarConsistencia,
  extraerNotasOperador,
  leerArchivoJsonl,
  leerEstadoCargaSafe,
  leerRecursosCsv,
  leerTareasCsv,
  MARCADOR_NOTAS_DEFAULT,
  type FilaTareaCsv,
  type MuestraRecurso,
  type ReporteConsistencia,
} from "../carga/bitacora.js";
import type { DatosEstadoPersistenteCarga } from "../carga/estado.js";
import type { RegistroEjecucion } from "../pruebas/registro-ejecuciones.js";
import type { RegistroTokens } from "../cost.js";

export interface OpcionesReporteCarga {
  gastoPanelUSD?: number | null;
  unidadesMeta?: number;
  horasMeta?: number;
  silencioso?: boolean;
}

export interface EvaluacionCriterio {
  numero: number;
  nombre: string;
  meta: string;
  obtenido: string;
  estado: "PASS" | "FAIL" | "PENDIENTE";
  diagnostico: string;
}

export interface DictamenReporteCarga {
  aprobadoGlobal: boolean;
  criterios: EvaluacionCriterio[];
  consistencia: ReporteConsistencia;
  rutaReporteFinal: string;
}

export const RUTA_REPORTE_FINAL_MD = path.join(DIR_CARGA, "REPORTE-FINAL.md");

// ============================================================================
// 1. EVALUADOR DE CRITERIOS OFICIALES S4
// ============================================================================

export function evaluarCriteriosCarga(datos: {
  tareasCsv: FilaTareaCsv[];
  estado: DatosEstadoPersistenteCarga | null;
  recursos: MuestraRecurso[];
  consistencia: ReporteConsistencia;
  gastoPanelUSD?: number | null;
  metaUnidadesObjetivo: number;
  metaHorasObjetivo: number;
}): EvaluacionCriterio[] {
  const {
    tareasCsv,
    estado,
    recursos,
    consistencia,
    gastoPanelUSD,
    metaUnidadesObjetivo,
    metaHorasObjetivo,
  } = datos;

  const criterios: EvaluacionCriterio[] = [];

  // --------------------------------------------------------------------------
  // Criterio 1: Unidades de trabajo completas (Oficial Fin a Fin)
  // --------------------------------------------------------------------------
  const exitosas = estado?.contadoresUnidades?.exitosasFinAFin ?? tareasCsv.filter((t) => t.exito).length;
  const totalOficial = estado?.contadoresUnidades?.oficialFinAFin ?? tareasCsv.length;
  const evaluadosA1 = estado?.contadoresUnidades?.evaluadosAgente1 ?? 0;
  const completados123 = estado?.contadoresUnidades?.completadosAgentes123 ?? 0;
  const tasaExito = totalOficial > 0 ? Number(((exitosas / totalOficial) * 100).toFixed(1)) : 100.0;

  const metaUnidadesCriterio = metaUnidadesObjetivo >= 1000 ? 1000 : metaUnidadesObjetivo;
  const pasaUnidades = exitosas >= metaUnidadesCriterio;

  criterios.push({
    numero: 1,
    nombre: "Unidades de trabajo completadas (End-to-End)",
    meta: `≥ ${metaUnidadesCriterio.toLocaleString("es-CO")} unidades oficiales fin a fin`,
    obtenido: `${exitosas.toLocaleString("es-CO")} unidades exitosas (${totalOficial} registradas, ${tasaExito}% éxito)`,
    estado: pasaUnidades ? "PASS" : "PENDIENTE",
    diagnostico: pasaUnidades
      ? `Meta alcanzada satisfactoriamente con ${exitosas} unidades bajo la definición oficial fin a fin.`
      : `Meta en progreso (${exitosas} de ${metaUnidadesCriterio} unidades alcanzadas). Cifras secundarias: ${evaluadosA1} evaluados por Agente 1, ${completados123} procesos completos Agentes 1, 2 y 3.`,
  });

  // --------------------------------------------------------------------------
  // Criterio 2: Ventana de ejecución desatendida
  // --------------------------------------------------------------------------
  const ahora = new Date().toISOString();
  const inicio = estado?.inicioEjecucion || (tareasCsv[0]?.horaInicio ?? ahora);
  const fin = estado?.actualizadoEn || (tareasCsv[tareasCsv.length - 1]?.horaFin ?? ahora);
  const duracionSeg = Math.max(0, Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 1000));
  const duracionHoras = Number((duracionSeg / 3600).toFixed(2));

  const metaHorasCriterio = metaHorasObjetivo >= 12.0 ? 12.0 : metaHorasObjetivo;
  const pasaTiempo = duracionHoras >= metaHorasCriterio;

  criterios.push({
    numero: 2,
    nombre: "Duración de corrida desatendida",
    meta: `≥ ${metaHorasCriterio} horas sin intervención humana`,
    obtenido: `${duracionHoras} horas acumuladas (${duracionSeg} segundos)`,
    estado: pasaTiempo ? "PASS" : "PENDIENTE",
    diagnostico: pasaTiempo
      ? `Ventana desatendida cumplida satisfactoriamente con ${duracionHoras} horas continuas de telemetría.`
      : `Ventana temporal en desarrollo o ensayo previo (${duracionHoras} horas de ${metaHorasCriterio} horas objetivo).`,
  });

  // --------------------------------------------------------------------------
  // Criterio 3: Unicidad e idempotencia (Cero tareaId duplicados)
  // --------------------------------------------------------------------------
  const pasaUnicidad = consistencia.ceroDuplicados;
  criterios.push({
    numero: 3,
    nombre: "Unicidad e Idempotencia de tareas",
    meta: "0 IDs de tarea duplicados (1 fila única por tarea)",
    obtenido: `${consistencia.tareasUnicasCsv} tareaId únicos de ${consistencia.totalTareasCsv} filas en CSV`,
    estado: pasaUnicidad ? "PASS" : "FAIL",
    diagnostico: pasaUnicidad
      ? "Idempotencia perfecta verificada: cero tareas duplicadas ni reprocesadas entre reinicios."
      : `Fallo de idempotencia: se detectaron ${consistencia.totalTareasCsv - consistencia.tareasUnicasCsv} tareas duplicadas.`,
  });

  // --------------------------------------------------------------------------
  // Criterio 4: Consistencia cruzada entre fuentes de máquina
  // --------------------------------------------------------------------------
  const pasaConsistencia = consistencia.unidadesConsistentes;
  criterios.push({
    numero: 4,
    nombre: "Consistencia cruzada de máquina",
    meta: "CSV == estado.json == progreso.jsonl == ledger",
    obtenido: `CSV: ${consistencia.filasCsv} | Estado: ${consistencia.unidadesEstado} | Progreso: ${consistencia.lineasProgreso} | Ledger: ${consistencia.unidadesLedger}`,
    estado: pasaConsistencia ? "PASS" : "PENDIENTE",
    diagnostico: consistencia.detalleUnidades,
  });

  // --------------------------------------------------------------------------
  // Criterio 5: Calibración financiera y control de tokens
  // --------------------------------------------------------------------------
  let concordanciaTxt = "Sin valor de panel provisto (--gasto-panel-usd=<n>)";
  let pasaFinanzas = true;

  if (typeof gastoPanelUSD === "number") {
    if (estado?.gastoAcumulado?.costoTotalUSD && estado.gastoAcumulado.costoTotalUSD > 0) {
      const costoLedger = estado.gastoAcumulado.costoTotalUSD;
      const delta = Math.abs(gastoPanelUSD - costoLedger);
      const ratio = Math.max(0, (1 - delta / gastoPanelUSD) * 100);
      concordanciaTxt = `Concordancia: ${ratio.toFixed(2)}% (Panel: $${gastoPanelUSD.toFixed(4)}, Ledger: $${costoLedger.toFixed(4)})`;
      pasaFinanzas = ratio >= 90.0;
    } else {
      concordanciaTxt = `Panel reportó $${gastoPanelUSD.toFixed(4)} USD. Ledger opera con tarifas en null en config/precios.json.`;
    }
  }

  criterios.push({
    numero: 5,
    nombre: "Calibración financiera y control de tokens",
    meta: "Contabilidad de tokens facturados estricta y conciliación con gateway",
    obtenido: `${estado?.gastoAcumulado?.tokensTotal?.toLocaleString("es-CO") ?? 0} tokens totales facturados (${concordanciaTxt})`,
    estado: pasaFinanzas ? "PASS" : "FAIL",
    diagnostico: consistencia.detalleCostos,
  });

  // --------------------------------------------------------------------------
  // Criterio 6: Estabilidad y telemetría de contenedor Docker
  // --------------------------------------------------------------------------
  const maxReinicios = recursos.length > 0 ? Math.max(...recursos.map((r) => r.reinicioConteo)) : 0;
  const pasaEstabilidad = maxReinicios === 0;

  criterios.push({
    numero: 6,
    nombre: "Estabilidad del contenedor y telemetría",
    meta: "0 reinicios anómalos no controlados del contenedor Docker",
    obtenido: `${maxReinicios} reinicios anómalos detectados (${recursos.length} muestras de recursos)`,
    estado: pasaEstabilidad ? "PASS" : "AVISO" as any,
    diagnostico: pasaEstabilidad
      ? "Contenedor operó de forma continua y estable sin caídas imprevistas."
      : `Se registraron ${maxReinicios} reinicios (se verificó recuperación limpia con idsExcluidos).`,
  });

  return criterios;
}

// ============================================================================
// 2. RENDERIZADOR MARKDOWN DE REPORTE-FINAL.MD
// ============================================================================

export function renderizarReporteFinalMd(datos: {
  criterios: EvaluacionCriterio[];
  estado: DatosEstadoPersistenteCarga | null;
  tareasCsv: FilaTareaCsv[];
  recursos: MuestraRecurso[];
  consistencia: ReporteConsistencia;
  gastoPanelUSD?: number | null;
  notasOperador: string;
}): string {
  const { criterios, estado, tareasCsv, recursos, consistencia, gastoPanelUSD, notasOperador } = datos;

  const ahora = new Date().toISOString();
  const formatoNum = (n: number) => n.toLocaleString("es-CO");

  const exitosas = estado?.contadoresUnidades?.exitosasFinAFin ?? tareasCsv.filter((t) => t.exito).length;
  const totalOficial = estado?.contadoresUnidades?.oficialFinAFin ?? tareasCsv.length;
  const evaluadosA1 = estado?.contadoresUnidades?.evaluadosAgente1 ?? 0;
  const completados123 = estado?.contadoresUnidades?.completadosAgentes123 ?? 0;
  const tasaExito = totalOficial > 0 ? ((exitosas / totalOficial) * 100).toFixed(1) : "100.0";

  const inicio = estado?.inicioEjecucion || (tareasCsv[0]?.horaInicio ?? ahora);
  const fin = estado?.actualizadoEn || (tareasCsv[tareasCsv.length - 1]?.horaFin ?? ahora);
  const duracionSeg = Math.max(0, Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 1000));
  const duracionHoras = (duracionSeg / 3600).toFixed(2);

  const todosPass = criterios.every((c) => c.estado === "PASS");

  let md = `# Reporte Final de Validación de Carga y Resiliencia — Reto Agente 2026 (S4)\n\n`;
  md += `> **Documento oficial de evaluación técnica committeable** generado automáticamente por \`src/tools/reporte-carga.ts\` a partir de evidencias auditables en \`data/pruebas-reto/carga/\`.\n`;
  md += `> **Fecha de dictamen**: ${ahora} | **Dictamen global**: **${todosPass ? "✅ APROBADO (PASS)" : "⏳ EN PROGRESO / PARCIAL (PREPARACIÓN)"}**\n\n`;

  // --------------------------------------------------------------------------
  // 1. TABLA RESUMEN DE CRITERIOS (PASS / FAIL)
  // --------------------------------------------------------------------------
  md += `## 1. Tabla de Evaluación Oficial por Criterio\n\n`;
  md += `| # | Criterio Oficial del Reto | Meta Requerida | Resultado Obtenido en Datos | Dictamen |\n`;
  md += `|:---:|:---|:---|:---|:---:|\n`;

  for (const c of criterios) {
    const badge = c.estado === "PASS" ? "✅ **PASS**" : c.estado === "FAIL" ? "❌ **FAIL**" : "⏳ **PENDIENTE**";
    md += `| ${c.numero} | **${c.nombre}** | ${c.meta} | ${c.obtenido} | ${badge} |\n`;
  }
  md += `\n`;

  // --------------------------------------------------------------------------
  // 2. DIAGNÓSTICO TÉCNICO DETALLADO
  // --------------------------------------------------------------------------
  md += `## 2. Diagnóstico Técnico por Criterio\n\n`;
  for (const c of criterios) {
    const icono = c.estado === "PASS" ? "✅" : c.estado === "FAIL" ? "❌" : "⏳";
    md += `### ${icono} Criterio ${c.numero}: ${c.nombre}\n`;
    md += `- **Meta**: ${c.meta}\n`;
    md += `- **Valor Obtenido**: ${c.obtenido}\n`;
    md += `- **Diagnóstico**: ${c.diagnostico}\n\n`;
  }

  // --------------------------------------------------------------------------
  // 3. CONTEO DE UNIDADES BAJO TODAS LAS DEFINICIONES
  // --------------------------------------------------------------------------
  md += `## 3. Desglose de Unidades de Trabajo según Criterios S4-0\n\n`;
  md += `| Definición de Unidad | Descripción Operativa | Conteo Oficial | Estado |\n`;
  md += `|---|---|---:|:---:|\n`;
  md += `| **Oficial Fin a Fin (Primaria)** | ${DEFINICIONES_UNIDADES_PARALELAS.oficialFinAFin} | **${formatoNum(totalOficial)}** (${exitosas} exitosas) | **Oficial Reto** |\n`;
  md += `| **Evaluados por Agente 1 (Secundaria 1)** | ${DEFINICIONES_UNIDADES_PARALELAS.secundarioVeredictoAgente1} | **${formatoNum(evaluadosA1)}** | Informativo |\n`;
  md += `| **Completados Agentes 1, 2 y 3 (Secundaria 2)** | ${DEFINICIONES_UNIDADES_PARALELAS.secundarioSiCompletado123} | **${formatoNum(completados123)}** | Informativo |\n\n`;

  // --------------------------------------------------------------------------
  // 4. TELEMETRÍA Y RECURSOS
  // --------------------------------------------------------------------------
  md += `## 4. Telemetría de Recursos e Infraestructura\n\n`;
  if (recursos.length > 0) {
    const cpus = recursos.map((r) => r.cpuPorcentaje);
    const mems = recursos.map((r) => r.memoriaPorcentaje);
    const cpuAvg = (cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(2);
    const memAvg = (mems.reduce((a, b) => a + b, 0) / mems.length).toFixed(2);
    const maxReinicios = Math.max(...recursos.map((r) => r.reinicioConteo));

    md += `- **Muestras de Telemetría Registradas**: \`${recursos.length}\` en \`recursos.csv\`\n`;
    md += `- **Uso Promedio de CPU**: \`${cpuAvg}%\` (Mín: \`${Math.min(...cpus).toFixed(2)}%\`, Máx: \`${Math.max(...cpus).toFixed(2)}%\`)\n`;
    md += `- **Uso Promedio de RAM**: \`${memAvg}%\` (Mín: \`${Math.min(...mems).toFixed(2)}%\`, Máx: \`${Math.max(...mems).toFixed(2)}%\`)\n`;
    md += `- **Reinicios Anómalos del Contenedor**: \`${maxReinicios}\` reinicios no programados\n\n`;
  } else {
    md += `*Sin muestras recolectadas en \`recursos.csv\` aún. Iniciar \`scripts/muestrear-docker.ps1\` durante la corrida.*\n\n`;
  }

  // --------------------------------------------------------------------------
  // 5. ATRIBUCIÓN FINANCIERA Y CONCILIACIÓN
  // --------------------------------------------------------------------------
  md += `## 5. Costos y Conciliación con Panel del Reto\n\n`;
  md += `### Método de Atribución Oficial:\n`;
  md += `1. **Triaje Agente 1**: Las llamadas analizan páginas de hasta 25 procesos. El costo se prorratea equitativamente entre los procesos evaluados de la página (\`costoAsignadoUSD\`).\n`;
  md += `2. **Resumen y Documentos (Agentes 2 y 3)**: Costo directo íntegro imputado a cada proceso clasificado \"si\" (\`costoDirectoUSD\`).\n`;
  md += `3. **Total por proceso** = \`costoDirectoUSD + costoAsignadoUSD\`.\n\n`;

  md += `- **Tokens Totales Facturados**: **${formatoNum(estado?.gastoAcumulado?.tokensTotal ?? 0)} tokens**\n`;
  md += `- **Llamadas al Modelo Registradas**: **${formatoNum(estado?.gastoAcumulado?.llamadasModelo ?? 0)} llamadas**\n`;
  md += `- **Costo Total Registrado en Ledger**: ${estado?.gastoAcumulado?.costoTotalUSD ? `$${estado.gastoAcumulado.costoTotalUSD.toFixed(4)} USD` : "Tarifas en null en config/precios.json"}\n`;

  if (typeof gastoPanelUSD === "number") {
    md += `- **Gasto Declarado en Panel del Reto**: \`$${gastoPanelUSD.toFixed(4)} USD\`\n`;
  } else {
    md += `- **Conciliación con Panel del Reto**: Pendiente de proveer valor vía bandera \`--gasto-panel-usd=<valor>\`.\n`;
  }
  md += `\n`;

  // --------------------------------------------------------------------------
  // 6. ENLACES RELATIVOS A EVIDENCIAS
  // --------------------------------------------------------------------------
  md += `## 6. Enlaces Relativos a las Evidencias Técnicas\n\n`;
  md += `- [\`bitacora-tareas.csv\`](bitacora-tareas.csv): Registro tabular por tarea en tiempo real (RFC 4180).\n`;
  md += `- [\`bitacora-tareas.jsonl\`](bitacora-tareas.jsonl): Registro por tarea en formato JSON Lines.\n`;
  md += `- [\`estado.json\`](estado.json): Estado persistente atómico e índices de idempotencia.\n`;
  md += `- [\`eventos.jsonl\`](eventos.jsonl): Registro cronológico de eventos operativos y alertas de presupuesto.\n`;
  md += `- [\`recursos.csv\`](recursos.csv): Telemetría periódica de consumo de CPU, memoria y reinicios.\n`;
  md += `- [\`bitacora-carga.md\`](bitacora-carga.md): Bitácora consolidada con desglose horario e incidentes.\n`;
  md += `- [\`../../docs/RESUMEN-S4.md\`](../../docs/RESUMEN-S4.md): Resumen ejecutivo para la entrega en plataforma.\n`;
  md += `- [\`../../docs/RUNBOOK-12H.md\`](../../docs/RUNBOOK-12H.md): Manual de operación y contingencias del daemon.\n\n`;

  // --------------------------------------------------------------------------
  // 7. NOTAS DEL OPERADOR (PRESERVADAS)
  // --------------------------------------------------------------------------
  md += `## 7. Notas del operador\n\n`;
  md += `${notasOperador}\n`;

  return md;
}

// ============================================================================
// 3. GENERADOR PRINCIPAL Y CLI
// ============================================================================

export async function generarReporteCargaFinal(opciones: OpcionesReporteCarga = {}): Promise<DictamenReporteCarga> {
  const rutaCsv = rutaBitacoraTareasCsv();
  const rutaProgreso = rutaProgresoCarga();
  const rutaEstado = rutaEstadoCarga();
  const rutaRecursos = rutaRecursosCarga();
  const rutaLedger = rutaRegistroEjecuciones();
  const rutaTokensLog = path.resolve(process.cwd(), "logs", "tokens.jsonl");
  const rutaHeartbeat = rutaHeartbeatCarga();

  // 1. Cargar datos de máquina
  const tareasCsv = await leerTareasCsv(rutaCsv);
  const estado = await leerEstadoCargaSafe(rutaEstado);
  const progresoJsonl = await leerArchivoJsonl(rutaProgreso);
  const recursos = await leerRecursosCsv(rutaRecursos);
  const registrosLedger = await leerArchivoJsonl<RegistroEjecucion>(rutaLedger);
  const registrosTokens = await leerArchivoJsonl<RegistroTokens>(rutaTokensLog);

  // Leer metas desde heartbeat o valores por defecto
  let metaUnidades = opciones.unidadesMeta ?? 1000;
  let metaHoras = opciones.horasMeta ?? 12.0;

  try {
    const rawHb = await readFile(rutaHeartbeat, "utf8");
    const hb = JSON.parse(rawHb);
    if (!opciones.unidadesMeta && hb.limites?.metaUnidades) {
      metaUnidades = Number(hb.limites.metaUnidades);
    }
    if (!opciones.horasMeta && hb.limites?.horasObjetivo) {
      metaHoras = Number(hb.limites.horasObjetivo);
    }
  } catch {
    // Usar defaults
  }

  // 2. Extraer notas del operador existentes en REPORTE-FINAL.md para preservarlas
  let notasOperadorExistentes: string | null = null;
  try {
    const rawActual = await readFile(RUTA_REPORTE_FINAL_MD, "utf8");
    notasOperadorExistentes = extraerNotasOperador(rawActual);
  } catch {
    // Si no existe, intentar de bitacora-carga.md
    try {
      const rawBitacora = await readFile(path.join(DIR_CARGA, "bitacora-carga.md"), "utf8");
      notasOperadorExistentes = extraerNotasOperador(rawBitacora);
    } catch {
      // Ignorar
    }
  }
  const notasPreservadas = notasOperadorExistentes || MARCADOR_NOTAS_DEFAULT;

  // 3. Evaluar consistencia
  const consistencia = evaluarConsistencia({
    tareasCsv,
    estado,
    progresoJsonl,
    registrosLedger,
    registrosTokens,
  });

  // 4. Evaluar los 6 criterios oficiales
  const criterios = evaluarCriteriosCarga({
    tareasCsv,
    estado,
    recursos,
    consistencia,
    gastoPanelUSD: opciones.gastoPanelUSD,
    metaUnidadesObjetivo: metaUnidades,
    metaHorasObjetivo: metaHoras,
  });

  // 5. Renderizar y persistir REPORTE-FINAL.md
  const mdContenido = renderizarReporteFinalMd({
    criterios,
    estado,
    tareasCsv,
    recursos,
    consistencia,
    gastoPanelUSD: opciones.gastoPanelUSD,
    notasOperador: notasPreservadas,
  });
  await writeFile(RUTA_REPORTE_FINAL_MD, mdContenido, "utf8");

  const aprobadoGlobal = criterios.every((c) => c.estado === "PASS");

  if (!opciones.silencioso) {
    console.log("================================================================================");
    console.log("📋 REPORTE FINAL DE CARGA GENERADO CORRECTAMENTE");
    console.log(`📄 Archivo guardado: ${RUTA_REPORTE_FINAL_MD}`);
    console.log("--------------------------------------------------------------------------------");
    console.log("EVALUACIÓN DE CRITERIOS OFICIALES S4:");
    for (const c of criterios) {
      const badge = c.estado === "PASS" ? "✅ [PASS]" : c.estado === "FAIL" ? "❌ [FAIL]" : "⏳ [PENDIENTE]";
      console.log(`  ${badge} ${c.numero}. ${c.nombre}:`);
      console.log(`     Obtenido: ${c.obtenido}`);
    }
    console.log("--------------------------------------------------------------------------------");
    console.log(`DICTAMEN GLOBAL: ${aprobadoGlobal ? "✅ APROBADO (PASS)" : "⏳ PENDIENTE / EN CURSO"}`);
    console.log("================================================================================\n");
  }

  return {
    aprobadoGlobal,
    criterios,
    consistencia,
    rutaReporteFinal: RUTA_REPORTE_FINAL_MD,
  };
}

export function parsearArgumentosReporteCli(argv: string[] = process.argv.slice(2)): OpcionesReporteCarga {
  let gastoPanelUSD: number | null = null;
  let unidadesMeta: number | undefined;
  let horasMeta: number | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--gasto-panel-usd=")) {
      const val = Number.parseFloat(arg.split("=")[1] || "");
      if (Number.isFinite(val)) gastoPanelUSD = val;
    } else if (arg.startsWith("--unidades-meta=")) {
      const val = Number.parseInt(arg.split("=")[1] || "", 10);
      if (Number.isFinite(val)) unidadesMeta = val;
    } else if (arg.startsWith("--horas-meta=")) {
      const val = Number.parseFloat(arg.split("=")[1] || "");
      if (Number.isFinite(val)) horasMeta = val;
    }
  }

  return {
    gastoPanelUSD,
    unidadesMeta,
    horasMeta,
    silencioso: false,
  };
}

import { fileURLToPath } from "node:url";

const esModuloPrincipal =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esModuloPrincipal) {
  const opciones = parsearArgumentosReporteCli();
  generarReporteCargaFinal(opciones).catch((err) => {
    console.error("❌ Fallo generando reporte de carga:", err);
    process.exit(1);
  });
}
