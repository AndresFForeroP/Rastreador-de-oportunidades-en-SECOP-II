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
import {
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
  "id_duplicado",
] as const;

export type ReglaDescarte = (typeof REGLAS_DESCARTE)[number];

/** Proceso compacto que se entrega a los agentes. */
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
}

export interface ResultadoPrefiltro {
  total: number;
  descartadosPorRegla: Record<ReglaDescarte, number>;
  candidatos: Candidato[];
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

function recortar(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Devuelve la regla que descarta la fila, o null si se conserva. */
function reglaQueDescarta(fila: FilaSecop, idsVistos: Set<string>): ReglaDescarte | null {
  const id = texto(fila.id_del_proceso);
  const yaVisto = id !== "" && idsVistos.has(id);
  if (id) idsVistos.add(id);

  if (!modalidades.has(texto(fila.modalidad_de_contratacion))) return "modalidad_no_competitiva";
  if (estadosDescartados.has(texto(fila.estado_de_apertura_del_proceso))) return "estado_cerrado";
  if (tiposExcluidos.has(texto(fila.tipo_de_contrato))) return "tipo_contrato_excluido";
  const valor = parsearValor(fila.precio_base);
  if (valor !== null && valor > VALOR_MAXIMO) return "valor_supera_maximo";
  if (yaVisto) return "id_duplicado";
  return null;
}

function aCandidato(fila: FilaSecop): Candidato {
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
  };
}

function prefiltrarInterno(filas: FilaSecop[]): ResultadoPrefiltro {
  const descartadosPorRegla = Object.fromEntries(REGLAS_DESCARTE.map((r) => [r, 0])) as Record<
    ReglaDescarte,
    number
  >;
  const idsVistos = new Set<string>();
  const candidatos: Candidato[] = [];

  for (const fila of filas) {
    const regla = reglaQueDescarta(fila, idsVistos);
    if (regla) descartadosPorRegla[regla]++;
    else candidatos.push(aCandidato(fila));
  }
  return { total: filas.length, descartadosPorRegla, candidatos };
}

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
