/**
 * Pipeline de filtrado con Agente 1 (filtrador).
 *
 * Flujo:
 *  (a) Obtiene totalPaginas llamando directamente a `obtenerPaginaFiltroBasico(1)`.
 *  (b) Invoca al agente una vez por página con contexto limpio ("Procesa la página N."),
 *      concurrencia de 2, reintentos con backoff exponencial.
 *  (c) Valida que cada id esperado de la página retorne exactamente una vez. Si hay
 *      discrepancias, reintenta una vez listando los ids faltantes. Si persisten, se
 *      registran como "dudoso" con razón "sin respuesta del modelo" (nunca se descartan).
 *  (d) Registra tokens de cada AIMessage en logs/tokens.jsonl mediante cost.ts.
 *  (e) Guarda data/entregas/<fecha>/aptos.json con todos los resultados y estadísticas.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import {
  agenteFiltrador,
  NOMBRE_AGENTE_FILTRADOR,
  type ClasificacionPyme,
  type ResultadoPagina,
} from "../agentes/filtrador.js";
import { MODEL_NAME } from "../llm.js";
import { registrarCosto } from "../cost.js";
import { fechaHoy } from "../datos/socrata.js";
import { leerFechaPrueba, modoEjecucion } from "../config/entorno.js";
import {
  obtenerPaginaFiltroBasico,
  type CandidatoHerramienta,
} from "../herramientas/filtro-basico.js";
import { configEjecucion, opcionesTraceable } from "../trazas.js";

export interface ResultadoProcesoApto extends ClasificacionPyme {
  proceso?: CandidatoHerramienta;
}

export interface ResumenAptos {
  fecha: string;
  modo: string;
  totalCandidatos: number;
  paginasProcesadas: number;
  totalPaginasDisponibles: number;
  estadisticasClasificacion: {
    si: number;
    no: number;
    dudoso: number;
    total: number;
  };
  tokens: {
    entrada: number;
    salida: number;
    total: number;
  };
  resultados: ResultadoProcesoApto[];
}

export interface OpcionesFiltrarPymes {
  /** Número máximo de páginas a procesar (por defecto 1 = 25 candidatos). */
  maxPaginas?: number;
  /** Concurrencia de llamadas al agente (por defecto 2). */
  concurrencia?: number;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ejecuta una lista de tareas con un tope de concurrencia fijo.
 */
async function ejecutarConConcurrencia<T, R>(
  items: T[],
  limite: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let siguienteIndice = 0;

  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguienteIndice < items.length) {
      const idx = siguienteIndice++;
      const item = items[idx];
      if (item !== undefined) {
        resultados[idx] = await fn(item);
      }
    }
  });

  await Promise.all(trabajadores);
  return resultados;
}

/**
 * Valida y alinea los resultados devueltos por el modelo contra los candidatos
 * esperados de la página.
 */
function validarResultadosPagina(
  esperados: CandidatoHerramienta[],
  devueltos: ClasificacionPyme[],
): { validos: ResultadoProcesoApto[]; faltantes: string[] } {
  const mapaEsperados = new Map(esperados.map((c) => [c.id, c]));
  const mapaResultados = new Map<string, ClasificacionPyme>();

  for (const item of devueltos) {
    if (mapaEsperados.has(item.id) && !mapaResultados.has(item.id)) {
      mapaResultados.set(item.id, item);
    }
  }

  const faltantes: string[] = [];
  const validos: ResultadoProcesoApto[] = [];

  for (const c of esperados) {
    const res = mapaResultados.get(c.id);
    if (res) {
      validos.push({ ...res, proceso: c });
    } else {
      faltantes.push(c.id);
    }
  }

  return { validos, faltantes };
}

/**
 * Invoca al agente filtrador para una página, registra tokens y aplica reintento
 * en caso de fallos de red o discrepancias en los IDs devueltos.
 */
