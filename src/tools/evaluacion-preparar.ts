/**
 * Herramienta CLI: Preparación del dataset de evaluación (S3-3).
 *
 * Genera una plantilla ciega para que el usuario etiquete manualmente
 * los casos de verdad de terreno (Ground Truth), sin sesgo de modelos ni del prefiltro.
 *
 * Uso:
 *   pnpm exec tsx src/tools/evaluacion-preparar.ts [--fechas=AAAA-MM-DD,...] [--semilla=N] [--bloqueA=N] [--bloqueB=N]
 */
import { writeFile } from "node:fs/promises";
import { fechaHoy, obtenerProcesosFecha, type FilaSecop } from "../datos/socrata.js";
import {
  prefiltrarDetallado,
  type Candidato,
  type DescarteDetalle,
  type ReglaDescarte,
} from "../filtro/prefiltro.js";
import {
  asegurarEstructuraPruebas,
  rutaCasosSinEtiquetar,
  rutaClavesPrivadas,
} from "../pruebas/rutas.js";

/** Caso ciego para edición manual del usuario. */
export interface CasoSinEtiquetar {
  caso: number;
  nombre: string;
  descripcion: string;
  entidad: string;
  departamento: string;
  modalidad: string;
  tipoDeContrato: string;
  valorCOP: number | null;
  fechaLimite: string | null;
  etiqueta: "";
  nota: "";
}

/** Metadatos privados de auditoría mapeados por número de caso. */
export interface ClavePrivadaCaso {
  caso: number;
  idDelProceso: string;
  fecha: string;
  bloque: "A" | "B";
  reglaDescarte: ReglaDescarte | null;
  snapshotCompleto: FilaSecop | Candidato;
}

export type BucketValor = "<=10M" | "10-50M" | "50-200M" | ">200M";

export function clasificarBucketValor(valor: number | null): BucketValor {
  if (valor === null || valor <= 10_000_000) return "<=10M";
  if (valor <= 50_000_000) return "10-50M";
  if (valor <= 200_000_000) return "50-200M";
  return ">200M";
}

/** Generador pseudo-aleatorio con semilla fija (Mulberry32). */
function crearPrng(semilla: number): () => number {
  let s = semilla >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Baraja un arreglo de forma determinista usando el PRNG suministrado (Fisher-Yates). */
function barajarConSemilla<T>(array: T[], prng: () => number): T[] {
  const copia = [...array];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const temp = copia[i]!;
    copia[i] = copia[j]!;
    copia[j] = temp;
  }
  return copia;
}

interface Argumentos {
  fechas?: string[];
  semilla: number;
  bloqueA: number;
  bloqueB: number;
}

function parsearArgumentos(): Argumentos {
  const args = process.argv.slice(2);
  let fechas: string[] | undefined;
  let semilla = 42;
  let bloqueA = 40;
  let bloqueB = 15;

  for (const arg of args) {
    if (arg.startsWith("--fechas=")) {
      fechas = arg
        .slice(9)
        .split(/[,\s]+/)
        .map((f) => f.trim())
        .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f));
    } else if (arg.startsWith("--semilla=")) {
      const val = Number.parseInt(arg.slice(10), 10);
      if (!Number.isNaN(val)) semilla = val;
    } else if (arg.startsWith("--bloqueA=")) {
      const val = Number.parseInt(arg.slice(10), 10);
      if (!Number.isNaN(val) && val > 0) bloqueA = val;
    } else if (arg.startsWith("--bloqueB=")) {
      const val = Number.parseInt(arg.slice(10), 10);
      if (!Number.isNaN(val) && val > 0) bloqueB = val;
    }
  }

  return { fechas, semilla, bloqueA, bloqueB };
}

