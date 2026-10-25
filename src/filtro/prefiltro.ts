/**
 * Pre-filtro básico (código, sin LLM).
 *
 * Descarta SOLO lo que con certeza no es oportunidad para una pyme. Cada fila
 * se descarta por la PRIMERA regla que cumple, en este orden, y se cuenta:
 *
 *  1. modalidad_no_competitiva — la modalidad no está en MODALIDADES_COMPETITIVAS.
 *     Red de seguridad: la consulta a Socrata ya filtra por modalidad.
 *  2. estado_cerrado — estado_de_apertura_del_proceso está en ESTADOS_DESCARTADOS
 *     ("Cerrado"): ya no se puede ofertar.
 *  3. tipo_contrato_excluido — tipo_de_contrato en TIPOS_CONTRATO_EXCLUIDOS
 *     (por defecto "Seguros" y "Concesión"; decisión de criterio editable).
 *  4. valor_supera_maximo — precio_base > VALOR_MAXIMO. Precio 0, vacío o no
 *     numérico se considera DESCONOCIDO y se conserva.
 *  5. id_duplicado — id_del_proceso ya visto en una fila anterior (de cualquier
 *     resultado). Filas sin id no se pueden deduplicar y se conservan.
 *
 * Todo lo demás pasa como candidato para el agente "filtrador".
 */
import { traceable } from "langsmith/traceable";
import { leerFechaPrueba } from "../config/entorno.js";
import {
  DESCARTAR_OFERTA_VENCIDA,
  ESTADOS_DESCARTADOS,
  LARGO_MAX_DESCRIPCION,
  TIPOS_CONTRATO_EXCLUIDOS,
  VALOR_MAXIMO,
} from "../config/prefiltro.js";
import { MODALIDADES_COMPETITIVAS } from "../config/secop.js";
import type { FilaSecop } from "../datos/socrata.js";
import { opcionesTraceable } from "../trazas.js";

export const REGLAS_DESCARTE = [
  "modalidad_no_competitiva",
  "estado_cerrado",
  "tipo_contrato_excluido",
  "valor_supera_maximo",
  "oferta_vencida",
  "id_duplicado",
] as const;

export type ReglaDescarte = (typeof REGLAS_DESCARTE)[number];

/** Proceso compacto enriquecido con campos reales de p6dx-8zbt. */
export interface Candidato {
  id: string;
  nombre: string;
  /** Máximo LARGO_MAX_DESCRIPCION caracteres. */
  descripcion: string;
  entidad: string;
  departamento: string;
  ciudad: string;
  tipoDeContrato: string;
  modalidad: string;
  fase: string | null;
  /** precio_base en COP; null si es 0, vacío o no numérico (desconocido). */
  valor: number | null;
  /** YYYY-MM-DD */
  fechaPublicacion: string | null;
  url: string | null;
  /** fecha_de_recepcion_de (plazo máximo para presentar propuestas) */
  fechaLimiteOfertas: string | null;
  /** duracion numérica estimada del contrato */
  duracion: number | null;
  /** unidad_de_duracion (ej: Mes(es), día(s), Hora(s)) */
  unidadDuracion: string | null;
  /** numero_de_lotes (0 = sin lotes, >0 = número de lotes) */
  numeroLotes: number | null;
  /** justificaci_n_modalidad_de */
  justificacionModalidad: string | null;
  /** nombre_de_la_unidad_de */
  unidadContratante: string | null;
  /** ciudad_de_la_unidad_de */
  ciudadUnidad: string | null;
  /** id_del_portafolio (clave para consultar anexos en dmgg-8hin) */
  idPortafolio: string | null;
}

export interface ResultadoPrefiltro {
  total: number;
  descartadosPorRegla: Record<ReglaDescarte, number>;
  candidatos: Candidato[];
}

export interface DescarteDetalle {
  fila: FilaSecop;
  regla: ReglaDescarte;
}

export interface ResultadoPrefiltroDetalle extends ResultadoPrefiltro {
  descartados: DescarteDetalle[];
}

