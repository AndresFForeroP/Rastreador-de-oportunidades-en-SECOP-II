/**
 * Herramienta CLI: Evaluación del Agente 1 (filtrador) contra Ground Truth humano (S3-4).
 *
 * Utiliza inyección de dependencias para alimentar al agente con el snapshot exacto
 * de candidatos evaluados por el usuario, sin modificar el prompt del sistema ni el
 * comportamiento de producción.
 *
 * Uso:
 *   pnpm exec tsx src/tools/evaluar.ts [--repeticiones=N] [--sin-bloque-b]
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import {
  crearAgenteFiltrador,
  NOMBRE_AGENTE_FILTRADOR,
  type ClasificacionPyme,
  type ResultadoPagina,
} from "../agentes/filtrador.js";
import { PROMPT_SISTEMA_FILTRADOR } from "../agentes/prompts/filtrador.js";
import { MODEL_NAME } from "../llm.js";
import { ejecutarConContextoTokens, registrarCosto } from "../cost.js";
import {
  crearHerramientaFiltroBasico,
  TAMANO_PAGINA_FILTRO,
  type CandidatoHerramienta,
  type FuenteCandidatos,
  type RespuestaFiltroBasico,
} from "../herramientas/filtro-basico.js";
import {
  calcularCostoEstimado,
  finalizarEjecucion,
  iniciarEjecucion,
} from "../pruebas/registro-ejecuciones.js";
import {
  dirResultadoEvaluacionLineaBase,
  dirResultadoEvaluacionTimestamp,
  dirResultadosEvaluacion,
  rutaCasosSinEtiquetar,
  rutaClavesPrivadas,
} from "../pruebas/rutas.js";
import type { CasoSinEtiquetar, ClavePrivadaCaso } from "./evaluacion-preparar.js";
import type { ReglaDescarte } from "../filtro/prefiltro.js";

interface Argumentos {
  repeticiones: number;
  sinBloqueB: boolean;
}

function parsearArgumentos(): Argumentos {
  const args = process.argv.slice(2);
  let repeticiones = 1;
  let sinBloqueB = false;

  for (const arg of args) {
    if (arg.startsWith("--repeticiones=")) {
      const val = Number.parseInt(arg.slice(15), 10);
      if (!Number.isNaN(val) && val > 0) repeticiones = val;
    } else if (arg === "--sin-bloque-b") {
      sinBloqueB = true;
    }
  }

  return { repeticiones, sinBloqueB };
}

interface CasoFusionado {
  caso: number;
  id: string;
  nombre: string;
  descripcion: string;
  entidad: string;
  departamento: string;
  modalidad: string;
  tipoDeContrato: string;
  valorCOP: number | null;
  fechaLimite: string | null;
  etiquetaHumana: "si" | "no" | "dudoso";
  notaHumana: string;
  bloque: "A" | "B";
  reglaDescarte: ReglaDescarte | null;
  snapshotCompleto: unknown;
}

interface PrediccionModelo {
  id: string;
  aptoPyme: "si" | "no" | "dudoso";
  categoriaObjeto: string;
  razon: string;
  senales: string[];
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function validarCasosEtiquetados(): Promise<{
  casos: CasoSinEtiquetar[];
  claves: Record<string, ClavePrivadaCaso>;
}> {
  const rutaCasos = rutaCasosSinEtiquetar();
  const rutaClaves = rutaClavesPrivadas();

  const [rawCasos, rawClaves] = await Promise.all([
    readFile(rutaCasos, "utf8"),
    readFile(rutaClaves, "utf8"),
  ]);

  const casos = JSON.parse(rawCasos) as CasoSinEtiquetar[];
  const claves = JSON.parse(rawClaves) as Record<string, ClavePrivadaCaso>;

  const pendientes = casos.filter(
    (c) =>
      !c.etiqueta ||
      !["si", "no", "dudoso"].includes((c.etiqueta as string).trim().toLowerCase()),
  );
  if (pendientes.length > 0) {
    throw new Error(
      `El set de evaluación tiene ${pendientes.length} casos sin etiquetar o con valor no válido. ` +
        `Ejecuta 'pnpm evaluar:validar' para verificar los detalles.`,
    );
  }

  return { casos, claves };
}

/**
 * Crea una fuente de candidatos inyectable para `crearHerramientaFiltroBasico`.
 */
