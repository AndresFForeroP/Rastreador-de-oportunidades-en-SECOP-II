/**
 * Agente 1: "filtrador" (agente_filtrador).
 *
 * Clasifica los candidatos de una página de SECOP II indicando si son una
 * oportunidad realista para una pyme (si / no / dudoso).
 *
 * Utiliza:
 * - Modelo Grok (src/llm.ts).
 * - Herramienta `filtro_basico` (src/herramientas/filtro-basico.ts).
 * - System prompt en español (src/agentes/prompts/filtrador.ts).
 * - Salida estructurada `responseFormat` con Zod (`ResultadoPagina`).
 */
import { createAgent } from "langchain";
import * as z from "zod";
import { llm } from "../llm.js";
import { filtroBasico } from "../herramientas/filtro-basico.js";
import { PROMPT_SISTEMA_FILTRADOR } from "./prompts/filtrador.js";

export const NOMBRE_AGENTE_FILTRADOR = "agente_filtrador";

/** Clasificación individual de aptitud para una pyme. */
export const ClasificacionPyme = z.object({
  id: z.string().describe("Identificador exacto del proceso (id_del_proceso)."),
  aptoPyme: z
    .enum(["si", "no", "dudoso"])
    .describe("Decisión: 'si' (viable para pyme), 'no' (fuera de escala/capacidad), 'dudoso' (insuficiente información)."),
  categoriaObjeto: z
    .string()
    .describe("Categoría del objeto contractual en 2 a 4 palabras (ej: 'papelería y oficina')."),
  razon: z
    .string()
    .describe("Justificación concisa de la decisión en máximo 20 palabras."),
  senales: z
    .array(z.string())
    .describe("Frases cortas o indicios extraídos del texto que respaldan la decisión."),
});

export type ClasificacionPyme = z.infer<typeof ClasificacionPyme>;

/** Esquema de la respuesta estructurada del agente por página. */
export const ResultadoPagina = z.object({
  pagina: z.number().int().describe("Número de la página procesada."),
  resultados: z
    .array(ClasificacionPyme)
    .describe("Lista con exactamente un resultado por cada proceso recibido en la página."),
});

export type ResultadoPagina = z.infer<typeof ResultadoPagina>;

/**
 * Crea una instancia del agente filtrador con herramientas y formato de salida estructurado.
 * Permite inyectar una herramienta `filtro_basico` personalizada para entornos de evaluación.
 */
export function crearAgenteFiltrador(herramientaFiltro = filtroBasico) {
  return createAgent({
    name: NOMBRE_AGENTE_FILTRADOR,
    model: llm,
    tools: [herramientaFiltro],
    systemPrompt: PROMPT_SISTEMA_FILTRADOR,
    responseFormat: ResultadoPagina,
  });
}

/** Instancia compartida del agente filtrador para producción. */
export const agenteFiltrador = crearAgenteFiltrador();