/** Retrocede un día en formato YYYY-MM-DD. */
function diaAnterior(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Determina si una fecha YYYY-MM-DD corresponde a día hábil (lunes a viernes). */
function esDiaHabil(fecha: string): boolean {
  const d = new Date(`${fecha}T12:00:00Z`);
  const diaSemana = d.getUTCDay();
  return diaSemana >= 1 && diaSemana <= 5;
}

/**
 * Busca los últimos 5 días hábiles con al menos 150 procesos competitivos.
 */
async function resolverFechasPorDefecto(): Promise<string[]> {
  const fechasSeleccionadas: string[] = [];
  let fechaCursor = diaAnterior(fechaHoy());

  console.log(`[evaluacion-preparar] Buscando 5 días hábiles con >= 150 procesos competitivos...`);

  while (fechasSeleccionadas.length < 5) {
    if (esDiaHabil(fechaCursor)) {
      try {
        const { filas } = await obtenerProcesosFecha(fechaCursor);
        if (filas.length >= 150) {
          fechasSeleccionadas.push(fechaCursor);
          console.log(`  ✓ ${fechaCursor}: ${filas.length} procesos competitivos (incluido)`);
        } else {
          console.log(`  ✗ ${fechaCursor} omitido: solo tuvo ${filas.length} procesos (< 150)`);
        }
      } catch (err) {
        console.warn(`  ⚠️ Error al consultar ${fechaCursor}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    fechaCursor = diaAnterior(fechaCursor);
  }

  return fechasSeleccionadas;
}

interface CandidatoConFecha {
  candidato: Candidato;
  fecha: string;
}

interface DescarteConFecha {
  descarte: DescarteDetalle;
  fecha: string;
}

/**
 * Estratifica y selecciona candidatos para el Bloque A:
 * - Proporcional por modalidad (al menos 3 por modalidad si está disponible).
 * - Distribuido por buckets de valor.
 * - Reproducible con semilla.
 */
function seleccionarBloqueA(
  pool: CandidatoConFecha[],
  tamanoObjetivo: number,
  prng: () => number,
): CandidatoConFecha[] {
  // 1. Deduplicar por id_del_proceso
  const poolUnico: CandidatoConFecha[] = [];
  const idsVistos = new Set<string>();
  for (const item of pool) {
    if (item.candidato.id && !idsVistos.has(item.candidato.id)) {
      idsVistos.add(item.candidato.id);
      poolUnico.push(item);
    }
  }

  if (poolUnico.length <= tamanoObjetivo) {
    return barajarConSemilla(poolUnico, prng);
  }

  // 2. Agrupar por modalidad
  const porModalidad = new Map<string, CandidatoConFecha[]>();
  for (const item of poolUnico) {
    const mod = item.candidato.modalidad || "Sin Modalidad";
    if (!porModalidad.has(mod)) porModalidad.set(mod, []);
    porModalidad.get(mod)!.push(item);
  }

  const modalidades = [...porModalidad.keys()];
  const cuotas = new Map<string, number>();

  // Asignar base mínima de 3 (o los disponibles)
  let cuotaAsignada = 0;
  for (const mod of modalidades) {
    const disponibles = porModalidad.get(mod)!.length;
    const base = Math.min(3, disponibles);
    cuotas.set(mod, base);
    cuotaAsignada += base;
  }

  // Si la base supera el objetivo, ajustar
  if (cuotaAsignada > tamanoObjetivo) {
    return barajarConSemilla(poolUnico, prng).slice(0, tamanoObjetivo);
  }

  // Distribuir remanente proporcionalmente
  let remanente = tamanoObjetivo - cuotaAsignada;
  const totalDisponibles = poolUnico.length;

  while (remanente > 0) {
    let asignadoEnRonda = false;
    for (const mod of modalidades) {
      if (remanente <= 0) break;
      const disponibles = porModalidad.get(mod)!.length;
      const actual = cuotas.get(mod)!;
      if (actual < disponibles) {
        cuotas.set(mod, actual + 1);
        remanente--;
        asignadoEnRonda = true;
      }
    }
    if (!asignadoEnRonda) break;
  }

  // 3. Dentro de cada modalidad, seleccionar estratificando por bucket de valor
  const seleccionadosA: CandidatoConFecha[] = [];

  for (const mod of modalidades) {
    const itemsMod = porModalidad.get(mod)!;
    const cuotaMod = cuotas.get(mod)!;
    if (cuotaMod <= 0) continue;

    // Agrupar por bucket de valor
    const porBucket = new Map<BucketValor, CandidatoConFecha[]>();
    for (const item of itemsMod) {
      const bucket = clasificarBucketValor(item.candidato.valor);
      if (!porBucket.has(bucket)) porBucket.set(bucket, []);
      porBucket.get(bucket)!.push(item);
    }

    const buckets = [...porBucket.keys()];
    // Barajar los elementos de cada bucket
    for (const b of buckets) {
      porBucket.set(b, barajarConSemilla(porBucket.get(b)!, prng));
    }

    // Tomar al menos 1 por bucket disponible si la cuota lo permite
    let itemsTomadosMod: CandidatoConFecha[] = [];
    for (const b of buckets) {
      if (itemsTomadosMod.length < cuotaMod) {
        const item = porBucket.get(b)!.pop();
        if (item) itemsTomadosMod.push(item);
      }
    }

    // Completar el resto de la cuota de la modalidad con los restantes
    const restantesMod = barajarConSemilla(
      buckets.flatMap((b) => porBucket.get(b)!),
      prng,
    );

    while (itemsTomadosMod.length < cuotaMod && restantesMod.length > 0) {
      itemsTomadosMod.push(restantesMod.pop()!);
    }

    seleccionadosA.push(...itemsTomadosMod);
  }

  return barajarConSemilla(seleccionadosA, prng);
}

/**
 * Selecciona procesos descartados para el Bloque B:
 * - Al menos 2 por cada regla de descarte disponible.
 * - Completa hasta tamanoObjetivo.
 */
function seleccionarBloqueB(
  poolDescartes: DescarteConFecha[],
  tamanoObjetivo: number,
  prng: () => number,
): DescarteConFecha[] {
  // Agrupar por regla de descarte
  const porRegla = new Map<ReglaDescarte, DescarteConFecha[]>();
  for (const item of poolDescartes) {
    const regla = item.descarte.regla;
    if (!porRegla.has(regla)) porRegla.set(regla, []);
    porRegla.get(regla)!.push(item);
  }

  const reglas = [...porRegla.keys()];
  for (const r of reglas) {
    porRegla.set(r, barajarConSemilla(porRegla.get(r)!, prng));
  }

  const seleccionadosB: DescarteConFecha[] = [];

  // Tomar al menos 2 por regla cuando esté disponible
  for (const r of reglas) {
    const itemsRegla = porRegla.get(r)!;
    const aTomar = Math.min(2, itemsRegla.length);
    for (let i = 0; i < aTomar; i++) {
      seleccionadosB.push(itemsRegla.pop()!);
    }
  }

  // Si falta para alcanzar tamanoObjetivo, tomar de las reglas con elementos disponibles
  const restantes = barajarConSemilla(
    reglas.flatMap((r) => porRegla.get(r)!),
    prng,
  );

  while (seleccionadosB.length < tamanoObjetivo && restantes.length > 0) {
    seleccionadosB.push(restantes.pop()!);
  }

  return barajarConSemilla(seleccionadosB, prng);
}

export async function prepararEvaluacion(): Promise<void> {
  const config = parsearArgumentos();
  await asegurarEstructuraPruebas();

  console.log("================================================================================");
  console.log("🎯 PREPARACIÓN DE SET DE EVALUACIÓN HUMANA (S3-3)");
  console.log("Modo: EVALUACION | Semilla determinista:", config.semilla);
  console.log("================================================================================\n");

  const fechas = config.fechas && config.fechas.length > 0
    ? config.fechas
    : await resolverFechasPorDefecto();

  console.log(`\n📅 Fechas seleccionadas (${fechas.length}):`, fechas.join(", "));

  // Descarga y pre-filtrado por fecha
  const poolCandidatos: CandidatoConFecha[] = [];
  const poolDescartes: DescarteConFecha[] = [];
  const conteoPorDia: Record<string, number> = {};

  for (const f of fechas) {
    const { filas, desdeCache } = await obtenerProcesosFecha(f);
    conteoPorDia[f] = filas.length;
    console.log(`  • ${f}: ${filas.length} procesos competitivos ${desdeCache ? "(caché)" : "(descargado)"}`);

    const res = prefiltrarDetallado(filas, f);
    for (const c of res.candidatos) {
      poolCandidatos.push({ candidato: c, fecha: f });
    }
    for (const d of res.descartados) {
      poolDescartes.push({ descarte: d, fecha: f });
    }
  }

  const prng = crearPrng(config.semilla);

  // Seleccionar Bloque A (candidatos) y Bloque B (descartes)
  const bloqueA = seleccionarBloqueA(poolCandidatos, config.bloqueA, prng);
  const bloqueB = seleccionarBloqueB(poolDescartes, config.bloqueB, prng);

  console.log(`\n📦 Muestreo de bloques completado:`);
  console.log(`  • Bloque A (candidatos prefiltrados): ${bloqueA.length} casos`);
  console.log(`  • Bloque B (auditoría de descartes): ${bloqueB.length} casos`);
  console.log(`  • Total casos en evaluación: ${bloqueA.length + bloqueB.length}`);

  // Mezclar Bloque A y Bloque B para anonimización estricta (ciego)
  interface ItemParaMezcla {
    bloque: "A" | "B";
    fecha: string;
    id: string;
    nombre: string;
    descripcion: string;
    entidad: string;
    departamento: string;
    modalidad: string;
    tipoDeContrato: string;
    valorCOP: number | null;
    fechaLimite: string | null;
    reglaDescarte: ReglaDescarte | null;
    snapshotCompleto: FilaSecop | Candidato;
  }

  const listaUnificada: ItemParaMezcla[] = [];

  for (const item of bloqueA) {
    listaUnificada.push({
      bloque: "A",
      fecha: item.fecha,
      id: item.candidato.id,
      nombre: item.candidato.nombre,
      descripcion: (item.candidato.descripcion || "").slice(0, 1200),
      entidad: item.candidato.entidad,
      departamento: item.candidato.departamento,
      modalidad: item.candidato.modalidad,
      tipoDeContrato: item.candidato.tipoDeContrato,
      valorCOP: item.candidato.valor,
      fechaLimite: item.candidato.fechaLimiteOfertas,
      reglaDescarte: null,
      snapshotCompleto: item.candidato,
    });
  }

  for (const item of bloqueB) {
    const fila = item.descarte.fila;
    const descRaw = typeof fila.descripci_n_del_procedimiento === "string" ? fila.descripci_n_del_procedimiento.trim() : "";
    const precioNum = fila.precio_base ? Number(fila.precio_base) : null;
    const valorCOP = precioNum && Number.isFinite(precioNum) && precioNum > 0 ? precioNum : null;

    listaUnificada.push({
      bloque: "B",
      fecha: item.fecha,
      id: String(fila.id_del_proceso || ""),
      nombre: String(fila.nombre_del_procedimiento || "").trim(),
      descripcion: descRaw.slice(0, 1200),
      entidad: String(fila.entidad || "").trim(),
      departamento: String(fila.departamento_entidad || "").trim(),
      modalidad: String(fila.modalidad_de_contratacion || "").trim(),
      tipoDeContrato: String(fila.tipo_de_contrato || "").trim(),
      valorCOP,
      fechaLimite: typeof fila.fecha_de_recepcion_de === "string" ? fila.fecha_de_recepcion_de.trim() : null,
      reglaDescarte: item.descarte.regla,
      snapshotCompleto: fila,
    });
  }

  // Barajar todo junto con la semilla para numeración neutra 1..N
  const listaBarajada = barajarConSemilla(listaUnificada, prng);

  const casosSinEtiquetar: CasoSinEtiquetar[] = [];
  const clavesPrivadas: Record<string, ClavePrivadaCaso> = {};

  for (let i = 0; i < listaBarajada.length; i++) {
    const item = listaBarajada[i]!;
    const numeroCaso = i + 1;

    // Plantilla ciega: NUNCA incluye veredicto, regla de descarte, bloque ni modelo
    casosSinEtiquetar.push({
      caso: numeroCaso,
      nombre: item.nombre,
      descripcion: item.descripcion,
      entidad: item.entidad,
      departamento: item.departamento,
      modalidad: item.modalidad,
      tipoDeContrato: item.tipoDeContrato,
      valorCOP: item.valorCOP,
      fechaLimite: item.fechaLimite,
      etiqueta: "",
      nota: "",
    });

    clavesPrivadas[String(numeroCaso)] = {
      caso: numeroCaso,
      idDelProceso: item.id,
      fecha: item.fecha,
      bloque: item.bloque,
      reglaDescarte: item.reglaDescarte,
      snapshotCompleto: item.snapshotCompleto,
    };
  }

  // Guardar archivos
  const rutaCasos = rutaCasosSinEtiquetar();
  const rutaClaves = rutaClavesPrivadas();

  await writeFile(rutaCasos, JSON.stringify(casosSinEtiquetar, null, 2), "utf8");
  await writeFile(rutaClaves, JSON.stringify(clavesPrivadas, null, 2), "utf8");

  // Mostrar resumen estadístico neutro (sin revelar qué caso pertenece a qué regla o bloque)
  const distModalidad: Record<string, number> = {};
  const distBucket: Record<BucketValor, number> = {
    "<=10M": 0,
    "10-50M": 0,
    "50-200M": 0,
    ">200M": 0,
  };

  for (const c of casosSinEtiquetar) {
    const mod = c.modalidad || "Desconocida";
    distModalidad[mod] = (distModalidad[mod] || 0) + 1;
    distBucket[clasificarBucketValor(c.valorCOP)]++;
  }

  console.log("\n================================================================================");
  console.log("📊 DISTRIBUCIÓN DEL SET COMPLETO (55 CASOS)");
  console.log("================================================================================");
  console.log("Distribución por Modalidad:");
  for (const [mod, cant] of Object.entries(distModalidad).sort((a, b) => b[1] - a[1])) {
    console.log(`  • ${mod.padEnd(45)}: ${cant} casos`);
  }

  console.log("\nDistribución por Rango de Valor (COP):");
  console.log(`  • <= 10 Millones COP                           : ${distBucket["<=10M"]} casos`);
  console.log(`  • 10M - 50 Millones COP                        : ${distBucket["10-50M"]} casos`);
  console.log(`  • 50M - 200 Millones COP                       : ${distBucket["50-200M"]} casos`);
  console.log(`  • > 200 Millones COP                           : ${distBucket[">200M"]} casos`);

  console.log("\n================================================================================");
  console.log("✅ ARCHIVOS GENERADOS CON ÉXITO:");
  console.log(`  📝 Plantilla para etiquetar: data/pruebas-reto/evaluacion/casos-sin-etiquetar.json`);
  console.log(`  🔒 Claves privadas:         data/pruebas-reto/evaluacion/claves-privadas.json`);
  console.log("================================================================================\n");
}

// Ejecución directa
if (process.argv[1]?.endsWith("evaluacion-preparar.ts")) {
  prepararEvaluacion().catch((err) => {
    console.error("❌ Error al preparar la evaluación:", err);
    process.exit(1);
  });
}
