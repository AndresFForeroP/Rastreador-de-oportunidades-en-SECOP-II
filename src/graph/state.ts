/**
 * Definición del estado del grafo LangGraph con Zod y reducers.
 *
 * Sigue el estándar de LangGraph JS con `withLangGraph` para definir canales con reducers
 * (por ejemplo para el canal de `errores` y listas de resultados).
 */
import { withLangGraph } from "@langchain/langgraph/zod";
import * as z from "zod";
import type { Candidato, ReglaDescarte } from "../filtro/prefiltro.js";
import type { ResultadoProcesoApto } from "../pipeline/filtrar-pymes.js";
import type { ItemResumenEntrega } from "../pipeline/resumir-procesos.js";
import type { ProcesoConDocumentos } from "../pipeline/armar-documentos.js";

export const CapsEjecucionSchema = z.object({
  /** Límite de candidatos enviados al Agente 1 (por defecto 25 = 1 página). */
  max: z.number().default(25),
  /** Límite de procesos aptos pasados a Agentes 2 y 3 (por defecto 5). */
  maxAptos: z.number().default(5),
  /** Si es true, incluye procesos clasificados como "dudoso". */
  incluirDudosos: z.boolean().default(false),
  /** Si es true, elimina ambos topes (procesa todos los candidatos y aptos). */
  completo: z.boolean().default(false),
  /** Fuerza llamada al LLM en Agente 3 incluso sin anexos indexados. */
  siempreAgente: z.boolean().optional(),
  /** Si es true, reutiliza entregas previas en disco para no gastar créditos. */
  reanudar: z.boolean().optional(),
});

export type CapsEjecucion = z.infer<typeof CapsEjecucionSchema>;

export const EsquemaEstadoGrafo = z.object({
  /** Fecha en formato YYYY-MM-DD. */
  fecha: z.string(),
  /** Modo de ejecución: "hoy" (producción) o "prueba" (histórico). */
  modo: z.enum(["hoy", "prueba"]),
  /** Instante ISO de referencia para evaluar fechas límites. */
  fechaReferencia: z.string(),
  /** Configuración de topes y banderas de ejecución. */
  caps: CapsEjecucionSchema,

  /** Métricas de descarga y prefiltro */
  totalDescargados: z.number().default(0),
  descartadosPorRegla: z.record(z.string(), z.number()).default({}),
  totalCandidatos: z.number().default(0),

  /** Candidatos pre-filtrados viables */
  candidatos: withLangGraph(z.array(z.custom<Candidato>()), {
    reducer: { fn: (_a: Candidato[], b: Candidato[]) => b },
    default: () => [],
  }),

  /** Clasificación generada por Agente 1 */
  clasificacionAptos: withLangGraph(z.array(z.custom<ResultadoProcesoApto>()), {
    reducer: { fn: (_a: ResultadoProcesoApto[], b: ResultadoProcesoApto[]) => b },
    default: () => [],
  }),
  conteoClasificacion: z
    .object({
      si: z.number().default(0),
      no: z.number().default(0),
      dudoso: z.number().default(0),
    })
    .default({ si: 0, no: 0, dudoso: 0 }),

  /** Resúmenes generados por Agente 2 */
  resumenes: withLangGraph(z.array(z.custom<ItemResumenEntrega>()), {
    reducer: { fn: (_a: ItemResumenEntrega[], b: ItemResumenEntrega[]) => b },
    default: () => [],
  }),

  /** Documentos estructurados generados por Agente 3 */
  documentos: withLangGraph(z.array(z.custom<ProcesoConDocumentos>()), {
    reducer: { fn: (_a: ProcesoConDocumentos[], b: ProcesoConDocumentos[]) => b },
    default: () => [],
  }),

  /** Errores aislados por ítem (reducer acumulativo con concat) */
  errores: withLangGraph(z.array(z.string()), {
    reducer: { fn: (a: string[], b: string[]) => a.concat(b) },
    default: () => [],
  }),

  /** Rutas de reportes consolidados generados */
  reporteRutas: z
    .object({
      rutaJson: z.string(),
      rutaMd: z.string(),
    })
    .nullable()
    .default(null),

  /** Métricas acumuladas de tokens de la jornada */
  tokensTotales: z
    .object({
      entrada: z.number().default(0),
      salida: z.number().default(0),
      total: z.number().default(0),
    })
    .default({ entrada: 0, salida: 0, total: 0 }),
});

export type EstadoGrafo = z.infer<typeof EsquemaEstadoGrafo>;
