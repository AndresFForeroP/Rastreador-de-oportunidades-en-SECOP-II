/**
 * Orquestador principal LangGraph: Flujo multi-agente diario de SECOP II.
 *
 * Nodos del grafo:
 * 1. descargar_y_prefiltrar (Código): descarga procesos de HOY y aplica pre-filtro determinista.
 * 2. filtrar_pymes (Agente 1): clasifica candidatos viables en páginas con concurrencia 2.
 * 3. resumir_procesos (Agente 2): genera fichas verificadas para procesos aptos (y dudosos si aplica).
 * 4. armar_documentos (Agente 3): elabora la lista orientativa de documentos requeridos.
 * 5. ensamblar_reporte (Código): consolida estadísticas, fichas y documentos en JSON y Markdown.
 *
 * Soporta bandera --reanudar para saltar etapas ya completadas en disco (data/entregas/<fecha>/).
 * Forwardea 'config' para que LangSmith registre la jerarquía completa de ejecuciones.
 * Aísla errores por ítem en el canal acumulativo 'errores' sin detener el grafo.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { StateGraph, START, END } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { EsquemaEstadoGrafo, type EstadoGrafo } from "./state.js";
import { descargarHoy } from "../datos/socrata.js";
import { prefiltrar } from "../filtro/prefiltro.js";
import { cargarDatosMemoizados } from "../herramientas/filtro-basico.js";
import {
  filtrarPymes,
  type ResumenAptos,
} from "../pipeline/filtrar-pymes.js";
import {
  resumirProcesosAptos,
  type EntregaResumenes,
} from "../pipeline/resumir-procesos.js";
import {
  armarDocumentosParaProcesos,
  type EntregaDocumentos,
} from "../pipeline/armar-documentos.js";
import {
  guardarReportes,
  type DatosReporte,
} from "../reporte/generar-reporte.js";
import { leerRegistrosTokens } from "../cost.js";

/**
 * 1. Nodo: descargar_y_prefiltrar (Código)
 */
async function nodoDescargarYPrefiltrar(
  state: EstadoGrafo,
  _config?: RunnableConfig,
): Promise<Partial<EstadoGrafo>> {
  console.log(
    `[grafo:descargar_y_prefiltrar] Descargando procesos publicados para ${state.fecha} (modo: ${state.modo})...`,
  );
  const descarga = await descargarHoy();
  const resPrefiltro = await prefiltrar(descarga.filas);

  // Asegura la inicialización de la caché de filtro básico para el Agente 1
  await cargarDatosMemoizados();

  console.log(
    `[grafo:descargar_y_prefiltrar] Descargados: ${descarga.filas.length} | Descartados: ${
      descarga.filas.length - resPrefiltro.candidatos.length
    } | Candidatos viables: ${resPrefiltro.candidatos.length}`,
  );

  return {
    totalDescargados: descarga.filas.length,
    descartadosPorRegla: resPrefiltro.descartadosPorRegla,
    totalCandidatos: resPrefiltro.candidatos.length,
    candidatos: resPrefiltro.candidatos,
  };
}

/**
 * 2. Nodo: filtrar_pymes (Agente 1)
 */
async function nodoFiltrarPymes(
  state: EstadoGrafo,
  config?: RunnableConfig,
): Promise<Partial<EstadoGrafo>> {
  const rutaAptos = path.resolve(process.cwd(), "data", "entregas", state.fecha, "aptos.json");

  // Reanudar si ya existe en disco
  if (state.caps.reanudar) {
    try {
      const raw = await readFile(rutaAptos, "utf8");
      const entrega: ResumenAptos = JSON.parse(raw);
      console.log(
        `[grafo:filtrar_pymes] ⚡ Etapa reanudada desde "${rutaAptos}": ` +
          `${entrega.resultados.length} clasificaciones previas cargadas ($0 créditos consumidos).`,
      );
      return {
        clasificacionAptos: entrega.resultados,
        conteoClasificacion: {
          si: entrega.estadisticasClasificacion.si,
          no: entrega.estadisticasClasificacion.no,
          dudoso: entrega.estadisticasClasificacion.dudoso,
        },
      };
    } catch {
      console.log(`[grafo:filtrar_pymes] No existe entrega previa para reanudar. Ejecutando Agente 1...`);
    }
  }

  if (state.candidatos.length === 0) {
    console.log(`[grafo:filtrar_pymes] 0 candidatos disponibles; omitiendo Agente 1.`);
    return {
      clasificacionAptos: [],
      conteoClasificacion: { si: 0, no: 0, dudoso: 0 },
    };
  }

  const maxPaginas = state.caps.completo
    ? undefined
    : Math.max(1, Math.ceil((state.caps.max ?? 25) / 25));

  try {
    const entrega = await filtrarPymes({
      maxPaginas,
      concurrencia: 2,
      parentConfig: config,
    });

    return {
      clasificacionAptos: entrega.resultados,
      conteoClasificacion: {
        si: entrega.estadisticasClasificacion.si,
        no: entrega.estadisticasClasificacion.no,
        dudoso: entrega.estadisticasClasificacion.dudoso,
      },
    };
  } catch (err) {
    const errorMsg = `Error en Agente 1 (filtrar_pymes): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[grafo:filtrar_pymes] ${errorMsg}`);
    return {
      clasificacionAptos: [],
      conteoClasificacion: { si: 0, no: 0, dudoso: 0 },
      errores: [errorMsg],
    };
  }
}

