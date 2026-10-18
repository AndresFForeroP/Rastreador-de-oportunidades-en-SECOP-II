/**
 * Agente 2: "resumidor" (agente_resumidor).
 *
 * Prepara para una pyme una ficha breve, honesta y fundamentada de un proceso
 * clasificado como apto en SECOP II, apoyándose en la herramienta `obtener_ficha_proceso`.
 *
 * REGLAS ÉTICAS Y DE NEGOCIO:
 * - NUNCA afirma haber leído el pliego de condiciones (inaccesible por ReCaptcha).
 * - Los requisitos habilitantes no están en los datos abiertos: no se inventan ni suponen.
 * - Solo sintetiza nombre y descripción en máximo 100 palabras.
 * - Aplica guardas de código para verificar coherencia de cifras y campos citados.
 */
import { createAgent } from "langchain";
import * as z from "zod";
import { llm } from "../llm.js";
import {
  obtenerFichaProceso,
  type FichaProceso,
} from "../herramientas/obtener-ficha-proceso.js";
import { PROMPT_SISTEMA_RESUMIDOR } from "./prompts/resumidor.js";

export const NOMBRE_AGENTE_RESUMIDOR = "agente_resumidor";

/** Alerta individual para la pyme deducida de la ficha. */
export const AlertaParaPyme = z.object({
  alerta: z
    .string()
    .describe("Riesgo o punto de atención concreto para la pyme deducido de los datos."),
  basadoEn: z
    .string()
    .describe("Nombre exacto del campo de la ficha del que sale la alerta (ej: 'diasRestantes', 'valorCOP', 'lotes', etc.)."),
});

export type AlertaParaPyme = z.infer<typeof AlertaParaPyme>;

/** Esquema estructurado de salida del agente resumidor. */
export const ResumenProceso = z.object({
  id: z.string().describe("Identificador exacto del proceso en SECOP II (id_del_proceso)."),
  resumen: z
    .string()
    .describe("Qué compra la entidad, en lenguaje simple, máximo 100 palabras, usando solo nombre y descripción."),
  alertasParaPyme: z
    .array(AlertaParaPyme)
    .describe("Lista de riesgos o puntos de atención deducidos con su campo fuente exacto."),
  verificarEnElPliego: z
    .array(z.string())
    .describe("Qué debe confirmar la pyme en el pliego oficial (experiencia, capacidad financiera, garantías, visita técnica, etc.)."),
  comentarioAnexos: z
    .string()
    .nullable()
    .describe("Comentario prudente sobre los anexos indexados según sus nombres, o 'sin anexos indexados aún'."),
});

export type ResumenProceso = z.infer<typeof ResumenProceso>;

/** Estructura consolidada con guardas de código aplicadas. */
export interface ProcesoResumido extends ResumenProceso {
  ficha: FichaProceso;
  advertencias: string[];
}

/**
 * Crea una instancia del agente resumidor con herramienta obtener_ficha_proceso
 * y respuesta estructurada ResumenProceso.
 */
export function crearAgenteResumidor() {
  return createAgent({
    name: NOMBRE_AGENTE_RESUMIDOR,
    model: llm,
    tools: [obtenerFichaProceso],
    systemPrompt: PROMPT_SISTEMA_RESUMIDOR,
    responseFormat: ResumenProceso,
  });
}

/** Instancia compartida del agente resumidor. */
export const agenteResumidor = crearAgenteResumidor();

/**
 * Aplica guardas de código a la respuesta del agente resumidor:
 * 1. Verifica que cada `basadoEn` sea una clave real de la ficha; de lo contrario, lo marca en advertencias.
 * 2. Extrae números de 6+ dígitos del texto generado y marca en advertencias cualquiera que no figure en la ficha.
 */
export function aplicarGuardasResumen(
  ficha: FichaProceso,
  salidaAgente: ResumenProceso,
): ProcesoResumido {
  const advertencias: string[] = [];
  const clavesFicha = new Set<string>(Object.keys(ficha));

  // Guarda (a): drop o flag de campos basadoEn inexistentes
  for (const item of salidaAgente.alertasParaPyme) {
    if (!clavesFicha.has(item.basadoEn)) {
      advertencias.push(`Campo basadoEn inválido: "${item.basadoEn}" no es una clave de la ficha.`);
    }
  }

  // Guarda (b): detección de cifras de 6+ dígitos inventadas o no respaldadas
  const textoGenerado = [
    salidaAgente.resumen,
    ...salidaAgente.alertasParaPyme.map((a) => a.alerta),
    salidaAgente.comentarioAnexos ?? "",
  ].join(" ");

  // Busca patrones como 1176283836 o 1.176.283.836 o 1,176,283
  const regexNumeros = /(?:\$?\s*)?(\b\d{1,3}(?:[.,']\d{3}){1,}\b|\b\d{6,}\b)/g;
  const textoFichaCompleto = JSON.stringify(ficha);
  const digitosFicha = textoFichaCompleto.replace(/\D/g, " ");

  const coincidencias = textoGenerado.match(regexNumeros) ?? [];
  for (const match of coincidencias) {
    const soloDigitos = match.replace(/\D/g, "");
    if (soloDigitos.length >= 6) {
      const existeEnFicha =
        textoFichaCompleto.includes(match) ||
        textoFichaCompleto.includes(soloDigitos) ||
        digitosFicha.includes(soloDigitos);

      if (!existeEnFicha) {
        advertencias.push(
          `Cifra de 6+ dígitos no respaldada en la ficha: "${match}" (${soloDigitos}).`,
        );
      }
    }
  }

  return {
    ...salidaAgente,
    ficha,
    advertencias,
  };
}