async function procesarPaginaConReintentos(
  numeroPagina: number,
  fecha: string,
): Promise<{ resultados: ResultadoProcesoApto[]; tokens: { entrada: number; salida: number; total: number } }> {
  const paginaDatos = await obtenerPaginaFiltroBasico(numeroPagina);
  const esperados = paginaDatos.candidatos;

  const tokensAcumulados = { entrada: 0, salida: 0, total: 0 };

  async function invocar(mensajePrompt: string, intento: number): Promise<ResultadoPagina> {
    const config = configEjecucion({
      runName: `filtrador:pagina-${numeroPagina}${intento > 1 ? `:reintento-${intento}` : ""}`,
      tags: ["agente:filtrador"],
      metadata: { fecha, pagina: numeroPagina, intento },
    });

    const respuestaAgent = await agenteFiltrador.invoke(
      {
        messages: [{ role: "user", content: mensajePrompt }],
      },
      config,
    );

    // Registro de tokens de cada llamada real al modelo (con usage_metadata)
    if (Array.isArray(respuestaAgent.messages)) {
      for (const msg of respuestaAgent.messages) {
        if (AIMessage.isInstance(msg) && msg.usage_metadata) {
          const reg = await registrarCosto(NOMBRE_AGENTE_FILTRADOR, MODEL_NAME, msg);
          tokensAcumulados.entrada += reg.tokens_entrada;
          tokensAcumulados.salida += reg.tokens_salida;
          tokensAcumulados.total += reg.tokens_total;
        }
      }
    }

    const estructurada = respuestaAgent.structuredResponse as ResultadoPagina | undefined;
    if (!estructurada || !Array.isArray(estructurada.resultados)) {
      throw new Error(`El modelo no generó la salida estructurada esperada en la página ${numeroPagina}.`);
    }

    return estructurada;
  }

  // 1. Primer intento
  let respuesta: ResultadoPagina | null = null;
  let ultimoError: unknown = null;

  for (let intento = 1; intento <= 3; intento++) {
    try {
      respuesta = await invocar(`Procesa la página ${numeroPagina}.`, intento);
      break;
    } catch (err) {
      ultimoError = err;
      const mensaje = err instanceof Error ? err.message : String(err);
      console.warn(`[filtrador] Error al procesar página ${numeroPagina} (intento ${intento}): ${mensaje}`);
      if (intento < 3) {
        await esperar(1500 * intento);
      }
    }
  }

  if (!respuesta) {
    // Si los 3 intentos fallaron a nivel red/modelo, se registran como dudosos para no perderlos
    console.error(`[filtrador] Fallaron todos los intentos para la página ${numeroPagina}. Registrando como dudosos.`);
    const fallbacks: ResultadoProcesoApto[] = esperados.map((c) => ({
      id: c.id,
      aptoPyme: "dudoso",
      categoriaObjeto: "No clasificado",
      razon: "error en invocación del modelo",
      senales: ["error_modelo"],
      proceso: c,
    }));
    return { resultados: fallbacks, tokens: tokensAcumulados };
  }

  // 2. Validación de IDs devueltos contra IDs esperados
  let { validos, faltantes } = validarResultadosPagina(esperados, respuesta.resultados);

  // Si faltan IDs, se reintenta UNA sola vez señalando explícitamente los faltantes
  if (faltantes.length > 0) {
    console.warn(
      `[filtrador] Página ${numeroPagina}: faltaron ${faltantes.length} de ${esperados.length} IDs. Reintentando una vez...`,
    );
    try {
      const promptCorreccion =
        `En la respuesta anterior faltaron clasificar ${faltantes.length} procesos de la página ${numeroPagina}: ` +
        `[${faltantes.join(", ")}]. Por favor clasifica de nuevo la página completa devolviendo TODOS los ${esperados.length} procesos esperados.`;
      const reintento = await invocar(promptCorreccion, 4);
      const resCorreccion = validarResultadosPagina(esperados, reintento.resultados);
      validos = resCorreccion.validos;
      faltantes = resCorreccion.faltantes;
    } catch (err) {
      console.warn(`[filtrador] Falló el reintento de corrección de IDs para la página ${numeroPagina}:`, err);
    }
  }

  // 3. Si todavía persisten faltantes, se rellenan como "dudoso" (nunca se descartan silenciosamente)
  if (faltantes.length > 0) {
    console.warn(
      `[filtrador] Página ${numeroPagina}: persistieron ${faltantes.length} IDs sin responder. Marcándolos como 'dudoso'.`,
    );
    const faltantesSet = new Set(faltantes);
    for (const c of esperados) {
      if (faltantesSet.has(c.id)) {
        validos.push({
          id: c.id,
          aptoPyme: "dudoso",
          categoriaObjeto: "No clasificado",
          razon: "sin respuesta del modelo",
          senales: ["omision_modelo"],
          proceso: c,
        });
      }
    }
  }

  return { resultados: validos, tokens: tokensAcumulados };
}

