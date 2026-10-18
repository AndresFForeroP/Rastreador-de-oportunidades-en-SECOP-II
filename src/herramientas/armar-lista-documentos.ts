/**
 * Herramienta `armar_lista_documentos` para el Agente 3 (documentos).
 *
 * Filtra el catálogo general de documentos habilitantes según la modalidad del proceso.
 * AVISO OBLIGATORIO: Es un catálogo general de referencia y NO reemplaza al pliego oficial.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tool } from "langchain";
import * as z from "zod";

export interface ItemCatalogoDocumento {
  id: string;
  nombre: string;
  expide: string | null;
  aplicaA: string[];
  condicion: string | null;
  nota: string | null;
  emisor: string | null;
  respaldoLegal: string | null;
  verificar: boolean;
}

const RUTA_CATALOGO = path.resolve(
  process.cwd(),
  "data",
  "catalogos",
  "documentos-habilitantes.json",
);

let catalogoEnMemoria: ItemCatalogoDocumento[] | null = null;

export function cargarCatalogoDocumentos(): ItemCatalogoDocumento[] {
  if (!catalogoEnMemoria) {
    try {
      const raw = readFileSync(RUTA_CATALOGO, "utf8");
      catalogoEnMemoria = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[armar_lista_documentos] Error al cargar catálogo desde ${RUTA_CATALOGO}:`,
        err instanceof Error ? err.message : err,
      );
      catalogoEnMemoria = [];
    }
  }
  return catalogoEnMemoria!;
}

export const schemaArmarListaDocumentos = z.object({
  modalidad: z
    .string()
    .describe("Modalidad de contratación del proceso (ej: 'Mínima cuantía', 'Licitación pública')."),
  tipoDeContrato: z
    .string()
    .describe("Tipo de contrato (ej: 'Prestación de servicios', 'Compraventa', 'Suministros')."),
});

export type EntradaArmarListaDocumentos = z.infer<typeof schemaArmarListaDocumentos>;

export interface RespuestaArmarListaDocumentos {
  avisoFijo: string;
  modalidadConsultada: string;
  tipoDeContratoConsultado: string;
  totalDocumentos: number;
  documentos: ItemCatalogoDocumento[];
}

export function filtrarDocumentosCatalogo(
  entrada: EntradaArmarListaDocumentos,
): RespuestaArmarListaDocumentos {
  const catalogo = cargarCatalogoDocumentos();
  const modLower = (entrada.modalidad ?? "").trim().toLowerCase();

  let filtrados = catalogo.filter((item) => {
    if (item.aplicaA.includes("todas")) {
      return true;
    }
    return item.aplicaA.some((m) => m.toLowerCase() === modLower);
  });

  // Modalidad desconocida o no coincidente: devolver los aplicables a "todas"
  if (filtrados.length === 0) {
    filtrados = catalogo.filter((item) => item.aplicaA.includes("todas"));
  }

  return {
    avisoFijo:
      "Catálogo general de referencia para pymes: no reemplaza las exigencias concretas del pliego oficial de condiciones en SECOP II.",
    modalidadConsultada: entrada.modalidad,
    tipoDeContratoConsultado: entrada.tipoDeContrato,
    totalDocumentos: filtrados.length,
    documentos: filtrados,
  };
}

/**
 * Mapa explícito de palabras clave para deduplicar anexos y catálogo.
 */
export interface ReglaDeduplicacionAnexo {
  catalogoId: string;
  palabrasClave: string[];
}

export const MAPA_DEDUPLICACION_ANEXOS: ReglaDeduplicacionAnexo[] = [
  {
    catalogoId: "seguridad_social",
    palabrasClave: ["seguridad social", "seguridad_social", "seguridad_soscial", "parafiscales", "aportes a seguridad"],
  },
  {
    catalogoId: "carta_presentacion",
    palabrasClave: ["carta de presentacion", "carta_de_presentacion", "presentacion de la oferta", "presentacion_de_la_oferta"],
  },
  {
    catalogoId: "rut",
    palabrasClave: ["rut", "registro unico tributario"],
  },
  {
    catalogoId: "existencia_representacion",
    palabrasClave: ["existencia y representacion", "camara de comercio", "matricula mercantil"],
  },
  {
    catalogoId: "cedula_representante",
    palabrasClave: ["cedula", "documento de identidad"],
  },
  {
    catalogoId: "antecedentes_disciplinarios",
    palabrasClave: ["antecedentes disciplinarios", "disciplinarios"],
  },
  {
    catalogoId: "antecedentes_fiscales",
    palabrasClave: ["antecedentes fiscales", "responsables fiscales"],
  },
  {
    catalogoId: "antecedentes_judiciales",
    palabrasClave: ["antecedentes judiciales", "medidas correctivas"],
  },
  {
    catalogoId: "rup",
    palabrasClave: ["rup", "registro unico de proponentes"],
  },
  {
    catalogoId: "garantia_seriedad",
    palabrasClave: ["garantia de seriedad", "poliza de seriedad", "seriedad de la oferta"],
  },
  {
    catalogoId: "certificaciones_experiencia",
    palabrasClave: ["certificacion de experiencia", "certificaciones de experiencia", "experiencia previa"],
  },
  {
    catalogoId: "estados_financieros",
    palabrasClave: ["estados financieros", "balance general"],
  },
];

/**
 * Tool LangChain `armar_lista_documentos`.
 * Nunca arroja excepción al modelo (si falla, devuelve fallback con aviso).
 */
export const armarListaDocumentos = tool(
  async (entrada): Promise<string> => {
    try {
      const respuesta = filtrarDocumentosCatalogo(entrada);
      return JSON.stringify(respuesta);
    } catch (err) {
      console.error("[armar_lista_documentos] Error no controlado:", err);
      return JSON.stringify({
        avisoFijo:
          "Catálogo general de referencia para pymes: no reemplaza las exigencias concretas del pliego oficial de condiciones en SECOP II.",
        modalidadConsultada: entrada.modalidad ?? "Desconocida",
        tipoDeContratoConsultado: entrada.tipoDeContrato ?? "Desconocido",
        totalDocumentos: 0,
        documentos: [],
        error: "No fue posible consultar el catálogo en este momento.",
      });
    }
  },
  {
    name: "armar_lista_documentos",
    description:
      "Devuelve el catálogo general de documentos que suele pedirse en procesos de la modalidad indicada. No dice qué exige un proceso concreto: el pliego oficial manda.",
    schema: schemaArmarListaDocumentos,
  },
);
