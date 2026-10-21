/**
 * Pipeline del Agente 3 "documentos" (src/pipeline/armar-documentos.ts).
 *
 * Arquitectura optimizada por costo:
 * 1. La lista de documentos se construye determinísticamente en código (catálogo + deduplicación con anexos).
 * 2. Si la ficha NO tiene anexos indexados, se omite la llamada al LLM (costo = $0, 0 tokens) a menos que
 *    se pase la bandera --siempre-agente.
 * 3. Si la ficha tiene anexos (o si se activa --siempre-agente), el modelo se invoca para devolver únicamente
 *    NotasDocumentos ({ anexos: [{ nombre, queEs }], observaciones }), reduciendo drásticamente el consumo de tokens.
 * 4. Guarda de créditos (máx 5 por defecto, configurable con --max o --completo).
 * 5. Concurrencia controlada (2).
 * 6. Registro de tokens con metadatos completos en logs/tokens.jsonl y trazas en LangSmith.
 * 7. Guardado en data/entregas/<fecha>/documentos.json.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { leerFechaPrueba, type ModoEjecucion } from "../config/entorno.js";
import { fechaHoy } from "../datos/socrata.js";
import { registrarCosto, ejecutarConContextoTokens } from "../cost.js";
import { MODEL_NAME } from "../llm.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { configEjecucion } from "../trazas.js";
import {
  agenteDocumentos,
  construirListaDocumentosDeterminista,
  AVISO_FIJO_ORIENTATIVO,
  NOMBRE_AGENTE_DOCUMENTOS,
  type ItemDocumento,
  type NotasDocumentos,
} from "../agentes/documentos.js";
import { filtrarDocumentosCatalogo } from "../herramientas/armar-lista-documentos.js";
import type { EntregaResumenes, ItemResumenEntrega } from "./resumir-procesos.js";

export interface OpcionesDocumentos {
  maxProcesos?: number;
  completo?: boolean;
  concurrencia?: number;
  fecha?: string;
  siempreAgente?: boolean;
  /** Configuración de ejecución padre (para anidar trazas en LangSmith). */
  parentConfig?: RunnableConfig;
}

export interface ProcesoConDocumentos {
  id: string;
  avisoOficial: string;
  items: ItemDocumento[];
  observacionGeneral: string | null;
  advertencias: string[];
  procesoInfo: {
    modalidad: string;
    tipoDeContrato: string;
    valorCOP: number | null;
    diasRestantes: number | null;
    urlProceso: string | null;
  };
}

