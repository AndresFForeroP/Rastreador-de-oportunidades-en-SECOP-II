/**
 * Constantes del dataset "SECOP II - Procesos de Contratación" (datos.gov.co).
 * Diccionario de datos completo en docs/CONTEXTO.md.
 */

/** Identificador del dataset en Socrata. */
export const DATASET_ID = "p6dx-8zbt";

/** Endpoint SODA (SoQL: $where, $order, $limit, $offset). */
export const ENDPOINT_SECOP = `https://www.datos.gov.co/resource/${DATASET_ID}.json`;

/** Tamaño de página de la paginación. */
export const TAMANO_PAGINA = 1000;

/**
 * Tope duro de páginas por descarga (100 000 filas). Un día normal trae
 * ~400-650 procesos competitivos; superar este tope indica un error de consulta.
 */
export const MAX_PAGINAS = 100;

/**
 * Modalidades competitivas (cadenas EXACTAS tal como aparecen en el dataset,
 * verificadas contra datos.gov.co). Son las únicas en las que una pyme puede
 * presentar oferta en igualdad de condiciones.
 */
export const MODALIDADES_COMPETITIVAS = [
  "Mínima cuantía",
  "Selección Abreviada de Menor Cuantía",
  "Selección abreviada subasta inversa",
  "Concurso de méritos abierto",
  "Licitación pública",
  "Licitación pública Obra Publica",
] as const;

export type ModalidadCompetitiva = (typeof MODALIDADES_COMPETITIVAS)[number];