function crearFuenteSnapshot(candidatos: CandidatoHerramienta[]): FuenteCandidatos {
  const totalCandidatos = candidatos.length;
  const totalPaginas = Math.ceil(totalCandidatos / TAMANO_PAGINA_FILTRO);

  return async (pagina: number): Promise<RespuestaFiltroBasico> => {
    if (pagina < 1 || pagina > totalPaginas) {
      return {
        pagina,
        totalPaginas,
        totalCandidatos,
        estadisticasPrefiltro: {
          modalidad_no_competitiva: 0,
          estado_cerrado: 0,
          tipo_contrato_excluido: 0,
          valor_supera_maximo: 0,
          oferta_vencida: 0,
          id_duplicado: 0,
        },
        candidatos: [],
        error: `Página ${pagina} fuera de rango. El rango válido es de 1 a ${totalPaginas}.`,
      };
    }

    const inicio = (pagina - 1) * TAMANO_PAGINA_FILTRO;
    const seleccion = candidatos.slice(inicio, inicio + TAMANO_PAGINA_FILTRO);

    return {
      pagina,
      totalPaginas,
      totalCandidatos,
      estadisticasPrefiltro: {
        modalidad_no_competitiva: 0,
        estado_cerrado: 0,
        tipo_contrato_excluido: 0,
        valor_supera_maximo: 0,
        oferta_vencida: 0,
        id_duplicado: 0,
      },
      candidatos: seleccion,
    };
  };
}

/**
 * Procesa una página de candidatos con el agente inyectado y manejo de reintentos.
 */
async function procesarPaginaEvaluacion(
  agente: ReturnType<typeof crearAgenteFiltrador>,
  numeroPagina: number,
  candidatosEsperados: CandidatoHerramienta[],
): Promise<PrediccionModelo[]> {
  const mapaEsperados = new Map(candidatosEsperados.map((c) => [c.id, c]));

  for (let intento = 1; intento <= 3; intento++) {
    try {
      const respuestaAgent = await agente.invoke({
        messages: [{ role: "user", content: `Procesa la página ${numeroPagina}.` }],
      });

      // Registro de tokens
      if (Array.isArray(respuestaAgent.messages)) {
        for (const msg of respuestaAgent.messages) {
          if (AIMessage.isInstance(msg) && msg.usage_metadata) {
            await registrarCosto(NOMBRE_AGENTE_FILTRADOR, MODEL_NAME, msg);
          }
        }
      }

      const estructurada = respuestaAgent.structuredResponse as ResultadoPagina | undefined;
      if (!estructurada || !Array.isArray(estructurada.resultados)) {
        throw new Error(`Salida estructurada inválida o ausente en la página ${numeroPagina}.`);
      }

      const resultadosMapeados: PrediccionModelo[] = [];
      const faltantes: string[] = [];
      const vistos = new Set<string>();

      for (const res of estructurada.resultados) {
        if (mapaEsperados.has(res.id) && !vistos.has(res.id)) {
          vistos.add(res.id);
          resultadosMapeados.push({
            id: res.id,
            aptoPyme: res.aptoPyme,
            categoriaObjeto: res.categoriaObjeto,
            razon: res.razon,
            senales: res.senales,
          });
        }
      }

      for (const esp of candidatosEsperados) {
        if (!vistos.has(esp.id)) faltantes.push(esp.id);
      }

      if (faltantes.length > 0 && intento < 3) {
        console.warn(`[evaluacion] Página ${numeroPagina}: faltaron ${faltantes.length} IDs en intento ${intento}. Reintentando...`);
        await esperar(1500 * intento);
        continue;
      }

      // Si quedaron faltantes en el último intento, completar con fallback dudoso
      for (const idFaltante of faltantes) {
        resultadosMapeados.push({
          id: idFaltante,
          aptoPyme: "dudoso",
          categoriaObjeto: "No clasificado",
          razon: "sin respuesta del modelo",
          senales: ["error_modelo"],
        });
      }

      return resultadosMapeados;
    } catch (err) {
      console.warn(`[evaluacion] Error en página ${numeroPagina} (intento ${intento}): ${err instanceof Error ? err.message : String(err)}`);
      if (intento < 3) {
        await esperar(2000 * intento);
      } else {
        // Fallback completo para la página
        return candidatosEsperados.map((c) => ({
          id: c.id,
          aptoPyme: "dudoso",
          categoriaObjeto: "No clasificado",
          razon: "falla persistente en invocación",
          senales: ["falla_red"],
        }));
      }
    }
  }

  return [];
}

