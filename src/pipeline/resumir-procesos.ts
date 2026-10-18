/**
 * Pipeline del Agente 2 "resumidor" (src/pipeline/resumir-procesos.ts).
 *
 * Lee los procesos clasificados como "si" (y opcionalmente "dudoso") de
 * data/entregas/<fecha>/aptos.json, consulta sus fichas verificadas e invoca
 * al agente_resumidor con:
 * - Guarda de créditos (máx 5 por defecto, configurable con --max o --completo).
 * - Concurrencia controlada (2).
 * - Reintentos con backoff exponencial.
 * - Registro de tokens en logs/tokens.jsonl y trazas en LangSmith.
 * - Aislamiento de errores por proceso.
 * - Ordenamiento final por diasRestantes ascendente.
 * - Guardado en data/entregas/<fecha>/resumenes.json.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { leerFechaPrueba, type ModoEjecucion } from "../config/entorno.js";
import { fechaHoy } from "../datos/socrata.js";
import { registrarCosto } from "../cost.js";
import { MODEL_NAME } from "../llm.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { configEjecucion } from "../trazas.js";
import {
  agenteResumidor,
  aplicarGuardasResumen,
  NOMBRE_AGENTE_RESUMIDOR,
  type ProcesoResumido,
  type ResumenProceso,
} from "../agentes/resumidor.js";
import {
  construirFichaProceso,
  registrarCandidatosEnFicha,
  type AnexoCompleto,
  type FichaProceso,
} from "../herramientas/obtener-ficha-proceso.js";
import { obtenerCandidatoPorId } from "../herramientas/filtro-basico.js";
import type { Candidato } from "../filtro/prefiltro.js";

export interface OpcionesResumidor {
  maxProcesos?: number;
  completo?: boolean;
  incluirDudosos?: boolean;
  concurrencia?: number;
  fecha?: string;
  /** Configuración de ejecución padre (para anidar trazas en LangSmith). */
  parentConfig?: RunnableConfig;
}

export interface ItemResumenEntrega extends ProcesoResumido {
  diasRestantes: number | null;
  urlProceso: string | null;
  anexosUrls?: Array<{ nombre: string; urlDescarga: string }>;
}

