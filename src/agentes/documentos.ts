/**
 * Agente 3: "documentos" (agente_documentos).
 *
 * Modelo: genera únicamente NotasDocumentos sobre los anexos indexados y observaciones.
 * Código: construye la lista determinista combinando catálogo general y anexos deduplicados.
 */
import { createAgent } from "langchain";
import * as z from "zod";
import { llm } from "../llm.js";
import {
  armarListaDocumentos,
  MAPA_DEDUPLICACION_ANEXOS,
  type ItemCatalogoDocumento,
} from "../herramientas/armar-lista-documentos.js";
import { PROMPT_SISTEMA_DOCUMENTOS } from "./prompts/documentos.js";

export const NOMBRE_AGENTE_DOCUMENTOS = "agente_documentos";
export const AVISO_FIJO_ORIENTATIVO = "Lista orientativa: confirme siempre en el pliego oficial";

/** Nota breve sobre un anexo indexado */
export const NotaAnexo = z.object({
  nombre: z.string().describe("Nombre EXACTO del archivo anexo de la ficha."),
  queEs: z.string().describe("Qué sugiere el nombre del archivo (máximo 15 palabras)."),
});

/** Salida estructurada reducida del modelo para minimizar tokens */
export const NotasDocumentos = z.object({
  id: z.string().describe("Identificador exacto del proceso en SECOP II (id_del_proceso)."),
  anexos: z
    .array(NotaAnexo)
    .describe("Notas breves sobre los archivos anexos indexados de la ficha."),
  observaciones: z
    .string()
    .describe("Observación general orientativa para la pyme (máximo 60 palabras)."),
});

export type NotasDocumentos = z.infer<typeof NotasDocumentos>;

/** Esquema final de ítem de documento en la entrega */
export interface ItemDocumento {
  nombre: string;
  base: "catalogo_con_emisor" | "catalogo_sin_emisor" | "nombre_de_anexo";
  fundamento: string;
  catalogoId: string | null;
  expide: string | null;
  condicion: string | null;
  observaciones: string | null;
}