async function existeDirectorio(ruta: string): Promise<boolean> {
  try {
    const s = await stat(ruta);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function evaluar(): Promise<void> {
  const config = parsearArgumentos();

  console.log("================================================================================");
  console.log("🔬 EVALUACIÓN CIENTÍFICA DEL AGENTE 1 CONTRA GROUND TRUTH (S3-4)");
  console.log(`Repeticiones: ${config.repeticiones} | Omitir Bloque B: ${config.sinBloqueB}`);
  console.log("================================================================================\n");

  // 1. Validar que el archivo esté debidamente etiquetado
  const { casos, claves } = await validarCasosEtiquetados();

  // 2. Fusionar casos con claves privadas
  const casosFusionados: CasoFusionado[] = casos.map((c) => {
    const clave = claves[String(c.caso)]!;
    return {
      caso: c.caso,
      id: clave.idDelProceso,
      nombre: c.nombre,
      descripcion: c.descripcion,
      entidad: c.entidad,
      departamento: c.departamento,
      modalidad: c.modalidad,
      tipoDeContrato: c.tipoDeContrato,
      valorCOP: c.valorCOP,
      fechaLimite: c.fechaLimite,
      etiquetaHumana: c.etiqueta.trim() as "si" | "no" | "dudoso",
      notaHumana: c.nota || "",
      bloque: clave.bloque,
      reglaDescarte: clave.reglaDescarte,
      snapshotCompleto: clave.snapshotCompleto,
    };
  });

  const bloqueA = casosFusionados.filter((c) => c.bloque === "A");
  const bloqueB = casosFusionados.filter((c) => c.bloque === "B");

  console.log(`📊 Conjunto preparado:`);
  console.log(`   • Bloque A (candidatos a evaluar con modelo): ${bloqueA.length} casos`);
  console.log(`   • Bloque B (auditoría prefiltro):             ${bloqueB.length} casos`);

  // 3. Preparar candidatos del Bloque A para la herramienta
  // Ordenamiento estable por id ascendente (idéntico a producción)
  const candidatosBloqueA: CandidatoHerramienta[] = bloqueA
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      nombre: c.nombre,
      descripcion: (c.descripcion || "").slice(0, 600),
      entidad: c.entidad,
      departamento: c.departamento,
      tipoDeContrato: c.tipoDeContrato,
      modalidad: c.modalidad,
      valor: c.valorCOP,
      fase: (c.snapshotCompleto as { fase?: string })?.fase || null,
    }));

  const totalPaginas = Math.ceil(candidatosBloqueA.length / TAMANO_PAGINA_FILTRO);

  // Inyección de dependencias: crear tool y agente con fuente snapshot
  const fuenteSnapshot = crearFuenteSnapshot(candidatosBloqueA);
  const herramientaInyectada = crearHerramientaFiltroBasico(fuenteSnapshot);
  const agenteInyectado = crearAgenteFiltrador(herramientaInyectada);

  // Registro en el libro mayor
  const ejecucionId = await iniciarEjecucion({
    tipo: "evaluacion",
    modo: "evaluacion",
    fechaDatos: "benchmark-humano",
    parametros: {
      repeticiones: config.repeticiones,
      sinBloqueB: config.sinBloqueB,
      totalCasosBloqueA: bloqueA.length,
      totalCasosBloqueB: bloqueB.length,
    },
  });

  console.log(`\n🆔 ID de Ejecución registrado: ${ejecucionId}\n`);

  // Estructura para registrar corridas: casoId -> lista de predicciones
  const prediccionesPorCorrida: Map<number, PrediccionModelo[][]> = new Map();
  // mapa id -> CasoFusionado
  const mapaBloqueAPorId = new Map(bloqueA.map((c) => [c.id, c]));

  let totalTokensEntrada = 0;
  let totalTokensSalida = 0;
  let totalTokensAcumulados = 0;

  // 4. Ejecución del modelo en Bloque A con contexto de tokens
  await ejecutarConContextoTokens(
    {
      ejecucionId,
      agente: NOMBRE_AGENTE_FILTRADOR,
      tipo: "evaluacion",
    },
    async () => {
      for (let r = 1; r <= config.repeticiones; r++) {
        console.log(`🔄 Ejecutando corrida ${r}/${config.repeticiones}...`);
        const prediccionesCorrida: PrediccionModelo[] = [];

        for (let p = 1; p <= totalPaginas; p++) {
          const inicio = (p - 1) * TAMANO_PAGINA_FILTRO;
          const esperadosPagina = candidatosBloqueA.slice(inicio, inicio + TAMANO_PAGINA_FILTRO);
          console.log(`   [Página ${p}/${totalPaginas}] Evaluando ${esperadosPagina.length} candidatos...`);

          const preds = await procesarPaginaEvaluacion(agenteInyectado, p, esperadosPagina);
          prediccionesCorrida.push(...preds);
        }

        for (const pred of prediccionesCorrida) {
          const caso = mapaBloqueAPorId.get(pred.id);
          if (caso) {
            if (!prediccionesPorCorrida.has(caso.caso)) {
              prediccionesPorCorrida.set(caso.caso, []);
            }
            const arr = prediccionesPorCorrida.get(caso.caso)!;
            if (!arr[r - 1]) arr[r - 1] = [];
            arr[r - 1]!.push(pred);
          }
        }
      }
    },
  );

  // 5. Consolidación de predicciones y concordancia
  interface EvaluacionCaso {
    caso: CasoFusionado;
    prediccionFinal: PrediccionModelo;
    concordancia: number; // Porcentaje de concordancia entre corridas (1.0 = 100%)
    prediccionesTodas: ("si" | "no" | "dudoso")[];
  }

  const evaluados: EvaluacionCaso[] = [];

  for (const c of bloqueA) {
    const listaCorridas = prediccionesPorCorrida.get(c.caso) || [];
    const preds = listaCorridas.map((arr) => arr[0]?.aptoPyme || "dudoso");

    // Conteo por etiqueta
    const conteo: Record<"si" | "no" | "dudoso", number> = { si: 0, no: 0, dudoso: 0 };
    for (const p of preds) conteo[p]++;

    // Predicción final: voto mayoritario (o la primera si es 1 corrida)
    let mejorEtiqueta: "si" | "no" | "dudoso" = preds[0] || "dudoso";
    let maxVotos = -1;
    for (const [et, v] of Object.entries(conteo) as ["si" | "no" | "dudoso", number][]) {
      if (v > maxVotos) {
        maxVotos = v;
        mejorEtiqueta = et;
      }
    }

    const concordancia = preds.length > 0 ? maxVotos / preds.length : 1;
    const predBase = listaCorridas[0]?.[0] || {
      id: c.id,
      aptoPyme: mejorEtiqueta,
      categoriaObjeto: "Desconocido",
      razon: "Sin datos",
      senales: [],
    };

    evaluados.push({
      caso: c,
      prediccionFinal: { ...predBase, aptoPyme: mejorEtiqueta },
      concordancia,
      prediccionesTodas: preds,
    });
  }

  // 6. Métricas del Bloque A
  type Etiqueta = "si" | "no" | "dudoso";
  const matrizConfusio: Record<Etiqueta, Record<Etiqueta, number>> = {
    si: { si: 0, no: 0, dudoso: 0 },
    no: { si: 0, no: 0, dudoso: 0 },
    dudoso: { si: 0, no: 0, dudoso: 0 },
  };

  for (const item of evaluados) {
    const hum = item.caso.etiquetaHumana;
    const mod = item.prediccionFinal.aptoPyme;
    matrizConfusio[hum][mod]++;
  }

  const totalA = evaluados.length;
  const aciertosExactos =
    matrizConfusio.si.si + matrizConfusio.no.no + matrizConfusio.dudoso.dudoso;
  const accuracy = totalA > 0 ? aciertosExactos / totalA : 0;

  // Precisión y recall para "si"
  const totalModeloSi =
    matrizConfusio.si.si + matrizConfusio.no.si + matrizConfusio.dudoso.si;
  const totalHumanoSi =
    matrizConfusio.si.si + matrizConfusio.si.no + matrizConfusio.si.dudoso;

  const precisionSi = totalModeloSi > 0 ? matrizConfusio.si.si / totalModeloSi : 0;
  const recallSi = totalHumanoSi > 0 ? matrizConfusio.si.si / totalHumanoSi : 0;

  // Useful recall: % de mis "si" que el modelo clasifica como "si" o "dudoso"
  const usefulRecall =
    totalHumanoSi > 0
      ? (matrizConfusio.si.si + matrizConfusio.si.dudoso) / totalHumanoSi
      : 0;

  // Falsos positivos graves: Humano="no", Modelo="si"
  const falsosPositivosGraves = evaluados.filter(
    (e) => e.caso.etiquetaHumana === "no" && e.prediccionFinal.aptoPyme === "si",
  );

  // Oportunidades perdidas: Humano="si", Modelo="no"
  const oportunidadesPerdidas = evaluados.filter(
    (e) => e.caso.etiquetaHumana === "si" && e.prediccionFinal.aptoPyme === "no",
  );

  // Participación de dudoso
  const totalModeloDudoso =
    matrizConfusio.si.dudoso + matrizConfusio.no.dudoso + matrizConfusio.dudoso.dudoso;
  const totalHumanoDudoso =
    matrizConfusio.dudoso.si + matrizConfusio.dudoso.no + matrizConfusio.dudoso.dudoso;

  const shareDudosoModelo = totalA > 0 ? totalModeloDudoso / totalA : 0;
  const shareDudosoHumano = totalA > 0 ? totalHumanoDudoso / totalA : 0;

  // Casos que cambiaron de etiqueta entre corridas
  const casosConInestabilidad = evaluados.filter((e) => e.concordancia < 1);

  // 7. Auditoría del Bloque B (Prefiltro)
  interface AuditoriaRegla {
    regla: ReglaDescarte;
    totalDescartados: number;
    etiquetadosSi: number;
    etiquetadosDudoso: number;
    etiquetadosNo: number;
    tasaFalsosDescartes: number; // (si + dudoso) / total
    casosAfectados: CasoFusionado[];
  }

  const auditoriaBloqueB: AuditoriaRegla[] = [];

  if (!config.sinBloqueB) {
    const porRegla = new Map<ReglaDescarte, CasoFusionado[]>();
    for (const c of bloqueB) {
      const r = c.reglaDescarte || ("desconocida" as ReglaDescarte);
      if (!porRegla.has(r)) porRegla.set(r, []);
      porRegla.get(r)!.push(c);
    }

    for (const [regla, items] of porRegla.entries()) {
      const si = items.filter((i) => i.etiquetaHumana === "si").length;
      const dudoso = items.filter((i) => i.etiquetaHumana === "dudoso").length;
      const no = items.filter((i) => i.etiquetaHumana === "no").length;
      const falsos = si + dudoso;
      const tasa = items.length > 0 ? falsos / items.length : 0;
      const casosAfectados = items.filter((i) => i.etiquetaHumana !== "no");

      auditoriaBloqueB.push({
        regla,
        totalDescartados: items.length,
        etiquetadosSi: si,
        etiquetadosDudoso: dudoso,
        etiquetadosNo: no,
        tasaFalsosDescartes: tasa,
        casosAfectados,
      });
    }
  }

  // 8. Tabla de Discrepancias en Bloque A
  const discrepancias = evaluados.filter(
    (e) => e.caso.etiquetaHumana !== e.prediccionFinal.aptoPyme,
  );

  // 9. Costos y Tokens de la corrida
  // Leer tokens desde el registro en disco
  const rutaTokensLog = path.resolve(process.cwd(), "logs", "tokens.jsonl");
  try {
    const logRaw = await readFile(rutaTokensLog, "utf8");
    const lineas = logRaw.split("\n").filter((l) => l.trim().length > 0);
    for (const l of lineas) {
      try {
        const item = JSON.parse(l);
        if (item.ejecucionId === ejecucionId) {
          totalTokensEntrada += item.tokens_entrada || 0;
          totalTokensSalida += item.tokens_salida || 0;
          totalTokensAcumulados += item.tokens_total || 0;
        }
      } catch {}
    }
  } catch {}

  const costoUSD = await calcularCostoEstimado(
    MODEL_NAME,
    totalTokensEntrada,
    totalTokensSalida,
  );

  await finalizarEjecucion(ejecucionId, {
    estado: "ok",
    tipo: "evaluacion",
    modo: "evaluacion",
    fechaDatos: "benchmark-humano",
    etapas: {
      candidatos: bloqueA.length,
      aptos: totalModeloSi,
      resumidos: 0,
      documentados: 0,
    },
    tokens: {
      entrada: totalTokensEntrada,
      salida: totalTokensSalida,
      razonamiento: null,
      total: totalTokensAcumulados,
    },
    costoUSD,
  });

  // 10. Persistencia de Resultados: carpetas timestamp y linea-base
  const hashPrompt = createHash("sha256").update(PROMPT_SISTEMA_FILTRADOR).digest("hex").slice(0, 10);
  const now = new Date();
  const timestampStr = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const dirTimestamp = dirResultadoEvaluacionTimestamp(timestampStr);
  const dirLineaBase = dirResultadoEvaluacionLineaBase();

  await mkdir(dirTimestamp, { recursive: true });

  const yaExisteLineaBase = await existeDirectorio(dirLineaBase);
  const esLineaBase = !yaExisteLineaBase;
  const tipoCorrida = esLineaBase ? "linea_base" : "tras_ajuste";

  // Generar CSV de Matriz
  const matrizCsv = [
    "humano,modelo_si,modelo_no,modelo_dudoso,total_humano",
    `si,${matrizConfusio.si.si},${matrizConfusio.si.no},${matrizConfusio.si.dudoso},${totalHumanoSi}`,
    `no,${matrizConfusio.no.si},${matrizConfusio.no.no},${matrizConfusio.no.dudoso},${matrizConfusio.no.si + matrizConfusio.no.no + matrizConfusio.no.dudoso}`,
    `dudoso,${matrizConfusio.dudoso.si},${matrizConfusio.dudoso.no},${matrizConfusio.dudoso.dudoso},${totalHumanoDudoso}`,
    `total_modelo,${totalModeloSi},${matrizConfusio.si.no + matrizConfusio.no.no + matrizConfusio.dudoso.no},${totalModeloDudoso},${totalA}`,
  ].join("\n");

  // Generar JSON de Resultados
  const resultadosJson = {
    ejecucionId,
    timestamp: now.toISOString(),
    tipoCorrida,
    hashPrompt,
    repeticiones: config.repeticiones,
    sinBloqueB: config.sinBloqueB,
    costos: {
      tokensEntrada: totalTokensEntrada,
      tokensSalida: totalTokensSalida,
      tokensTotal: totalTokensAcumulados,
      costoUSD,
    },
    metricasBloqueA: {
      totalCasos: totalA,
      exactitud: accuracy,
      precisionSi,
      recallSi,
      usefulRecall,
      shareDudosoModelo,
      shareDudosoHumano,
      matrizConfusion: matrizConfusio,
      totalFalsosPositivosGraves: falsosPositivosGraves.length,
      totalOportunidadesPerdidas: oportunidadesPerdidas.length,
      inestabilidadesRepeticiones: casosConInestabilidad.length,
    },
    auditoriaBloqueB: auditoriaBloqueB.map((a) => ({
      regla: a.regla,
      totalDescartados: a.totalDescartados,
      etiquetadosSi: a.etiquetadosSi,
      etiquetadosDudoso: a.etiquetadosDudoso,
      etiquetadosNo: a.etiquetadosNo,
      tasaFalsosDescartes: a.tasaFalsosDescartes,
      casosAfectados: a.casosAfectados.map((c) => ({
        caso: c.caso,
        id: c.id,
        nombre: c.nombre,
        etiquetaHumana: c.etiquetaHumana,
        notaHumana: c.notaHumana,
      })),
    })),
    discrepancias: discrepancias.map((d) => ({
      caso: d.caso.caso,
      id: d.caso.id,
      nombre: d.caso.nombre,
      valorCOP: d.caso.valorCOP,
      etiquetaHumana: d.caso.etiquetaHumana,
      notaHumana: d.caso.notaHumana,
      etiquetaModelo: d.prediccionFinal.aptoPyme,
      razonModelo: d.prediccionFinal.razon,
    })),
  };

  // Generar Markdown de Resumen
  const lineasMd: string[] = [];
  lineasMd.push(`# Reporte de Evaluación Científica — Agente 1 (Filtrador)`);
  lineasMd.push(`> **Ejecución ID**: \`${ejecucionId}\` | **Fecha**: ${now.toISOString()} | **Tipo**: **${tipoCorrida.toUpperCase()}**`);
  lineasMd.push(`> **Hash Prompt**: \`${hashPrompt}\` | **Repeticiones**: ${config.repeticiones}\n`);

  lineasMd.push(`## 1. Métricas Principales (Bloque A — 40 Casos Post-Prefiltro)`);
  lineasMd.push(`| Métrica | Valor | Interpretación |`);
  lineasMd.push(`| :--- | :---: | :--- |`);
  lineasMd.push(`| **Exactitud (Accuracy)** | **${(accuracy * 100).toFixed(1)}%** | Aciertos exactos en la matriz 3x3 (${aciertosExactos}/${totalA}) |`);
  lineasMd.push(`| **Precisión ("si")** | **${(precisionSi * 100).toFixed(1)}%** | De lo que el modelo marcó "si", cuánto era oportunidad real |`);
  lineasMd.push(`| **Exhaustividad / Recall ("si")** | **${(recallSi * 100).toFixed(1)}%** | De las oportunidades reales, cuántas detectó el modelo |`);
  lineasMd.push(`| **Useful Recall ("si" + "dudoso")** | **${(usefulRecall * 100).toFixed(1)}%** | Oportunidades reales salvadas (no descartadas de plano) |`);
  lineasMd.push(`| **Falsos Positivos Graves** | **${falsosPositivosGraves.length}** | Casos donde Humano='no' y Modelo='si' |`);
  lineasMd.push(`| **Oportunidades Perdidas** | **${oportunidadesPerdidas.length}** | Casos donde Humano='si' y Modelo='no' |`);
  lineasMd.push(`| **Participación "Dudoso" (Modelo)** | **${(shareDudosoModelo * 100).toFixed(1)}%** | Frecuencia con la que el modelo declara incertidumbre |`);
  lineasMd.push(`| **Participación "Dudoso" (Humano)** | **${(shareDudosoHumano * 100).toFixed(1)}%** | Frecuencia de ambigüedad en el Ground Truth |`);

  if (config.repeticiones > 1) {
    lineasMd.push(`| **Estabilidad entre Corridas** | **${(((totalA - casosConInestabilidad.length) / totalA) * 100).toFixed(1)}%** | Casos con decisión idéntica en todas las corridas |`);
  }

  lineasMd.push(`\n## 2. Matriz de Confusión 3x3`);
  lineasMd.push(`| Ground Truth (Humano) \\ Predicción Modelo | Modelo "si" | Modelo "no" | Modelo "dudoso" | Total Humano |`);
  lineasMd.push(`| :--- | :---: | :---: | :---: | :---: |`);
  lineasMd.push(`| **Humano "si"** | **${matrizConfusio.si.si}** | ${matrizConfusio.si.no} | ${matrizConfusio.si.dudoso} | **${totalHumanoSi}** |`);
  lineasMd.push(`| **Humano "no"** | ${matrizConfusio.no.si} | **${matrizConfusio.no.no}** | ${matrizConfusio.no.dudoso} | **${matrizConfusio.no.si + matrizConfusio.no.no + matrizConfusio.no.dudoso}** |`);
  lineasMd.push(`| **Humano "dudoso"** | ${matrizConfusio.dudoso.si} | ${matrizConfusio.dudoso.no} | **${matrizConfusio.dudoso.dudoso}** | **${totalHumanoDudoso}** |`);
  lineasMd.push(`| **Total Modelo** | **${totalModeloSi}** | **${matrizConfusio.si.no + matrizConfusio.no.no + matrizConfusio.dudoso.no}** | **${totalModeloDudoso}** | **${totalA}** |\n`);

  if (!config.sinBloqueB) {
    lineasMd.push(`## 3. Auditoría del Pre-Filtro (Bloque B — 15 Casos Descartados)`);
    lineasMd.push(`Analiza qué reglas descartaron procesos que el evaluador humano consideró válidos o dudosos (*Falsos Descartes*):`);
    lineasMd.push(`| Regla de Descarte | Total Casos | Humano "si" | Humano "dudoso" | Humano "no" | Tasa Falsos Descartes |`);
    lineasMd.push(`| :--- | :---: | :---: | :---: | :---: | :---: |`);
    for (const a of auditoriaBloqueB) {
      lineasMd.push(
        `| \`${a.regla}\` | ${a.totalDescartados} | ${a.etiquetadosSi} | ${a.etiquetadosDudoso} | ${a.etiquetadosNo} | **${(a.tasaFalsosDescartes * 100).toFixed(1)}%** |`,
      );
    }

    const todosFalsosDescartes = auditoriaBloqueB.flatMap((a) => a.casosAfectados);
    if (todosFalsosDescartes.length > 0) {
      lineasMd.push(`\n### Detalle de Falsos Descartes por el Pre-Filtro:`);
      for (const fd of todosFalsosDescartes) {
        lineasMd.push(`- **Caso ${fd.caso}** (\`${fd.reglaDescarte}\`): ${fd.nombre.slice(0, 80)}...`);
        lineasMd.push(`  - *Etiqueta Humana*: \`${fd.etiquetaHumana}\` | *Nota*: "${fd.notaHumana}"`);
      }
    }
    lineasMd.push("");
  }

  lineasMd.push(`## 4. Tabla de Discrepancias (Análisis de Errores — ${discrepancias.length} Casos)`);
  if (discrepancias.length === 0) {
    lineasMd.push(`*¡Concordancia total! No se presentaron discrepancias en esta corrida.*\n`);
  } else {
    lineasMd.push(`| Caso | Objeto / Nombre | Humano | Nota Humana | Modelo | Razón del Modelo |`);
    lineasMd.push(`| :---: | :--- | :---: | :--- | :---: | :--- |`);
    for (const d of discrepancias) {
      const nombreCorto = d.caso.nombre.length > 50 ? `${d.caso.nombre.slice(0, 48)}…` : d.caso.nombre;
      lineasMd.push(
        `| **${d.caso.caso}** | ${nombreCorto} | **\`${d.caso.etiquetaHumana}\`** | ${d.caso.notaHumana} | **\`${d.prediccionFinal.aptoPyme}\`** | ${d.prediccionFinal.razon} |`,
      );
    }
    lineasMd.push("");
  }

  lineasMd.push(`## 5. Costos y Consumo de Tokens`);
  lineasMd.push(`- **Tokens de Entrada**: ${totalTokensEntrada.toLocaleString("es-CO")}`);
  lineasMd.push(`- **Tokens de Salida**: ${totalTokensSalida.toLocaleString("es-CO")}`);
  lineasMd.push(`- **Tokens Totales**: ${totalTokensAcumulados.toLocaleString("es-CO")}`);
  lineasMd.push(
    `- **Costo Total Estimado**: **${costoUSD !== null ? `$ ${costoUSD.toFixed(4)} USD` : "precio no configurado"}**`,
  );

  const contenidoMd = lineasMd.join("\n");

  // Guardar en timestamp
  await writeFile(path.join(dirTimestamp, "resumen.md"), contenidoMd, "utf8");
  await writeFile(path.join(dirTimestamp, "resultados.json"), JSON.stringify(resultadosJson, null, 2), "utf8");
  await writeFile(path.join(dirTimestamp, "matriz.csv"), matrizCsv, "utf8");

  // Si es la primera corrida, fijar como LINEA BASE inmutable
  if (esLineaBase) {
    await mkdir(dirLineaBase, { recursive: true });
    await writeFile(path.join(dirLineaBase, "resumen.md"), contenidoMd, "utf8");
    await writeFile(path.join(dirLineaBase, "resultados.json"), JSON.stringify(resultadosJson, null, 2), "utf8");
    await writeFile(path.join(dirLineaBase, "matriz.csv"), matrizCsv, "utf8");
    console.log(`\n🔒 Esta corrida ha sido registrada como la LÍNEA BASE inmutable en:`);
    console.log(`   data/pruebas-reto/evaluacion/resultados/linea-base/`);
  }

  console.log(`\n📑 Resultados guardados en:`);
  console.log(`   data/pruebas-reto/evaluacion/resultados/${timestampStr}/`);

  // Imprimir resumen en consola para aceptación
  console.log("\n================================================================================");
  console.log(contenidoMd);
  console.log("================================================================================\n");
}

if (process.argv[1]?.endsWith("evaluar.ts")) {
  evaluar().catch((err) => {
    console.error("❌ Error durante la evaluación:", err);
    process.exit(1);
  });
}