const modalidades = new Set<string>(MODALIDADES_COMPETITIVAS);
const estadosDescartados = new Set(ESTADOS_DESCARTADOS);
const tiposExcluidos = new Set(TIPOS_CONTRATO_EXCLUIDOS);

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Convierte precio_base a número; 0, vacío o no numérico => null (desconocido). */
export function parsearValor(v: unknown): number | null {
  const s = texto(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Convierte cadenas numéricas generales a number o null si no es finito. */
export function parsearNumero(v: unknown): number | null {
  const s = texto(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function recortar(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Obtiene el instante de referencia para evaluar vigencia en hora Colombia (UTC-5).
 * - En producción: la hora real actual.
 * - En modo prueba (SECOP_FECHA_PRUEBA): el inicio del día de prueba a las 00:00:00.000-05:00,
 *   de modo que una fecha histórica se comporta como si se ejecutara ese mismo día.
 */
export function obtenerInstanteReferencia(referencia?: Date | string): Date {
  if (referencia instanceof Date) return referencia;
  if (typeof referencia === "string" && referencia.trim()) {
    return new Date(`${referencia.slice(0, 10)}T00:00:00.000-05:00`);
  }
  const fechaPrueba = leerFechaPrueba();
  if (fechaPrueba) {
    return new Date(`${fechaPrueba}T00:00:00.000-05:00`);
  }
  return new Date();
}

/**
 * Evalúa si la fecha límite de ofertas ya venció respecto al instante de referencia.
 * Si el campo falta (null, undefined, vacío), se CONSERVA (retorna false).
 */
export function estaOfertaVencida(
  fechaRecepcion: unknown,
  instanteReferencia: Date = obtenerInstanteReferencia(),
): boolean {
  const s = texto(fechaRecepcion);
  if (!s) return false; // Falta la fecha => se conserva
  const isoNormalizado = s.length >= 19 ? s.slice(0, 19) : s;
  const fechaMs = new Date(`${isoNormalizado}-05:00`).getTime();
  if (Number.isNaN(fechaMs)) return false;
  return fechaMs < instanteReferencia.getTime();
}

/** Devuelve la regla que descarta la fila, o null si se conserva. */
function reglaQueDescarta(
  fila: FilaSecop,
  idsVistos: Set<string>,
  instanteReferencia?: Date,
): ReglaDescarte | null {
  const id = texto(fila.id_del_proceso);
  const yaVisto = id !== "" && idsVistos.has(id);
  if (id) idsVistos.add(id);

  if (!modalidades.has(texto(fila.modalidad_de_contratacion))) return "modalidad_no_competitiva";
  if (estadosDescartados.has(texto(fila.estado_de_apertura_del_proceso))) return "estado_cerrado";
  if (tiposExcluidos.has(texto(fila.tipo_de_contrato))) return "tipo_contrato_excluido";
  const valor = parsearValor(fila.precio_base);
  if (valor !== null && valor > VALOR_MAXIMO) return "valor_supera_maximo";
  if (DESCARTAR_OFERTA_VENCIDA && estaOfertaVencida(fila.fecha_de_recepcion_de, instanteReferencia))
    return "oferta_vencida";
  if (yaVisto) return "id_duplicado";
  return null;
}

export function aCandidato(fila: FilaSecop): Candidato {
  const fecha = texto(fila.fecha_de_publicacion_del);
  return {
    id: texto(fila.id_del_proceso),
    nombre: texto(fila.nombre_del_procedimiento),
    descripcion: recortar(texto(fila.descripci_n_del_procedimiento), LARGO_MAX_DESCRIPCION),
    entidad: texto(fila.entidad),
    departamento: texto(fila.departamento_entidad),
    ciudad: texto(fila.ciudad_entidad),
    tipoDeContrato: texto(fila.tipo_de_contrato),
    modalidad: texto(fila.modalidad_de_contratacion),
    fase: texto(fila.fase) || null,
    valor: parsearValor(fila.precio_base),
    fechaPublicacion: fecha ? fecha.slice(0, 10) : null,
    url: texto(fila.urlproceso?.url) || null,
    fechaLimiteOfertas: texto(fila.fecha_de_recepcion_de) || null,
    duracion: parsearNumero(fila.duracion),
    unidadDuracion: texto(fila.unidad_de_duracion) || null,
    numeroLotes: parsearNumero(fila.numero_de_lotes),
    justificacionModalidad: texto(fila.justificaci_n_modalidad_de) || null,
    unidadContratante: texto(fila.nombre_de_la_unidad_de) || null,
    ciudadUnidad: texto(fila.ciudad_de_la_unidad_de) || null,
    idPortafolio: texto(fila.id_del_portafolio) || null,
  };
}

function prefiltrarConReferencia(
  filas: FilaSecop[],
  instanteReferencia?: Date | string,
): ResultadoPrefiltroDetalle {
  const descartadosPorRegla = Object.fromEntries(REGLAS_DESCARTE.map((r) => [r, 0])) as Record<
    ReglaDescarte,
    number
  >;
  const idsVistos = new Set<string>();
  const candidatos: Candidato[] = [];
  const descartados: DescarteDetalle[] = [];
  const refDate = instanteReferencia
    ? obtenerInstanteReferencia(instanteReferencia)
    : obtenerInstanteReferencia();

  for (const fila of filas) {
    const regla = reglaQueDescarta(fila, idsVistos, refDate);
    if (regla) {
      descartadosPorRegla[regla]++;
      descartados.push({ fila, regla });
    } else {
      candidatos.push(aCandidato(fila));
    }
  }
  return { total: filas.length, descartadosPorRegla, candidatos, descartados };
}

function prefiltrarInterno(filas: FilaSecop[]): ResultadoPrefiltroDetalle {
  return prefiltrarConReferencia(filas);
}

/** Ejecuta el prefiltro retornando candidatos y procesos descartados detallados con fecha de referencia opcional. */
export const prefiltrarDetallado = prefiltrarConReferencia;

/**
 * Aplica el pre-filtro básico. Trazado en LangSmith como "prefiltro_basico"
 * (se registra un resumen con los conteos, no todas las filas).
 */
export const prefiltrar = traceable(
  prefiltrarInterno,
  opcionesTraceable<typeof prefiltrarInterno>({
    runName: "prefiltro_basico",
    tags: ["prefiltro"],
    metadata: {
      valor_maximo: VALOR_MAXIMO,
      tipos_excluidos: [...TIPOS_CONTRATO_EXCLUIDOS],
      estados_descartados: [...ESTADOS_DESCARTADOS],
    },
    // Un único argumento iterable llega como { input: [...] }: se registra solo el conteo.
    processInputs: (entrada) => ({ total_filas: entrada.input.length }),
    processOutputs: (r) => ({
      total: r.total,
      descartados_por_regla: r.descartadosPorRegla,
      total_candidatos: r.candidatos.length,
      ids_candidatos: r.candidatos.map((c) => c.id),
    }),
  }),
);