async function filtrarPymesInterno(opciones: OpcionesFiltrarPymes = {}): Promise<ResumenAptos> {
  const fechaPrueba = leerFechaPrueba();
  const fecha = fechaPrueba ?? fechaHoy();
  const modo = modoEjecucion();

  const primeraPagina = await obtenerPaginaFiltroBasico(1);
  const totalPaginasDisponibles = primeraPagina.totalPaginas;
  const totalCandidatos = primeraPagina.totalCandidatos;

  if (totalCandidatos === 0) {
    console.log(`[filtrador] No hay candidatos para clasificar en la fecha ${fecha}.`);
    const resumenVacio: ResumenAptos = {
      fecha,
      modo,
      totalCandidatos: 0,
      paginasProcesadas: 0,
      totalPaginasDisponibles: 0,
      estadisticasClasificacion: { si: 0, no: 0, dudoso: 0, total: 0 },
      tokens: { entrada: 0, salida: 0, total: 0 },
      resultados: [],
    };
    await guardarAptos(fecha, resumenVacio);
    return resumenVacio;
  }

  const limitePaginas = opciones.maxPaginas ?? 1;
  const paginasAProcesar = Math.min(totalPaginasDisponibles, limitePaginas);
  const concurrencia = opciones.concurrencia ?? 2;

  console.log(
    `[filtrador] Iniciando clasificación para fecha ${fecha} (${modo}): ` +
      `${paginasAProcesar} de ${totalPaginasDisponibles} páginas (${totalCandidatos} candidatos disponibles). ` +
      `Concurrencia: ${concurrencia}.`,
  );

  const listaPaginas = Array.from({ length: paginasAProcesar }, (_, i) => i + 1);

  const resultadosPorPagina = await ejecutarConConcurrencia(listaPaginas, concurrencia, (numPagina) =>
    procesarPaginaConReintentos(numPagina, fecha),
  );

  const todosResultados: ResultadoProcesoApto[] = [];
  const tokensTotales = { entrada: 0, salida: 0, total: 0 };

  for (const res of resultadosPorPagina) {
    todosResultados.push(...res.resultados);
    tokensTotales.entrada += res.tokens.entrada;
    tokensTotales.salida += res.tokens.salida;
    tokensTotales.total += res.tokens.total;
  }

  const stats = {
    si: todosResultados.filter((r) => r.aptoPyme === "si").length,
    no: todosResultados.filter((r) => r.aptoPyme === "no").length,
    dudoso: todosResultados.filter((r) => r.aptoPyme === "dudoso").length,
    total: todosResultados.length,
  };

  const resumen: ResumenAptos = {
    fecha,
    modo,
    totalCandidatos,
    paginasProcesadas: paginasAProcesar,
    totalPaginasDisponibles,
    estadisticasClasificacion: stats,
    tokens: tokensTotales,
    resultados: todosResultados,
  };

  await guardarAptos(fecha, resumen);
  return resumen;
}

async function guardarAptos(fecha: string, resumen: ResumenAptos): Promise<void> {
  const dir = path.resolve(process.cwd(), "data", "entregas", fecha);
  await mkdir(dir, { recursive: true });
  const archivo = path.join(dir, "aptos.json");
  await writeFile(archivo, JSON.stringify(resumen, null, 2), "utf8");
  console.log(`[filtrador] Resultados guardados en ${archivo}`);
}

/**
 * Runner principal del Agente 1 (filtrador). Trazado en LangSmith.
 */
export const filtrarPymes = traceable(
  filtrarPymesInterno,
  opcionesTraceable<typeof filtrarPymesInterno>({
    runName: "filtrar_pymes",
    tags: ["pipeline", "etapa2"],
    processOutputs: (r) => ({
      fecha: r.fecha,
      modo: r.modo,
      total_candidatos: r.totalCandidatos,
      paginas_procesadas: r.paginasProcesadas,
      total_paginas_disponibles: r.totalPaginasDisponibles,
      estadisticas: r.estadisticasClasificacion,
      tokens_totales: r.tokens.total,
    }),
  }),
);