export interface EntregaDocumentos {
  fecha: string;
  modo: ModoEjecucion;
  avisoOficial: string;
  totalResumenesDisponibles: number;
  totalProcesados: number;
  tokens: {
    entrada: number;
    salida: number;
    total: number;
  };
  documentosPorProceso: ProcesoConDocumentos[];
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ejecutarConConcurrencia<T, R>(
  elementos: T[],
  limite: number,
  fn: (elem: T, index: number) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = new Array(elementos.length);
  let indiceActual = 0;

  async function trabajador(): Promise<void> {
    while (true) {
      const idx = indiceActual++;
      if (idx >= elementos.length) break;
      resultados[idx] = await fn(elementos[idx], idx);
    }
  }

  const trabajadores = Array.from(
    { length: Math.min(limite, elementos.length) },
    () => trabajador(),
  );
  await Promise.all(trabajadores);
  return resultados;
}

export async function armarDocumentosParaProcesos(
  opciones: OpcionesDocumentos = {},
): Promise<EntregaDocumentos> {
  const fechaPrueba = leerFechaPrueba();
  const fecha = opciones.fecha ?? fechaPrueba ?? fechaHoy();
  const modo: ModoEjecucion = fechaPrueba ? "prueba" : "produccion";

  const rutaResumenes = path.resolve(process.cwd(), "data", "entregas", fecha, "resumenes.json");
  let rawResumenes: string;
  try {
    rawResumenes = await readFile(rutaResumenes, "utf8");
  } catch {
    throw new Error(
      `No se encontró el archivo de resúmenes en "${rutaResumenes}". Ejecuta primero 'pnpm resumir' para la fecha ${fecha}.`,
    );
  }

  const datosResumenes: EntregaResumenes = JSON.parse(rawResumenes);
  const itemsResumen: ItemResumenEntrega[] = Array.isArray(datosResumenes.resumenes)
    ? datosResumenes.resumenes
    : [];

  const totalResumenesDisponibles = itemsResumen.length;
  if (totalResumenesDisponibles === 0) {
    console.log(`[documentos] No se encontraron resúmenes para procesar en ${fecha}.`);
    const entregaVacia: EntregaDocumentos = {
      fecha,
      modo,
      avisoOficial: AVISO_FIJO_ORIENTATIVO,
      totalResumenesDisponibles: 0,
      totalProcesados: 0,
      tokens: { entrada: 0, salida: 0, total: 0 },
      documentosPorProceso: [],
    };
    await guardarDocumentos(fecha, entregaVacia);
    return entregaVacia;
  }

  let limite = opciones.completo ? totalResumenesDisponibles : (opciones.maxProcesos ?? 5);
  limite = Math.min(limite, totalResumenesDisponibles);
  const aProcesar = itemsResumen.slice(0, limite);
  const concurrencia = opciones.concurrencia ?? 2;

  console.log(
    `[documentos] Iniciando estructuración de documentos para fecha ${fecha} (${modo}): ` +
      `procesando ${aProcesar.length} de ${totalResumenesDisponibles} resúmenes disponibles. Concurrencia: ${concurrencia}.`,
  );

  const tokensTotales = { entrada: 0, salida: 0, total: 0 };

  async function procesarUnResumen(
    resumenItem: ItemResumenEntrega,
  ): Promise<{ item: ProcesoConDocumentos; tokens: { entrada: number; salida: number; total: number } }> {
    const id = resumenItem.id;
    return ejecutarConContextoTokens({ procesoId: id, agente: NOMBRE_AGENTE_DOCUMENTOS }, async () => {
      const tokensItem = { entrada: 0, salida: 0, total: 0 };

    const modalidad = resumenItem.ficha?.modalidad ?? "Desconocida";
    const tipoDeContrato = resumenItem.ficha?.tipoDeContrato ?? "Desconocido";
    const anexosLista = resumenItem.ficha?.anexos?.lista ?? [];
    const nombresAnexos = anexosLista.map((a) => a.nombre);

    // Consulta del catálogo de referencia por código
    const respuestaCatalogo = filtrarDocumentosCatalogo({ modalidad, tipoDeContrato });

    // Regla de ahorro de costos: Si no hay anexos y no se forzó el agente, resolver determinísticamente sin LLM
    if (anexosLista.length === 0 && !opciones.siempreAgente) {
      console.log(`[documentos:${id}] Sin anexos indexados. Construcción determinista en código (0 tokens consumidos).`);

      const lista = construirListaDocumentosDeterminista({
        id,
        anexosFicha: [],
        catalogoFiltrado: respuestaCatalogo.documentos,
        notasModelo: null,
      });

      const procesoFinal: ProcesoConDocumentos = {
        id,
        avisoOficial: AVISO_FIJO_ORIENTATIVO,
        items: lista.items,
        observacionGeneral: "Proceso sin anexos indexados aún en SECOP II; se aplica el catálogo general de referencia.",
        advertencias: lista.advertencias,
        procesoInfo: {
          modalidad,
          tipoDeContrato,
          valorCOP: resumenItem.ficha?.valorCOP ?? null,
          diasRestantes: resumenItem.diasRestantes,
          urlProceso: resumenItem.urlProceso,
        },
      };

      return { item: procesoFinal, tokens: tokensItem };
    }

    // Si hay anexos (o --siempre-agente activo), invocar al modelo para obtener NotasDocumentos
    const promptUsuario =
      `Proceso ID: "${id}"\n` +
      `Entidad: "${resumenItem.ficha?.entidad ?? "No especificada"}"\n` +
      `Modalidad: "${modalidad}"\n` +
      `Tipo de contrato: "${tipoDeContrato}"\n` +
      `Valor COP: ${resumenItem.ficha?.valorCOP ?? "No definido"}\n` +
      `Días restantes: ${resumenItem.diasRestantes ?? "No definido"}\n` +
      `Resumen del proceso:\n${resumenItem.resumen}\n\n` +
      (nombresAnexos.length > 0
        ? `Archivos anexos indexados en SECOP II (${nombresAnexos.length}):\n` +
          nombresAnexos.map((n) => `- ${n}`).join("\n") +
          `\n\n`
        : `Archivos anexos indexados en SECOP II: Sin anexos indexados aún.\n\n`) +
      `Instrucciones:\n` +
      `1. Llama UNA sola vez a armar_lista_documentos con modalidad="${modalidad}" y tipoDeContrato="${tipoDeContrato}".\n` +
      `2. Devuelve NotasDocumentos con queEs para cada anexo y una observación orientativa breve para la pyme.\n` +
      `3. Recuerda: nadie ha leído el pliego oficial. Nada es obligatorio ni asesoría legal.`;

    let notasModelo: NotasDocumentos | null = null;
    let ultimoError: unknown = null;

    for (let intento = 1; intento <= 3; intento++) {
      try {
        const config = configEjecucion(
          {
            runName: `documentos:${id}${intento > 1 ? `:reintento-${intento}` : ""}`,
            tags: ["secop", "agente:documentos"],
            metadata: { fecha, id, intento },
          },
          opciones.parentConfig,
        );

        const res = await agenteDocumentos.invoke(
          {
            messages: [{ role: "user", content: promptUsuario }],
          },
          config,
        );

        if (Array.isArray(res.messages)) {
          for (const msg of res.messages) {
            if (AIMessage.isInstance(msg) && msg.usage_metadata) {
              const reg = await registrarCosto(NOMBRE_AGENTE_DOCUMENTOS, MODEL_NAME, msg);
              tokensItem.entrada += reg.tokens_entrada;
              tokensItem.salida += reg.tokens_salida;
              tokensItem.total += reg.tokens_total;
            }
          }
        }

        const estructurada = res.structuredResponse as NotasDocumentos | undefined;
        if (!estructurada || !Array.isArray(estructurada.anexos)) {
          throw new Error("El modelo no generó la estructura NotasDocumentos esperada.");
        }

        notasModelo = estructurada;
        break;
      } catch (err) {
        ultimoError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[documentos] Error en proceso ${id} (intento ${intento}): ${msg}`);
        if (intento < 3) {
          await esperar(1500 * intento);
        }
      }
    }

    if (!notasModelo) {
      console.warn(`[documentos:${id}] Fallaron los intentos del modelo (${ultimoError instanceof Error ? ultimoError.message : String(ultimoError)}). Resolviendo determinísticamente.`);
    }

    // Construcción determinista combinando catálogo, deduplicación y notas del modelo
    const listaFinal = construirListaDocumentosDeterminista({
      id,
      anexosFicha: anexosLista,
      catalogoFiltrado: respuestaCatalogo.documentos,
      notasModelo,
    });

    const procesoFinal: ProcesoConDocumentos = {
      id,
      avisoOficial: AVISO_FIJO_ORIENTATIVO,
      items: listaFinal.items,
      observacionGeneral: listaFinal.observacionGeneral,
      advertencias: listaFinal.advertencias,
      procesoInfo: {
        modalidad,
        tipoDeContrato,
        valorCOP: resumenItem.ficha?.valorCOP ?? null,
        diasRestantes: resumenItem.diasRestantes,
        urlProceso: resumenItem.urlProceso,
      },
    };

      return { item: procesoFinal, tokens: tokensItem };
    });
  }

  const resultados = await ejecutarConConcurrencia(aProcesar, concurrencia, (item) =>
    procesarUnResumen(item),
  );

  const listaDocumentos: ProcesoConDocumentos[] = [];
  for (const r of resultados) {
    listaDocumentos.push(r.item);
    tokensTotales.entrada += r.tokens.entrada;
    tokensTotales.salida += r.tokens.salida;
    tokensTotales.total += r.tokens.total;
  }

  const entrega: EntregaDocumentos = {
    fecha,
    modo,
    avisoOficial: AVISO_FIJO_ORIENTATIVO,
    totalResumenesDisponibles,
    totalProcesados: listaDocumentos.length,
    tokens: tokensTotales,
    documentosPorProceso: listaDocumentos,
  };

  await guardarDocumentos(fecha, entrega);
  return entrega;
}

async function guardarDocumentos(fecha: string, entrega: EntregaDocumentos): Promise<void> {
  const dir = path.resolve(process.cwd(), "data", "entregas", fecha);
  await mkdir(dir, { recursive: true });
  const ruta = path.join(dir, "documentos.json");
  await writeFile(ruta, JSON.stringify(entrega, null, 2), "utf8");
  console.log(`[documentos] Documentos guardados en "${ruta}".`);
}