function normalizarTexto(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Construye la lista de documentos de forma determinista en código:
 * 1. Deduplica anexos contra el catálogo general mediante MAPA_DEDUPLICACION_ANEXOS.
 * 2. Si un anexo corresponde a un ítem de catálogo, emite un único ítem con base "nombre_de_anexo"
 *    y el catalogoId asociado.
 * 3. Los ítems de catálogo no cubiertos por anexos se emiten con base "catalogo_con_emisor" o "catalogo_sin_emisor".
 * 4. Incorpora las notas breves del modelo (queEs y observaciones).
 */
export function construirListaDocumentosDeterminista(params: {
  id: string;
  anexosFicha: Array<{ nombre: string }>;
  catalogoFiltrado: ItemCatalogoDocumento[];
  notasModelo?: NotasDocumentos | null;
}): { items: ItemDocumento[]; advertencias: string[]; observacionGeneral: string | null } {
  const { id, anexosFicha, catalogoFiltrado, notasModelo } = params;
  const advertencias: string[] = [AVISO_FIJO_ORIENTATIVO];
  advertencias.push(
    "Nadie ha leído el pliego oficial de condiciones: la lista es orientativa y el pliego oficial manda.",
  );

  const notasPorAnexo = new Map<string, string>();
  if (notasModelo && Array.isArray(notasModelo.anexos)) {
    const anexosFichaNorm = anexosFicha.map((a) => normalizarTexto(a.nombre));

    for (const anexoNota of notasModelo.anexos) {
      const notaNorm = normalizarTexto(anexoNota.nombre);
      const coincide = anexosFichaNorm.includes(notaNorm);

      if (coincide) {
        // Truncar a máx 15 palabras por seguridad
        const palabras = anexoNota.queEs.trim().split(/\s+/);
        const queEsTruncado = palabras.length > 15 ? palabras.slice(0, 15).join(" ") + "..." : anexoNota.queEs;
        notasPorAnexo.set(notaNorm, queEsTruncado);
      } else {
        advertencias.push(
          `Se descartó nota del modelo para el anexo "${anexoNota.nombre}" porque no coincide con ningún archivo indexado en la ficha.`,
        );
      }
    }
  }

  const catalogIdsCubiertos = new Set<string>();
  const itemsAnexos: ItemDocumento[] = [];

  for (const anexo of anexosFicha) {
    const anxNorm = normalizarTexto(anexo.nombre);
    const regla = MAPA_DEDUPLICACION_ANEXOS.find((r) =>
      r.palabrasClave.some((kw) => anxNorm.includes(normalizarTexto(kw))),
    );

    const notaModelo = notasPorAnexo.get(anxNorm);

    if (regla) {
      catalogIdsCubiertos.add(regla.catalogoId);
      const catItem = catalogoFiltrado.find((c) => c.id === regla.catalogoId);

      itemsAnexos.push({
        nombre: catItem ? catItem.nombre : anexo.nombre,
        base: "nombre_de_anexo",
        fundamento: anexo.nombre,
        catalogoId: regla.catalogoId,
        expide: catItem?.expide ?? null,
        condicion: catItem?.condicion ?? "Puede exigirse según el pliego; verificar.",
        observaciones:
          notaModelo ??
          "Anexo indexado en SECOP II correspondiente a este documento del catálogo general.",
      });
    } else {
      // Anexo adicional del pliego sin equivalencia directa en catálogo general
      const nombreLimpio = anexo.nombre
        .replace(/\.[^/.]+$/, "")
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      itemsAnexos.push({
        nombre: nombreLimpio,
        base: "nombre_de_anexo",
        fundamento: anexo.nombre,
        catalogoId: null,
        expide: null,
        condicion: "Puede exigirse según el pliego; verificar.",
        observaciones:
          notaModelo ?? "Archivo anexo indexado en SECOP II; confirme en el pliego oficial.",
      });
    }
  }

  // Ítems de catálogo no cubiertos por anexos
  const itemsCatalogoRestantes: ItemDocumento[] = [];
  for (const cat of catalogoFiltrado) {
    if (catalogIdsCubiertos.has(cat.id)) {
      continue; // Deduplicado: ya se incluyó en itemsAnexos
    }

    const tieneEmisor = Boolean(cat.emisor);
    itemsCatalogoRestantes.push({
      nombre: cat.nombre,
      base: tieneEmisor ? "catalogo_con_emisor" : "catalogo_sin_emisor",
      fundamento: cat.emisor ?? "Catálogo general (sin emisor oficial enlazado; confirme en pliego)",
      catalogoId: cat.id,
      expide: cat.expide,
      condicion: cat.condicion ?? "Puede exigirse según el pliego; verificar.",
      observaciones: "Documento del catálogo general de referencia; confirme en el pliego oficial.",
    });
  }

  if (anexosFicha.length === 0) {
    advertencias.push("Ficha del proceso: sin anexos indexados aún.");
  }

  let observacionGeneral: string | null = null;
  if (notasModelo?.observaciones) {
    const palabrasObs = notasModelo.observaciones.trim().split(/\s+/);
    observacionGeneral = palabrasObs.length > 60 ? palabrasObs.slice(0, 60).join(" ") + "..." : notasModelo.observaciones;
  }

  return {
    items: [...itemsAnexos, ...itemsCatalogoRestantes],
    advertencias,
    observacionGeneral,
  };
}

/**
 * Crea una instancia del agente de documentos con salida estructurada NotasDocumentos.
 */
export function crearAgenteDocumentos() {
  return createAgent({
    name: NOMBRE_AGENTE_DOCUMENTOS,
    model: llm,
    tools: [armarListaDocumentos],
    systemPrompt: PROMPT_SISTEMA_DOCUMENTOS,
    responseFormat: NotasDocumentos,
  });
}

/** Instancia compartida del agente de documentos. */
export const agenteDocumentos = crearAgenteDocumentos();
