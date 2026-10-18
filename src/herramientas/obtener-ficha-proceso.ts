/**
 * Herramienta `obtener_ficha_proceso` para el Agente 2 (resumidor).
 *
 * Construye en CÓDIGO la ficha verificada del proceso a partir de los datos
 * estructurados del dataset principal p6dx-8zbt y consulta en modo best-effort
 * los nombres y tamaños de anexos en dmgg-8hin.
 *
 * REGLAS INMUTABLES:
 * 1. NUNCA realiza peticiones a URLs de community.secop.gov.co/Public/Tendering/OpportunityDetail (protegidas con ReCaptcha).
 * 2. NUNCA descarga archivos ni lee el contenido del pliego.
 * 3. NO entrega URLs al modelo en la ficha (las URLs se reservan para el reporte final).
 */
import { tool } from "langchain";
import * as z from "zod";
import { ENDPOINT_ARCHIVOS } from "../config/secop.js";
import {
  obtenerInstanteReferencia,
  type Candidato,
} from "../filtro/prefiltro.js";
import { obtenerCandidatoPorId } from "./filtro-basico.js";

export interface AnexoFicha {
  nombre: string;
  extension: string;
  tamanoKB: number;
}

export interface AnexoCompleto extends AnexoFicha {
  urlDescarga?: string;
  descripcion?: string;
}

export interface FichaProceso {
  id: string;
  nombre: string;
  descripcion: string;
  entidad: string;
  unidadContratante: string | null;
  departamento: string;
  ciudad: string;
  modalidad: string;
  justificacionModalidad: string | null;
  tipoDeContrato: string;
  fase: string | null;
  valorCOP: number | null;
  fechaPublicacion: string;
  fechaLimiteOfertas: string | null;
  diasRestantes: number | null;
  vencido: boolean | null;
  duracion: {
    cantidad: number | null;
    unidad: string | null;
  };
  lotes: number | null;
  anexos: {
    estado: "con_anexos" | "sin_anexos_indexados" | "no_consultado_por_error";
    total: number;
    truncado: boolean;
    lista: AnexoFicha[];
  };
}

/** Registro local en memoria de candidatos (útil para inyección directa desde el pipeline). */
const registroCandidatos = new Map<string, Candidato>();

/** Registra candidatos en el mapa local para búsqueda inmediata. */
export function registrarCandidatosEnFicha(candidatos: Candidato[]): void {
  for (const c of candidatos) {
    registroCandidatos.set(c.id, c);
  }
}

/** Limpia el registro local de candidatos. */
export function limpiarRegistroCandidatos(): void {
  registroCandidatos.clear();
}

/**
 * Consulta en dmgg-8hin los archivos asociados al portafolio (id_del_portafolio).
 * Aplica timeout de 10 s y 1 reintento. NUNCA descarga el archivo binario.
 */