/**
 * 3. Nodo: resumir_procesos (Agente 2)
 */
async function nodoResumirProcesos(
  state: EstadoGrafo,
  config?: RunnableConfig,
): Promise<Partial<EstadoGrafo>> {
  const rutaResumenes = path.resolve(process.cwd(), "data", "entregas", state.fecha, "resumenes.json");

  // Reanudar si ya existe en disco
  if (state.caps.reanudar) {
    try {
      const raw = await readFile(rutaResumenes, "utf8");
      const entrega: EntregaResumenes = JSON.parse(raw);
      console.log(
        `[grafo:resumir_procesos] ⚡ Etapa reanudada desde "${rutaResumenes}": ` +
          `${entrega.resumenes.length} resúmenes previos cargados ($0 créditos consumidos).`,
      );
      return {
        resumenes: entrega.resumenes,
      };
    } catch {
      console.log(`[grafo:resumir_procesos] No existe entrega previa para reanudar. Ejecutando Agente 2...`);
    }
  }

  const candidatosAptos = state.clasificacionAptos.filter((c) =>
    state.caps.incluirDudosos ? c.aptoPyme === "si" || c.aptoPyme === "dudoso" : c.aptoPyme === "si",
  );

  if (candidatosAptos.length === 0) {
    console.log(`[grafo:resumir_procesos] 0 procesos aptos identificados; omitiendo Agente 2.`);
    return {
      resumenes: [],
    };
  }

  try {
    const entrega = await resumirProcesosAptos({
      fecha: state.fecha,
      maxProcesos: state.caps.maxAptos ?? 5,
      completo: state.caps.completo,
      incluirDudosos: state.caps.incluirDudosos,
      concurrencia: 2,
      parentConfig: config,
    });

    return {
      resumenes: entrega.resumenes,
    };
  } catch (err) {
    const errorMsg = `Error en Agente 2 (resumir_procesos): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[grafo:resumir_procesos] ${errorMsg}`);
    return {
      resumenes: [],
      errores: [errorMsg],
    };
  }
}

/**
 * 4. Nodo: armar_documentos (Agente 3)
 */
async function nodoArmarDocumentos(
  state: EstadoGrafo,
  config?: RunnableConfig,
): Promise<Partial<EstadoGrafo>> {
  const rutaDocumentos = path.resolve(process.cwd(), "data", "entregas", state.fecha, "documentos.json");

  // Reanudar si ya existe en disco
  if (state.caps.reanudar) {
    try {
      const raw = await readFile(rutaDocumentos, "utf8");
      const entrega: EntregaDocumentos = JSON.parse(raw);
      console.log(
        `[grafo:armar_documentos] ⚡ Etapa reanudada desde "${rutaDocumentos}": ` +
          `${entrega.documentosPorProceso.length} procesos con documentos cargados ($0 créditos consumidos).`,
      );
      return {
        documentos: entrega.documentosPorProceso,
      };
    } catch {
      console.log(`[grafo:armar_documentos] No existe entrega previa para reanudar. Ejecutando Agente 3...`);
    }
  }

  if (state.resumenes.length === 0) {
    console.log(`[grafo:armar_documentos] 0 resúmenes disponibles; omitiendo Agente 3.`);
    return {
      documentos: [],
    };
  }

  try {
    const entrega = await armarDocumentosParaProcesos({
      fecha: state.fecha,
      maxProcesos: state.caps.maxAptos ?? 5,
      completo: state.caps.completo,
      concurrencia: 2,
      siempreAgente: state.caps.siempreAgente,
      parentConfig: config,
    });

    return {
      documentos: entrega.documentosPorProceso,
    };
  } catch (err) {
    const errorMsg = `Error en Agente 3 (armar_documentos): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[grafo:armar_documentos] ${errorMsg}`);
    return {
      documentos: [],
      errores: [errorMsg],
    };
  }
}