export interface EntregaResumenes {
  fecha: string;
  modo: ModoEjecucion;
  totalAptosEncontrados: number;
  totalProcesados: number;
  tokens: {
    entrada: number;
    salida: number;
    total: number;
  };
  resumenes: ItemResumenEntrega[];
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

export async function resumirProcesosAptos(
  opciones: OpcionesResumidor = {},
): Promise<EntregaResumenes> {
  const fechaPrueba = leerFechaPrueba();
  const fecha = opciones.fecha ?? fechaPrueba ?? fechaHoy();
  const modo: ModoEjecucion = fechaPrueba ? "prueba" : "produccion";

  const rutaAptos = path.resolve(process.cwd(), "data", "entregas", fecha, "aptos.json");
  let rawAptos: string;
  try {
    rawAptos = await readFile(rutaAptos, "utf8");
  } catch {
    throw new Error(
      `No se encontró el archivo de aptos en "${rutaAptos}". Ejecuta primero 'pnpm filtrar' para la fecha ${fecha}.`,
    );
  }

  const datosAptos = JSON.parse(rawAptos);
  const itemsAptos: any[] = Array.isArray(datosAptos.resultados) ? datosAptos.resultados : [];

  // Filtrar aptoPyme === "si" (y "dudoso" si se solicita)
  const seleccionados = itemsAptos.filter((r) => {
    if (r.aptoPyme === "si") return true;
    if (opciones.incluirDudosos && r.aptoPyme === "dudoso") return true;
    return false;
  });

  const totalAptosEncontrados = seleccionados.length;
  if (totalAptosEncontrados === 0) {
    console.log(`[resumidor] No se encontraron procesos aptos para resumir en ${fecha}.`);
    const entregaVacia: EntregaResumenes = {
      fecha,
      modo,
      totalAptosEncontrados: 0,
      totalProcesados: 0,
      tokens: { entrada: 0, salida: 0, total: 0 },
      resumenes: [],
    };
    await guardarResumenes(fecha, entregaVacia);
    return entregaVacia;
  }

  // Tope de procesos: por defecto 5; si se especifica --completo toma todos
  let limite = opciones.completo ? totalAptosEncontrados : (opciones.maxProcesos ?? 5);
  limite = Math.min(limite, totalAptosEncontrados);
  const aProcesar = seleccionados.slice(0, limite);
  const concurrencia = opciones.concurrencia ?? 2;

  console.log(
    `[resumidor] Iniciando resúmenes para fecha ${fecha} (${modo}): ` +
      `procesando ${aProcesar.length} de ${totalAptosEncontrados} aptos disponibles. Concurrencia: ${concurrencia}.`,
  );

  const tokensTotales = { entrada: 0, salida: 0, total: 0 };

  async function procesarUnProceso(
    itemApto: any,
  ): Promise<{ item: ItemResumenEntrega; tokens: { entrada: number; salida: number; total: number } }> {
    const id: string = itemApto.id;
    const tokensItem = { entrada: 0, salida: 0, total: 0 };

    // 1. Obtener candidato completo (desde caché de Socrata o del registro de aptos)
    let candidato: Candidato | undefined = await obtenerCandidatoPorId(id);
    if (!candidato && itemApto.proceso) {
      candidato = itemApto.proceso as Candidato;
    }
    if (!candidato) {
      throw new Error(`No se pudo resolver la información del candidato para el ID "${id}".`);
    }

    // Registrar en memoria para que la tool obtener_ficha_proceso lo encuentre de inmediato
    registrarCandidatosEnFicha([candidato]);

    // 2. Construir la ficha verificada en código
    const { ficha, anexosCompletos } = await construirFichaProceso(candidato, fecha);

    // 3. Invocar al agente con reintentos y aislamiento de fallos
    let respuestaAgente: ResumenProceso | null = null;
    let ultimoError: unknown = null;

    for (let intento = 1; intento <= 3; intento++) {
      try {
        const config = configEjecucion(
          {
            runName: `resumidor:${id}${intento > 1 ? `:reintento-${intento}` : ""}`,
            tags: ["secop", "agente:resumidor"],
            metadata: { fecha, id, intento },
          },
          opciones.parentConfig,
        );

        const promptUsuario =
          `Prepara la ficha breve y honesta del proceso con id "${id}". ` +
          `Llama a obtener_ficha_proceso con ese id y genera el resumen, alertas, verificaciones y comentario de anexos.`;

        const res = await agenteResumidor.invoke(
          {
            messages: [{ role: "user", content: promptUsuario }],
          },
          config,
        );

        // Registro de tokens
        if (Array.isArray(res.messages)) {
          for (const msg of res.messages) {
            if (AIMessage.isInstance(msg) && msg.usage_metadata) {
              const reg = await registrarCosto(NOMBRE_AGENTE_RESUMIDOR, MODEL_NAME, msg);
              tokensItem.entrada += reg.tokens_entrada;
              tokensItem.salida += reg.tokens_salida;
              tokensItem.total += reg.tokens_total;
            }
          }
        }

        const estructurada = res.structuredResponse as ResumenProceso | undefined;
        if (!estructurada || typeof estructurada.resumen !== "string") {
          throw new Error("El modelo no generó la estructura ResumenProceso esperada.");
        }

        respuestaAgente = estructurada;
        break;
      } catch (err) {
        ultimoError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[resumidor] Error en proceso ${id} (intento ${intento}): ${msg}`);
        if (intento < 3) {
          await esperar(1500 * intento);
        }
      }
    }

    if (!respuestaAgente) {
      console.error(`[resumidor] Fallaron todos los intentos para el proceso ${id}. Generando fallback seguro.`);
      const fallback: ItemResumenEntrega = {
        id,
        ficha,
        resumen: `No fue posible generar el resumen automatizado por error de comunicación con el modelo: ${
          ultimoError instanceof Error ? ultimoError.message : String(ultimoError)
        }`,
        alertasParaPyme: [
          {
            alerta: "Resumen automático no disponible temporalmente",
            basadoEn: "id",
          },
        ],
        verificarEnElPliego: ["Consultar el pliego oficial en SECOP II."],
        comentarioAnexos: "Sin evaluación de anexos.",
        advertencias: ["fallback_por_error_modelo"],
        diasRestantes: ficha.diasRestantes,
        urlProceso: candidato.url,
      };
      return { item: fallback, tokens: tokensItem };
    }

    // 4. Aplicar guardas de código (auditoría de basadoEn y números de 6+ dígitos)
    const procesoConGuardas = aplicarGuardasResumen(ficha, respuestaAgente);

    // 5. Estructurar entrega individual
    const anexosUrls = anexosCompletos
      .filter((a) => Boolean(a.urlDescarga))
      .map((a) => ({ nombre: a.nombre, urlDescarga: a.urlDescarga! }));

    const itemFinal: ItemResumenEntrega = {
      ...procesoConGuardas,
      diasRestantes: ficha.diasRestantes,
      urlProceso: candidato.url,
      anexosUrls: anexosUrls.length > 0 ? anexosUrls : undefined,
    };

    return { item: itemFinal, tokens: tokensItem };
  }

  // Ejecución concurrente
  const resultados = await ejecutarConConcurrencia(aProcesar, concurrencia, (item) =>
    procesarUnProceso(item),
  );

  const listaResumenes: ItemResumenEntrega[] = [];
  for (const r of resultados) {
    listaResumenes.push(r.item);
    tokensTotales.entrada += r.tokens.entrada;
    tokensTotales.salida += r.tokens.salida;
    tokensTotales.total += r.tokens.total;
  }

  // Ordenar por diasRestantes ascendente (plazos más urgentes primero; nulls al final)
  listaResumenes.sort((a, b) => {
    if (a.diasRestantes === null && b.diasRestantes === null) return 0;
    if (a.diasRestantes === null) return 1;
    if (b.diasRestantes === null) return -1;
    return a.diasRestantes - b.diasRestantes;
  });

  const entrega: EntregaResumenes = {
    fecha,
    modo,
    totalAptosEncontrados,
    totalProcesados: listaResumenes.length,
    tokens: tokensTotales,
    resumenes: listaResumenes,
  };

  await guardarResumenes(fecha, entrega);
  return entrega;
}

async function guardarResumenes(fecha: string, entrega: EntregaResumenes): Promise<void> {
  const dir = path.resolve(process.cwd(), "data", "entregas", fecha);
  await mkdir(dir, { recursive: true });
  const ruta = path.join(dir, "resumenes.json");
  await writeFile(ruta, JSON.stringify(entrega, null, 2), "utf8");
  console.log(`[resumidor] Resúmenes guardados en "${ruta}".`);
}