export async function consultarAnexosPortafolio(
  idPortafolio: string | null,
): Promise<{
  estado: "con_anexos" | "sin_anexos_indexados" | "no_consultado_por_error";
  total: number;
  truncado: boolean;
  lista: AnexoFicha[];
  anexosCompletos: AnexoCompleto[];
}> {
  if (!idPortafolio || !idPortafolio.trim()) {
    return {
      estado: "sin_anexos_indexados",
      total: 0,
      truncado: false,
      lista: [],
      anexosCompletos: [],
    };
  }

  const portafolioLimpio = idPortafolio.replace(/'/g, "''").trim();
  const soqlWhere = `proceso = '${portafolioLimpio}'`;
  const url = `${ENDPOINT_ARCHIVOS}?$where=${encodeURIComponent(
    soqlWhere,
  )}&$limit=200&$select=proceso,nombre_archivo,extensi_n,tamanno_archivo,descripci_n,url_descarga_documento`;

  async function intentarPeticion(): Promise<any[]> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Error Socrata ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as any[];
  }

  let filas: any[] | null = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      filas = await intentarPeticion();
      break;
    } catch (err) {
      if (intento === 2) {
        console.warn(
          `[obtener_ficha_proceso] Falló consulta de anexos para portafolio ${idPortafolio}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (filas === null) {
    return {
      estado: "no_consultado_por_error",
      total: 0,
      truncado: false,
      lista: [],
      anexosCompletos: [],
    };
  }

  if (filas.length === 0) {
    return {
      estado: "sin_anexos_indexados",
      total: 0,
      truncado: false,
      lista: [],
      anexosCompletos: [],
    };
  }

  const anexosCompletos: AnexoCompleto[] = filas.map((f) => {
    const bytes = Number(f.tamanno_archivo);
    const tamanoKB = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024) : 0;
    const urlDescarga =
      typeof f.url_descarga_documento === "object" && f.url_descarga_documento?.url
        ? f.url_descarga_documento.url
        : typeof f.url_descarga_documento === "string"
          ? f.url_descarga_documento
          : undefined;

    return {
      nombre: typeof f.nombre_archivo === "string" ? f.nombre_archivo.trim() : "Sin nombre",
      extension: typeof f.extensi_n === "string" ? f.extensi_n.trim().toLowerCase() : "",
      tamanoKB,
      urlDescarga,
      descripcion: typeof f.descripci_n === "string" ? f.descripci_n.trim() : undefined,
    };
  });

  const listaFicha: AnexoFicha[] = anexosCompletos.slice(0, 30).map((a) => ({
    nombre: a.nombre,
    extension: a.extension,
    tamanoKB: a.tamanoKB,
  }));

  return {
    estado: "con_anexos",
    total: anexosCompletos.length,
    truncado: anexosCompletos.length > 30,
    lista: listaFicha,
    anexosCompletos,
  };
}

/**
 * Construye la ficha técnica verificada en código para un candidato.
 */
export async function construirFichaProceso(
  candidato: Candidato,
  referenciaFecha?: Date | string,
): Promise<{ ficha: FichaProceso; anexosCompletos: AnexoCompleto[] }> {
  const ahora = obtenerInstanteReferencia(referenciaFecha);

  let diasRestantes: number | null = null;
  let vencido: boolean | null = null;

  if (candidato.fechaLimiteOfertas) {
    const isoNormalizado =
      candidato.fechaLimiteOfertas.length >= 19
        ? candidato.fechaLimiteOfertas.slice(0, 19)
        : candidato.fechaLimiteOfertas;
    const fechaMs = new Date(`${isoNormalizado}-05:00`).getTime();
    if (!Number.isNaN(fechaMs)) {
      const diffMs = fechaMs - ahora.getTime();
      vencido = diffMs < 0;
      diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  const resAnexos = await consultarAnexosPortafolio(candidato.idPortafolio);

  const ficha: FichaProceso = {
    id: candidato.id,
    nombre: candidato.nombre,
    descripcion: candidato.descripcion,
    entidad: candidato.entidad,
    unidadContratante: candidato.unidadContratante,
    departamento: candidato.departamento,
    ciudad: candidato.ciudad,
    modalidad: candidato.modalidad,
    justificacionModalidad: candidato.justificacionModalidad,
    tipoDeContrato: candidato.tipoDeContrato,
    fase: candidato.fase,
    valorCOP: candidato.valor,
    fechaPublicacion: candidato.fechaPublicacion ?? "",
    fechaLimiteOfertas: candidato.fechaLimiteOfertas,
    diasRestantes,
    vencido,
    duracion: {
      cantidad: candidato.duracion,
      unidad: candidato.unidadDuracion,
    },
    lotes: candidato.numeroLotes,
    anexos: {
      estado: resAnexos.estado,
      total: resAnexos.total,
      truncado: resAnexos.truncado,
      lista: resAnexos.lista,
    },
  };

  return { ficha, anexosCompletos: resAnexos.anexosCompletos };
}

export const schemaObtenerFichaProceso = z.object({
  id: z.string().describe("Identificador único del proceso en SECOP II (id_del_proceso, ej: 'CO1.REQ.11205497')."),
});

/**
 * Tool LangChain `obtener_ficha_proceso` para el Agente 2.
 */
export const obtenerFichaProceso = tool(
  async ({ id }): Promise<string> => {
    // 1. Buscar en registro en memoria
    let candidato = registroCandidatos.get(id);

    // 2. Si no está en memoria, buscar en la caché de datos de hoy
    if (!candidato) {
      candidato = await obtenerCandidatoPorId(id);
    }

    if (!candidato) {
      return JSON.stringify({
        error: `Proceso con id "${id}" no encontrado en los candidatos del día.`,
      });
    }

    const { ficha } = await construirFichaProceso(candidato);
    return JSON.stringify(ficha);
  },
  {
    name: "obtener_ficha_proceso",
    description:
      "Devuelve la ficha verificada de un proceso de SECOP II (valor, fechas, plazo, duración, lotes, entidad, ubicación, modalidad y nombres de anexos si ya están indexados). No incluye el contenido del pliego.",
    schema: schemaObtenerFichaProceso,
  },
);
