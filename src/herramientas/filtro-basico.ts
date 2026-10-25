/**
 * Herramienta `filtro_basico` para el Agente 1 (filtrador).
 *
 * El modelo NUNCA consulta la base de datos directamente. Esta herramienta
 * devuelve los candidatos pre-filtrados de HOY, paginados de a 25.
 * No tiene parámetro de fecha, garantizando que el modelo no altere el día.
 */
import { tool } from "langchain";
import * as z from "zod";
import { descargarHoy } from "../datos/socrata.js";
import { prefiltrar, type Candidato, type ReglaDescarte } from "../filtro/prefiltro.js";

/** Tamaño de página para el filtrador (25 candidatos por llamada). */
export const TAMANO_PAGINA_FILTRO = 25;

/** Largo máximo de descripción para la herramienta (ahorro de tokens). */
export const MAX_DESCRIPCION_HERRAMIENTA = 600;

export interface CandidatoHerramienta {
  id: string;
  nombre: string;
  descripcion: string;
  entidad: string;
  departamento: string;
  tipoDeContrato: string;
  modalidad: string;
  valor: number | null;
  fase: string | null;
}

export interface RespuestaFiltroBasico {
  pagina: number;
  totalPaginas: number;
  totalCandidatos: number;
  estadisticasPrefiltro: Record<ReglaDescarte, number>;
  candidatos: CandidatoHerramienta[];
  error?: string;
}

interface CacheDatos {
  candidatosOrdenados: CandidatoHerramienta[];
  candidatosCompletos: Map<string, Candidato>;
  estadisticasPrefiltro: Record<ReglaDescarte, number>;
  totalPaginas: number;
}

let promesaCache: Promise<CacheDatos> | null = null;

function recortar(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Carga y pre-filtra los datos de hoy UNA SOLA VEZ por ejecución del proceso
 * (memoizado en memoria). Ordena los candidatos por `id_del_proceso`.
 */
export async function cargarDatosMemoizados(): Promise<CacheDatos> {
  promesaCache ??= (async () => {
    const descarga = await descargarHoy();
    const resultado = await prefiltrar(descarga.filas);

    const candidatosCompletos = new Map<string, Candidato>();
    for (const c of resultado.candidatos) {
      candidatosCompletos.set(c.id, c);
    }

    // Ordenamiento estable por id ascendente
    const candidatosOrdenados: CandidatoHerramienta[] = resultado.candidatos
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        nombre: c.nombre,
        descripcion: recortar(c.descripcion, MAX_DESCRIPCION_HERRAMIENTA),
        entidad: c.entidad,
        departamento: c.departamento,
        tipoDeContrato: c.tipoDeContrato,
        modalidad: c.modalidad,
        valor: c.valor,
        fase: c.fase,
      }));

    const totalPaginas = Math.ceil(candidatosOrdenados.length / TAMANO_PAGINA_FILTRO);

    return {
      candidatosOrdenados,
      candidatosCompletos,
      estadisticasPrefiltro: resultado.descartadosPorRegla,
      totalPaginas,
    };
  })();

  return promesaCache;
}

/** Obtiene el candidato completo por id_del_proceso desde la caché memoizada. */
export async function obtenerCandidatoPorId(id: string): Promise<Candidato | undefined> {
  const datos = await cargarDatosMemoizados();
  return datos.candidatosCompletos.get(id);
}

/** Permite reiniciar la caché en pruebas si es necesario. */
export function limpiarCacheFiltroBasico(): void {
  promesaCache = null;
}

/**
 * Función subyacente de la herramienta. Puede llamarse directamente desde el
 * código del runner para consultar páginas o el total de páginas sin llamar al LLM.
 */
export async function obtenerPaginaFiltroBasico(pagina: number): Promise<RespuestaFiltroBasico> {
  const datos = await cargarDatosMemoizados();
  const { candidatosOrdenados, estadisticasPrefiltro, totalPaginas } = datos;
  const totalCandidatos = candidatosOrdenados.length;

  if (totalCandidatos === 0) {
    return {
      pagina,
      totalPaginas: 0,
      totalCandidatos: 0,
      estadisticasPrefiltro,
      candidatos: [],
      error: "No hay candidatos disponibles para el día de hoy.",
    };
  }

  if (pagina < 1 || pagina > totalPaginas) {
    return {
      pagina,
      totalPaginas,
      totalCandidatos,
      estadisticasPrefiltro,
      candidatos: [],
      error: `Página ${pagina} fuera de rango. El rango válido es de 1 a ${totalPaginas}.`,
    };
  }

  const inicio = (pagina - 1) * TAMANO_PAGINA_FILTRO;
  const candidatos = candidatosOrdenados.slice(inicio, inicio + TAMANO_PAGINA_FILTRO);

  return {
    pagina,
    totalPaginas,
    totalCandidatos,
    estadisticasPrefiltro,
    candidatos,
  };
}

export const schemaFiltroBasico = z.object({
  pagina: z.number().int().min(1).describe("Número de página a consultar (comenzando en 1)."),
});

/** Tipo de función proveedora de candidatos por página. */
export type FuenteCandidatos = (pagina: number) => Promise<RespuestaFiltroBasico>;

/**
 * Factory para crear la herramienta `filtro_basico` inyectando una fuente de datos.
 * Por defecto utiliza `obtenerPaginaFiltroBasico` (datos de HOY para producción).
 */
export function crearHerramientaFiltroBasico(fuente: FuenteCandidatos = obtenerPaginaFiltroBasico) {
  return tool(
    async ({ pagina }): Promise<string> => {
      const respuesta = await fuente(pagina);
      return JSON.stringify(respuesta);
    },
    {
      name: "filtro_basico",
      description:
        "Devuelve una página de 25 procesos de SECOP II publicados HOY que ya pasaron el filtro básico por código. Úsala una vez con el número de página indicado.",
      schema: schemaFiltroBasico,
    },
  );
}

/**
 * Tool LangChain `filtro_basico` estándar de producción (HOY memoizado).
 */
export const filtroBasico = crearHerramientaFiltroBasico(obtenerPaginaFiltroBasico);