/**
 * 5. Nodo: ensamblar_reporte (Código)
 */
async function nodoEnsamblarReporte(
  state: EstadoGrafo,
  _config?: RunnableConfig,
): Promise<Partial<EstadoGrafo>> {
  console.log(`[grafo:ensamblar_reporte] Consolidando reporte final JSON y Markdown...`);

  // Extraer tokens totales acumulados para esta ejecución desde logs/tokens.jsonl
  const todosLosTokens = await leerRegistrosTokens();
  const hoyReal = new Date().toISOString().slice(0, 10);
  const registrosDelDia = todosLosTokens.filter(
    (r) => r.fecha.startsWith(state.fecha) || r.fecha.startsWith(hoyReal),
  );

  const tokensJornada = {
    entrada: registrosDelDia.reduce((acc, r) => acc + (r.tokens_entrada || 0), 0),
    salida: registrosDelDia.reduce((acc, r) => acc + (r.tokens_salida || 0), 0),
    total: registrosDelDia.reduce((acc, r) => acc + (r.tokens_total || 0), 0),
  };

  // Mapear cada resumen con su documento estructurado
  const mapaDocs = new Map(state.documentos.map((d) => [d.id, d]));

  const procesosReporte = state.resumenes.map((r) => {
    const docItem = mapaDocs.get(r.id);
    return {
      id: r.id,
      diasRestantes: r.diasRestantes,
      ficha: {
        nombre: r.ficha.nombre,
        entidad: r.ficha.entidad,
        departamento: r.ficha.departamento,
        ciudad: r.ficha.ciudad,
        modalidad: r.ficha.modalidad,
        tipoDeContrato: r.ficha.tipoDeContrato,
        valorCOP: r.ficha.valorCOP,
        fechaLimiteOfertas: r.ficha.fechaLimiteOfertas,
        duracion: r.ficha.duracion,
        lotes: r.ficha.lotes,
        urlProceso: r.urlProceso,
      },
      anexosUrls: r.anexosUrls ?? [],
      resumen: r.resumen,
      alertasParaPyme: r.alertasParaPyme,
      verificarEnElPliego: r.verificarEnElPliego,
      documentos: docItem?.items ?? [],
      observacionGeneralDoc: docItem?.observacionGeneral ?? null,
      advertenciasDoc: docItem?.advertencias ?? [],
    };
  });

  // Ordenar procesos por días restantes ascendente (plazos más urgentes primero)
  procesosReporte.sort((a, b) => {
    if (a.diasRestantes === null && b.diasRestantes === null) return 0;
    if (a.diasRestantes === null) return 1;
    if (b.diasRestantes === null) return -1;
    return a.diasRestantes - b.diasRestantes;
  });

  const datosReporte: DatosReporte = {
    fecha: state.fecha,
    modo: state.modo,
    fechaReferencia: state.fechaReferencia,
    totalDescargados: state.totalDescargados,
    descartadosPorRegla: state.descartadosPorRegla,
    totalCandidatos: state.totalCandidatos,
    conteoClasificacion: state.conteoClasificacion,
    totalProcesados: procesosReporte.length,
    errores: state.errores,
    tokensTotales: tokensJornada,
    procesos: procesosReporte,
  };

  const rutas = await guardarReportes(datosReporte);

  return {
    reporteRutas: rutas,
    tokensTotales: tokensJornada,
  };
}

/**
 * Construcción del grafo StateGraph con Zod y reducers.
 */
export const builder = new StateGraph(EsquemaEstadoGrafo)
  .addNode("descargar_y_prefiltrar", nodoDescargarYPrefiltrar)
  .addNode("filtrar_pymes", nodoFiltrarPymes)
  .addNode("resumir_procesos", nodoResumirProcesos)
  .addNode("armar_documentos", nodoArmarDocumentos)
  .addNode("ensamblar_reporte", nodoEnsamblarReporte)
  .addEdge(START, "descargar_y_prefiltrar")
  .addEdge("descargar_y_prefiltrar", "filtrar_pymes")
  .addEdge("filtrar_pymes", "resumir_procesos")
  .addEdge("resumir_procesos", "armar_documentos")
  .addEdge("armar_documentos", "ensamblar_reporte")
  .addEdge("ensamblar_reporte", END);

/** Grafo compilado listo para Studio y ejecución CLI */
export const graph = builder.compile();
