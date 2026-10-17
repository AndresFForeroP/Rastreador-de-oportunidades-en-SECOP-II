/**
 * Parámetros editables del pre-filtro básico (src/filtro/prefiltro.ts).
 * El pre-filtro solo descarta lo que CON CERTEZA no es oportunidad para una pyme.
 * Ante la duda, se conserva: el agente "filtrador" decidirá después.
 */

/**
 * Estados de apertura que implican que ya no se puede ofertar.
 * Valores observados en el dataset: "Abierto" y "Cerrado".
 */
export const ESTADOS_DESCARTADOS: readonly string[] = ["Cerrado"];

/**
 * Tipos de contrato excluidos (DECISIÓN DE CRITERIO, fácil de editar):
 * - "Seguros": solo pueden ofertar aseguradoras vigiladas por la Superfinanciera.
 * - "Concesión": exige capital y garantías fuera del alcance de una pyme.
 * Otros valores observados que se CONSERVAN: Compraventa, Suministros,
 * Prestación de servicios, Obra, Consultoría, Interventoría, Arrendamiento de
 * muebles, Negocio fiduciario, Servicios financieros, Otro.
 */
export const TIPOS_CONTRATO_EXCLUIDOS: readonly string[] = ["Seguros", "Concesión"];

/**
 * Valor máximo en COP (editable). Procesos con precio_base mayor a este valor
 * se descartan por estar fuera de la capacidad financiera típica de una pyme.
 * Precio 0, vacío o no numérico = desconocido => se CONSERVA.
 */
export const VALOR_MAXIMO = 5_000_000_000;

/** Largo máximo de la descripción en el candidato compacto. */
export const LARGO_MAX_DESCRIPCION = 2000;
