/**
 * Estado persistente atómico, idempotencia por etapa y bitácora de eventos (src/carga/estado.ts).
 *
 * Cumple los requerimientos de S4-1:
 * 1. Persistencia en `data/pruebas-reto/carga/estado.json` mediante escritura atómica
 *    (archivo temporal + sync a disco + rename). Si una escritura se interrumpe antes
 *    del rename, el archivo `estado.json` conserva íntegro el último estado válido.
 * 2. Idempotencia estricta entre reinicios con `esProcesado(id, etapa)` y `marcar(id, etapa)`:
 *    un reinicio jamás reprocesa ni duplica el conteo de un mismo proceso en una etapa.
 * 3. Conteo simultáneo en paralelo de todas las definiciones plausibles de unidad de trabajo,
 *    manteniendo una única constante documentada por defecto (`UNIDAD_TRABAJO_POR_DEFECTO`).
 * 4. Bitácora append-only `data/pruebas-reto/carga/eventos.jsonl` junto a `estado.json`
 *    con `{ timestamp, type, details, tipo, detalles }`, vaciada a disco (`sync`) en cada evento.
 * 5. Sin acumulación creciente de resultados en memoria: todo se transmite a disco.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { DIR_CARGA, rutaEstadoCarga, rutaEventosCarga } from "../pruebas/rutas.js";
import type { EstadoParcialTarea, FuenteDatosTarea } from "./bitacora-tareas.js";

// ============================================================================
// 1. CONSTANTE ÚNICA DOCUMENTADA DE UNIDAD DE TRABAJO Y DEFINICIONES PARALELAS
// ============================================================================

export type DefinicionUnidadTrabajo =
  | "oficialFinAFin"
  | "oficial_fin_a_fin"
  | "evaluados_agente1"
  | "clasificados_si"
  | "completados_agentes_2_3";

/**
 * Constante única documentada que establece la unidad de trabajo por defecto:
 * la definición oficial de S4 (un proceso analizado de principio a fin con resultado final
 * exitoso registrado en bitácora; los procesos fallidos NO cuentan como unidad completada).
 */
export const UNIDAD_TRABAJO_POR_DEFECTO: DefinicionUnidadTrabajo = "oficialFinAFin";

export const DESCRIPCIONES_UNIDADES_TRABAJO: Record<DefinicionUnidadTrabajo, string> = {
  oficialFinAFin:
    "1 proceso analizado de principio a fin con resultado final exitoso (veredicto Agente 1 y, si es 'si', Agentes 2 y 3; fallidos no cuentan)",
  oficial_fin_a_fin:
    "1 proceso analizado de principio a fin con resultado final exitoso (veredicto Agente 1 y, si es 'si', Agentes 2 y 3; fallidos no cuentan)",
  evaluados_agente1: "1 proceso evaluado por el Agente 1 (triaje con veredicto válido)",
  clasificados_si: "1 proceso clasificado como 'si' (apto para Pyme) por el Agente 1",
  completados_agentes_2_3: "1 proceso completado hasta los Agentes 2 (resumen) y 3 (documentos)",
};

// ============================================================================
// 2. TIPOS DE ETAPAS, ESTADO PERSISTENTE Y EVENTOS
// ============================================================================

export type EtapaProcesoCarga =
  | "agente1"
  | "clasificado_si"
  | "agente2"
  | "agente3"
  | "completado_agentes_2_3"
  | "completado"
  | "finalizado"
  | "finalizado_bitacora";

export type EtapaCanonica =
  | "agente1"
  | "clasificado_si"
  | "agente2"
  | "agente3"
  | "finalizadosBitacora";

export interface ContadoresUnidadesCarga {
  /** Procesos evaluados por el Agente 1 */
  evaluadosAgente1: number;
  /** Procesos clasificados como "si" por el Agente 1 */
  clasificadosSi: number;
  /** Procesos completados a través de los Agentes 2 y 3 */
  completadosAgentes2y3: number;
  /** Alias mantenido en sincronía para compatibilidad con S4-0 */
  completadosAgentes123: number;
  /** Tareas fin a fin registradas en bitácora (S4-0) */
  oficialFinAFin: number;
  exitosasFinAFin: number;
  fallidasFinAFin: number;
}

export interface GastoAcumuladoCarga {
  tokensEntrada: number;
  tokensSalida: number;
  tokensTotal: number;
  costoDirectoUSD: number;
  costoAsignadoUSD: number;
  costoTotalUSD: number;
  /** Gasto conservador acumulado medido llamada por llamada en la guarda de presupuesto */
  costoConservadorLlamadasUSD: number;
  /** Número total de llamadas al modelo registradas en el estado */
  llamadasModelo: number;
}

export interface ProcesadosPorEtapaCarga {
  agente1: string[];
  clasificado_si: string[];
  agente2: string[];
  agente3: string[];
  finalizadosBitacora: string[];
}

export interface DatosEstadoPersistenteCarga {
  version: number;
  unidadPorDefecto: DefinicionUnidadTrabajo;
  actualizadoEn: string;
  inicioEjecucion: string;
  ultimoCiclo: number;
  erroresConsecutivos: number;
  ejecucionesInvolucradas: string[];
  contadoresUnidades: ContadoresUnidadesCarga;
  gastoAcumulado: GastoAcumuladoCarga;
  procesadosPorEtapa: ProcesadosPorEtapaCarga;
  tareasEnVuelo: Record<string, EstadoParcialTarea>;
}

export interface EventoCarga {
  timestamp: string;
  /** Nombre del tipo de evento (inglés para compatibilidad con herramientas externas) */
  type: string;
  /** Detalles estructurados del evento (inglés) */
  details: Record<string, unknown>;
  /** Nombre del tipo de evento (español) */
  tipo: string;
  /** Detalles estructurados del evento (español) */
  detalles: Record<string, unknown>;
}

export interface OpcionesMarcarEtapa {
  /** Si en etapa "agente1" el veredicto fue "si", permite marcar simultáneamente "clasificado_si" */
  aptoPyme?: "si" | "no" | "dudoso" | null;
  /** Estado de completitud del resumen del Agente 2 */
  resumenOk?: boolean;
  /** Estado de completitud de la lista de documentos del Agente 3 */
  documentosOk?: boolean;
  /** Indica si la tarea fin a fin fue exitosa (para etapa "finalizado") */
  exito?: boolean;
  /** Número de ciclo opcional para actualizar `ultimoCiclo` */
  ciclo?: number;
  /** ID de ejecución opcional para agregar a `ejecucionesInvolucradas` */
  ejecucionId?: string;
  /** Si es true, escribe también un evento en `eventos.jsonl` */
  emitirEvento?: boolean;
  /** Evita persistir a disco inmediatamente (usado solo en operaciones por lote internas) */
  diferirGuardado?: boolean;
}

export interface OpcionesGestorEstado {
  dirCarga?: string;
  rutaEstado?: string;
  rutaEventos?: string;
}

// ============================================================================
// 3. UTILIDADES INTERNAS
// ============================================================================

export function normalizarEtapa(etapa: EtapaProcesoCarga): EtapaCanonica {
  switch (etapa) {
    case "agente1":
      return "agente1";
    case "clasificado_si":
      return "clasificado_si";
    case "agente2":
      return "agente2";
    case "agente3":
    case "completado_agentes_2_3":
    case "completado":
      return "agente3";
    case "finalizado":
    case "finalizado_bitacora":
      return "finalizadosBitacora";
  }
}

export function crearEstadoInicialVacio(inicio?: string): DatosEstadoPersistenteCarga {
  const ahora = inicio ?? new Date().toISOString();
  return {
    version: 1,
    unidadPorDefecto: UNIDAD_TRABAJO_POR_DEFECTO,
    actualizadoEn: ahora,
    inicioEjecucion: ahora,
    ultimoCiclo: 0,
    erroresConsecutivos: 0,
    ejecucionesInvolucradas: [],
    contadoresUnidades: {
      evaluadosAgente1: 0,
      clasificadosSi: 0,
      completadosAgentes2y3: 0,
      completadosAgentes123: 0,
      oficialFinAFin: 0,
      exitosasFinAFin: 0,
      fallidasFinAFin: 0,
    },
    gastoAcumulado: {
      tokensEntrada: 0,
      tokensSalida: 0,
      tokensTotal: 0,
      costoDirectoUSD: 0,
      costoAsignadoUSD: 0,
      costoTotalUSD: 0,
      costoConservadorLlamadasUSD: 0,
      llamadasModelo: 0,
    },
    procesadosPorEtapa: {
      agente1: [],
      clasificado_si: [],
      agente2: [],
      agente3: [],
      finalizadosBitacora: [],
    },
    tareasEnVuelo: {},
  };
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 4. CLASE PRINCIPAL: GESTOR DE ESTADO PERSISTENTE E IDEMPOTENCIA
// ============================================================================

export class GestorEstadoCarga {
  private readonly dirBase: string;
  private readonly rutaEstado: string;
  private readonly rutaEventos: string;

  private inicializado = false;
  private estado: DatosEstadoPersistenteCarga = crearEstadoInicialVacio();

  private readonly setsEtapa: Record<EtapaCanonica, Set<string>> = {
    agente1: new Set<string>(),
    clasificado_si: new Set<string>(),
    agente2: new Set<string>(),
    agente3: new Set<string>(),
    finalizadosBitacora: new Set<string>(),
  };

  /** IDs de tareas que estaban en `tareasEnVuelo` al arrancar esta instancia (previas a un reinicio) */
  private readonly enVueloPrevioAlInicio = new Set<string>();

  /** Cola de promesas para serializar escrituras a disco dentro del proceso */
  private colaEscritura: Promise<void> = Promise.resolve();

  constructor(opciones: OpcionesGestorEstado = {}) {
    this.dirBase = opciones.dirCarga ?? DIR_CARGA;
    this.rutaEstado =
      opciones.rutaEstado ??
      (opciones.dirCarga ? path.join(this.dirBase, "estado.json") : rutaEstadoCarga());
    this.rutaEventos =
      opciones.rutaEventos ??
      (opciones.dirCarga
        ? path.join(path.dirname(this.rutaEstado), "eventos.jsonl")
        : rutaEventosCarga());
  }

  public obtenerRutas(): { estado: string; eventos: string; dirBase: string } {
    return {
      estado: this.rutaEstado,
      eventos: this.rutaEventos,
      dirBase: this.dirBase,
    };
  }

  /**
   * Hidrata los conjuntos en memoria a partir de un objeto `DatosEstadoPersistenteCarga`
   * leído desde disco y asegura la consistencia entre los conjuntos de IDs y los contadores.
   */
  private hidratarDesdeDatos(parsed: Partial<DatosEstadoPersistenteCarga>): void {
    const base = crearEstadoInicialVacio();
    const contadoresRaw = (parsed.contadoresUnidades ?? {}) as Partial<ContadoresUnidadesCarga>;
    const gastoRaw = (parsed.gastoAcumulado ?? {}) as Partial<GastoAcumuladoCarga>;
    const etapasRaw = (parsed.procesadosPorEtapa ?? {}) as Partial<ProcesadosPorEtapaCarga>;

    this.setsEtapa.agente1.clear();
    this.setsEtapa.clasificado_si.clear();
    this.setsEtapa.agente2.clear();
    this.setsEtapa.agente3.clear();
    this.setsEtapa.finalizadosBitacora.clear();

    for (const id of etapasRaw.agente1 ?? []) this.setsEtapa.agente1.add(id);
    for (const id of etapasRaw.clasificado_si ?? []) this.setsEtapa.clasificado_si.add(id);
    for (const id of etapasRaw.agente2 ?? []) this.setsEtapa.agente2.add(id);
    for (const id of etapasRaw.agente3 ?? []) this.setsEtapa.agente3.add(id);
    for (const id of etapasRaw.finalizadosBitacora ?? []) {
      this.setsEtapa.finalizadosBitacora.add(id);
    }

    const completadosPrevios = Math.max(
      contadoresRaw.completadosAgentes2y3 ?? 0,
      contadoresRaw.completadosAgentes123 ?? 0,
      this.setsEtapa.agente3.size,
    );

    const procesosFinalizadosSinPrefijoTarea = Array.from(this.setsEtapa.finalizadosBitacora).filter(
      (id) => !id.startsWith("tarea_"),
    );

    this.estado = {
      version: parsed.version ?? base.version,
      unidadPorDefecto: parsed.unidadPorDefecto ?? UNIDAD_TRABAJO_POR_DEFECTO,
      actualizadoEn: parsed.actualizadoEn ?? base.actualizadoEn,
      inicioEjecucion: parsed.inicioEjecucion ?? base.inicioEjecucion,
      ultimoCiclo: parsed.ultimoCiclo ?? 0,
      erroresConsecutivos: parsed.erroresConsecutivos ?? 0,
      ejecucionesInvolucradas: Array.isArray(parsed.ejecucionesInvolucradas)
        ? [...parsed.ejecucionesInvolucradas]
        : [],
      contadoresUnidades: {
        evaluadosAgente1: Math.max(
          contadoresRaw.evaluadosAgente1 ?? 0,
          this.setsEtapa.agente1.size,
        ),
        clasificadosSi: Math.max(
          contadoresRaw.clasificadosSi ?? 0,
          this.setsEtapa.clasificado_si.size,
        ),
        completadosAgentes2y3: completadosPrevios,
        completadosAgentes123: completadosPrevios,
        oficialFinAFin: Math.max(
          contadoresRaw.oficialFinAFin ?? 0,
          procesosFinalizadosSinPrefijoTarea.length,
        ),
        exitosasFinAFin: contadoresRaw.exitosasFinAFin ?? 0,
        fallidasFinAFin: contadoresRaw.fallidasFinAFin ?? 0,
      },
      gastoAcumulado: {
        tokensEntrada: gastoRaw.tokensEntrada ?? 0,
        tokensSalida: gastoRaw.tokensSalida ?? 0,
        tokensTotal: gastoRaw.tokensTotal ?? 0,
        costoDirectoUSD: gastoRaw.costoDirectoUSD ?? 0,
        costoAsignadoUSD: gastoRaw.costoAsignadoUSD ?? 0,
        costoTotalUSD: gastoRaw.costoTotalUSD ?? 0,
        costoConservadorLlamadasUSD:
          gastoRaw.costoConservadorLlamadasUSD ?? gastoRaw.costoTotalUSD ?? 0,
        llamadasModelo: gastoRaw.llamadasModelo ?? 0,
      },
      procesadosPorEtapa: {
        agente1: Array.from(this.setsEtapa.agente1),
        clasificado_si: Array.from(this.setsEtapa.clasificado_si),
        agente2: Array.from(this.setsEtapa.agente2),
        agente3: Array.from(this.setsEtapa.agente3),
        finalizadosBitacora: procesosFinalizadosSinPrefijoTarea,
      },
      tareasEnVuelo: { ...(parsed.tareasEnVuelo ?? {}) },
    };

    for (const id of Object.keys(this.estado.tareasEnVuelo)) {
      if (!this.setsEtapa.finalizadosBitacora.has(id)) {
        this.enVueloPrevioAlInicio.add(id);
        const parcial = this.estado.tareasEnVuelo[id];
        if (parcial) {
          parcial.reanudadoTrasReinicio = true;
        }
      }
    }
  }

  /**
   * Si se consulta `esProcesado` de manera síncrona antes de haber llamado a `inicializar()`,
   * carga `estado.json` de forma síncrona si existe en disco.
   */
  private asegurarCargaSincrona(): void {
    if (this.inicializado) return;
    try {
      if (existsSync(this.rutaEstado)) {
        const raw = readFileSync(this.rutaEstado, "utf8");
        const parsed = JSON.parse(raw) as Partial<DatosEstadoPersistenteCarga>;
        this.hidratarDesdeDatos(parsed);
      } else {
        this.estado = crearEstadoInicialVacio();
      }

      // Sincronizar desde bitacora-tareas.jsonl si existe
      const rutaJsonl = path.join(path.dirname(this.rutaEstado), "bitacora-tareas.jsonl");
      if (existsSync(rutaJsonl)) {
        const rawJsonl = readFileSync(rutaJsonl, "utf8");
        const lineas = rawJsonl
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        let oficialCount = 0;
        let exitosasCount = 0;
        let fallidasCount = 0;
        for (const linea of lineas) {
          try {
            const reg = JSON.parse(linea);
            if (reg.idProceso) {
              this.setsEtapa.finalizadosBitacora.add(reg.idProceso);
              this.setsEtapa.agente1.add(reg.idProceso);
              if (reg.resultado?.aptoPyme === "si") {
                this.setsEtapa.clasificado_si.add(reg.idProceso);
              }
              oficialCount++;
              if (reg.exito === true) {
                exitosasCount++;
              } else {
                fallidasCount++;
              }
            }
          } catch {
            // Ignorar línea corrupta aislada
          }
        }
        this.estado.contadoresUnidades.oficialFinAFin = Math.max(
          this.estado.contadoresUnidades.oficialFinAFin,
          oficialCount,
        );
        this.estado.contadoresUnidades.exitosasFinAFin = Math.max(
          this.estado.contadoresUnidades.exitosasFinAFin,
          exitosasCount,
        );
        this.estado.contadoresUnidades.fallidasFinAFin = Math.max(
          this.estado.contadoresUnidades.fallidasFinAFin,
          fallidasCount,
        );
        this.sincronizarArreglosEtapas();
      }
    } catch {
      this.estado = crearEstadoInicialVacio();
    }
    this.inicializado = true;
  }

  /**
   * Inicializa el gestor de estado, creando directorios, cargando `estado.json` si existe
   * y limpiando posibles archivos temporales huérfanos (`.tmp.*`) dejados por una escritura
   * interrumpida previa.
   */
  public async inicializar(): Promise<void> {
    await mkdir(path.dirname(this.rutaEstado), { recursive: true });
    await mkdir(path.dirname(this.rutaEventos), { recursive: true });

    if (!this.inicializado) {
      try {
        const raw = await readFile(this.rutaEstado, "utf8");
        const parsed = JSON.parse(raw) as Partial<DatosEstadoPersistenteCarga>;
        this.hidratarDesdeDatos(parsed);
      } catch {
        this.estado = crearEstadoInicialVacio();
      }

      // Sincronizar procesos ya finalizados en bitacora-tareas.jsonl (garantía de idempotencia tras reinicio)
      try {
        const rutaJsonl = path.join(path.dirname(this.rutaEstado), "bitacora-tareas.jsonl");
        const rawJsonl = await readFile(rutaJsonl, "utf8");
        const lineas = rawJsonl
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        let oficialCount = 0;
        let exitosasCount = 0;
        let fallidasCount = 0;
        for (const linea of lineas) {
          try {
            const reg = JSON.parse(linea);
            if (reg.idProceso) {
              this.setsEtapa.finalizadosBitacora.add(reg.idProceso);
              this.setsEtapa.agente1.add(reg.idProceso);
              if (reg.resultado?.aptoPyme === "si") {
                this.setsEtapa.clasificado_si.add(reg.idProceso);
              }
              oficialCount++;
              if (reg.exito === true) {
                exitosasCount++;
              } else {
                fallidasCount++;
              }
            }
          } catch {
            // Ignorar línea corrupta aislada
          }
        }
        this.estado.contadoresUnidades.oficialFinAFin = Math.max(
          this.estado.contadoresUnidades.oficialFinAFin,
          oficialCount,
        );
        this.estado.contadoresUnidades.exitosasFinAFin = Math.max(
          this.estado.contadoresUnidades.exitosasFinAFin,
          exitosasCount,
        );
        this.estado.contadoresUnidades.fallidasFinAFin = Math.max(
          this.estado.contadoresUnidades.fallidasFinAFin,
          fallidasCount,
        );
        this.sincronizarArreglosEtapas();
      } catch {
        // bitacora-tareas.jsonl aún no existe
      }

      this.inicializado = true;
    }

    // Limpiar archivos temporales huérfanos de escrituras interrumpidas anteriores
    await this.limpiarTemporalesHuerfanos();
  }

  /**
   * Detecta y elimina archivos `${basename(estado.json)}.tmp.*` huérfanos en el directorio.
   * Devuelve la lista de archivos temporales eliminados.
   */
  public async limpiarTemporalesHuerfanos(): Promise<string[]> {
    const dir = path.dirname(this.rutaEstado);
    const prefijoTmp = `${path.basename(this.rutaEstado)}.tmp.`;
    const eliminados: string[] = [];

    try {
      const entradas = await readdir(dir);
      for (const nombre of entradas) {
        if (nombre.startsWith(prefijoTmp)) {
          const rutaCompleta = path.join(dir, nombre);
          try {
            await unlink(rutaCompleta);
            eliminados.push(nombre);
          } catch {
            // Ignorar si otro proceso ya lo eliminó
          }
        }
      }
    } catch {
      // El directorio aún no existe
    }

    return eliminados;
  }

  /**
   * Encola una operación de escritura para garantizar exclusión mutua dentro del proceso.
   */
  public encolarEscritura<T>(fn: () => Promise<T>): Promise<T> {
    const promesa = this.colaEscritura.then(fn, fn);
    this.colaEscritura = promesa.then(
      () => undefined,
      () => undefined,
    );
    return promesa;
  }

  /**
   * Sincroniza los arreglos serializables de `procesadosPorEtapa` desde los Sets en memoria.
   */
  private sincronizarArreglosEtapas(): void {
    this.estado.actualizadoEn = new Date().toISOString();
    this.estado.unidadPorDefecto = UNIDAD_TRABAJO_POR_DEFECTO;
    this.estado.procesadosPorEtapa.agente1 = Array.from(this.setsEtapa.agente1);
    this.estado.procesadosPorEtapa.clasificado_si = Array.from(this.setsEtapa.clasificado_si);
    this.estado.procesadosPorEtapa.agente2 = Array.from(this.setsEtapa.agente2);
    this.estado.procesadosPorEtapa.agente3 = Array.from(this.setsEtapa.agente3);
    this.estado.procesadosPorEtapa.finalizadosBitacora = Array.from(
      this.setsEtapa.finalizadosBitacora,
    ).filter((id) => !id.startsWith("tarea_"));
  }

  /**
   * Escribe `estado.json` de manera atómica:
   * 1. Crea archivo temporal `${estado.json}.tmp.<pid>.<ts>.<hex>` en la misma carpeta.
   * 2. Escribe el contenido JSON completo y ejecuta `fh.sync()` (flush físico a disco).
   * 3. Cierra el descriptor y ejecuta `rename(rutaTmp, rutaEstado)`.
   */
  public async guardarAtomico(opciones?: {
    /** Solo para pruebas: simula un fallo o corte de energía antes del rename atómico */
    simularInterrupcionAntesDeRename?: boolean;
  }): Promise<void> {
    await mkdir(path.dirname(this.rutaEstado), { recursive: true });
    this.sincronizarArreglosEtapas();

    const sufijo = `${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    const rutaTmp = `${this.rutaEstado}.tmp.${sufijo}`;
    const contenidoCompleto = JSON.stringify(this.estado, null, 2) + "\n";

    const fh = await open(rutaTmp, "w");
    try {
      if (opciones?.simularInterrupcionAntesDeRename) {
        // Escribir únicamente la mitad del JSON (truncado/corrupto) en el archivo temporal
        const mitad = Math.max(10, Math.floor(contenidoCompleto.length / 2));
        await fh.writeFile(contenidoCompleto.slice(0, mitad), "utf8");
        await fh.sync();
        throw new Error(
          "Interrupción simulada durante escritura de archivo temporal antes de rename atómico",
        );
      }

      await fh.writeFile(contenidoCompleto, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Rename atómico con reintento breve por si Windows retiene momentáneamente el archivo
    let ultimoError: unknown;
    for (let intento = 0; intento < 4; intento++) {
      try {
        await rename(rutaTmp, this.rutaEstado);
        return;
      } catch (err) {
        ultimoError = err;
        await esperar(15 * (intento + 1));
      }
    }
    throw ultimoError;
  }

  /**
   * Verifica si un proceso `id` ya fue procesado en la `etapa` indicada.
   * Funciona tanto de forma síncrona (`if (estado.esProcesado(id, etapa))`) como
   * asíncrona (`if (await estado.esProcesado(id, etapa))`).
   */
  public esProcesado(id: string, etapa: EtapaProcesoCarga): boolean {
    this.asegurarCargaSincrona();
    const canonica = normalizarEtapa(etapa);
    return this.setsEtapa[canonica].has(id);
  }

  /**
   * Marca un proceso `id` como procesado en la `etapa` indicada de forma idempotente y
   * persiste `estado.json` atómicamente.
   *
   * - Si el proceso YA estaba marcado en esa etapa, devuelve `false` y NO incrementa
   *   ningún contador (evitando doble conteo tras un reinicio o reintento).
   * - Si es la primera vez que se marca en esa etapa, actualiza el conjunto, incrementa
   *   el contador de unidad correspondiente, guarda `estado.json` atómicamente y devuelve `true`.
   */
  public async marcar(
    id: string,
    etapa: EtapaProcesoCarga,
    opciones: OpcionesMarcarEtapa = {},
  ): Promise<boolean> {
    this.asegurarCargaSincrona();
    const canonica = normalizarEtapa(etapa);

    if (this.setsEtapa[canonica].has(id)) {
      return false;
    }

    // Actualización inmediata en memoria para que lecturas síncronas consecutivas sean consistentes
    this.setsEtapa[canonica].add(id);

    if (opciones.ciclo !== undefined && opciones.ciclo > this.estado.ultimoCiclo) {
      this.estado.ultimoCiclo = opciones.ciclo;
    }
    if (
      opciones.ejecucionId &&
      !this.estado.ejecucionesInvolucradas.includes(opciones.ejecucionId)
    ) {
      this.estado.ejecucionesInvolucradas.push(opciones.ejecucionId);
    }

    if (canonica === "agente1") {
      this.estado.contadoresUnidades.evaluadosAgente1 = Math.max(
        this.estado.contadoresUnidades.evaluadosAgente1 + 1,
        this.setsEtapa.agente1.size,
      );
      if (opciones.aptoPyme === "si" && !this.setsEtapa.clasificado_si.has(id)) {
        this.setsEtapa.clasificado_si.add(id);
        this.estado.contadoresUnidades.clasificadosSi = Math.max(
          this.estado.contadoresUnidades.clasificadosSi + 1,
          this.setsEtapa.clasificado_si.size,
        );
      }
    } else if (canonica === "clasificado_si") {
      this.estado.contadoresUnidades.clasificadosSi = Math.max(
        this.estado.contadoresUnidades.clasificadosSi + 1,
        this.setsEtapa.clasificado_si.size,
      );
      if (!this.setsEtapa.agente1.has(id)) {
        this.setsEtapa.agente1.add(id);
        this.estado.contadoresUnidades.evaluadosAgente1 = Math.max(
          this.estado.contadoresUnidades.evaluadosAgente1 + 1,
          this.setsEtapa.agente1.size,
        );
      }
    } else if (canonica === "agente3") {
      const nuevoTotal123 = Math.max(
        this.estado.contadoresUnidades.completadosAgentes2y3 + 1,
        this.setsEtapa.agente3.size,
      );
      this.estado.contadoresUnidades.completadosAgentes2y3 = nuevoTotal123;
      this.estado.contadoresUnidades.completadosAgentes123 = nuevoTotal123;
    } else if (canonica === "finalizadosBitacora" && !id.startsWith("tarea_")) {
      const procesosFinalizados = Array.from(this.setsEtapa.finalizadosBitacora).filter(
        (k) => !k.startsWith("tarea_"),
      ).length;
      this.estado.contadoresUnidades.oficialFinAFin = Math.max(
        this.estado.contadoresUnidades.oficialFinAFin + 1,
        procesosFinalizados,
      );
      if (opciones.exito === true) {
        this.estado.contadoresUnidades.exitosasFinAFin += 1;
        this.estado.erroresConsecutivos = 0;
      } else if (opciones.exito === false) {
        this.estado.contadoresUnidades.fallidasFinAFin += 1;
        this.estado.erroresConsecutivos += 1;
      }

      // S4-FINAL (A.1): Una unidad "si" es éxito oficial completo únicamente cuando
      // resumenOk y documentosOk son ambos verdaderos y exito es true.
      if (
        opciones.aptoPyme === "si" &&
        opciones.resumenOk === true &&
        opciones.documentosOk === true &&
        opciones.exito === true
      ) {
        if (!this.setsEtapa.agente3.has(id)) {
          this.setsEtapa.agente3.add(id);
          const nuevoTotal123 = Math.max(
            this.estado.contadoresUnidades.completadosAgentes2y3 + 1,
            this.setsEtapa.agente3.size,
          );
          this.estado.contadoresUnidades.completadosAgentes2y3 = nuevoTotal123;
          this.estado.contadoresUnidades.completadosAgentes123 = nuevoTotal123;
        }
      }
    }

    if (!opciones.diferirGuardado) {
      await this.encolarEscritura(async () => {
        await this.guardarAtomico();
      });
    }

    if (opciones.emitirEvento) {
      await this.registrarEvento("proceso_etapa_marcada", {
        idProceso: id,
        etapa: canonica,
        aptoPyme: opciones.aptoPyme ?? null,
        ciclo: this.estado.ultimoCiclo,
      });
    }

    return true;
  }

  /**
   * Registra un evento en el archivo append-only `eventos.jsonl` (junto a `estado.json`),
   * haciendo flush inmediato a disco (`fh.sync()`) por cada evento.
   * Nunca acumula eventos en memoria.
   */
  public async registrarEvento(
    tipo: string,
    detalles: Record<string, unknown> = {},
  ): Promise<EventoCarga> {
    const evento: EventoCarga = {
      timestamp: new Date().toISOString(),
      type: tipo,
      details: detalles,
      tipo,
      detalles,
    };

    const linea = JSON.stringify(evento) + "\n";

    await this.encolarEscritura(async () => {
      await mkdir(path.dirname(this.rutaEventos), { recursive: true });
      const fh = await open(this.rutaEventos, "a");
      try {
        await fh.write(linea, null, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
    });

    return evento;
  }

  /**
   * Lee los eventos de `eventos.jsonl` desde disco (útil para verificación en pruebas y reportes).
   */
  public async leerEventos(): Promise<EventoCarga[]> {
    try {
      const raw = await readFile(this.rutaEventos, "utf8");
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as EventoCarga);
    } catch {
      return [];
    }
  }

  /**
   * Registra el consumo de una llamada al modelo o de una tarea en el gasto acumulado
   * del estado persistente y lo guarda en disco si se solicita.
   */
  public async registrarGastoLlamada(params: {
    tokensEntrada: number;
    tokensSalida: number;
    tokensTotal: number;
    costoConservadorUSD: number | null;
    ejecucionId?: string;
    ciclo?: number;
    persistirInmediatamente?: boolean;
  }): Promise<GastoAcumuladoCarga> {
    this.asegurarCargaSincrona();

    this.estado.gastoAcumulado.llamadasModelo += 1;
    this.estado.gastoAcumulado.tokensEntrada += Math.max(0, Math.round(params.tokensEntrada || 0));
    this.estado.gastoAcumulado.tokensSalida += Math.max(0, Math.round(params.tokensSalida || 0));
    this.estado.gastoAcumulado.tokensTotal += Math.max(0, Math.round(params.tokensTotal || 0));

    if (typeof params.costoConservadorUSD === "number" && params.costoConservadorUSD > 0) {
      this.estado.gastoAcumulado.costoConservadorLlamadasUSD = Number(
        (
          this.estado.gastoAcumulado.costoConservadorLlamadasUSD + params.costoConservadorUSD
        ).toFixed(6),
      );
      // Si aún no se ha desglosado por tarea en bitácora, mantener costoTotalUSD al menos en el conservador
      if (
        this.estado.gastoAcumulado.costoTotalUSD <
        this.estado.gastoAcumulado.costoConservadorLlamadasUSD
      ) {
        this.estado.gastoAcumulado.costoTotalUSD =
          this.estado.gastoAcumulado.costoConservadorLlamadasUSD;
      }
    }

    if (params.ciclo !== undefined && params.ciclo > this.estado.ultimoCiclo) {
      this.estado.ultimoCiclo = params.ciclo;
    }
    if (
      params.ejecucionId &&
      !this.estado.ejecucionesInvolucradas.includes(params.ejecucionId)
    ) {
      this.estado.ejecucionesInvolucradas.push(params.ejecucionId);
    }

    if (params.persistirInmediatamente !== false) {
      await this.encolarEscritura(async () => {
        await this.guardarAtomico();
      });
    }

    return { ...this.estado.gastoAcumulado };
  }

  /**
   * Actualiza metadatos operativos del ciclo (ciclo actual, errores consecutivos, ejecucionId).
   */
  public async actualizarMetaCiclo(params: {
    ultimoCiclo?: number;
    erroresConsecutivos?: number;
    incrementarErroresConsecutivos?: boolean;
    reiniciarErroresConsecutivos?: boolean;
    ejecucionId?: string;
    persistir?: boolean;
  }): Promise<void> {
    this.asegurarCargaSincrona();

    if (params.ultimoCiclo !== undefined) {
      this.estado.ultimoCiclo = Math.max(this.estado.ultimoCiclo, params.ultimoCiclo);
    }
    if (params.reiniciarErroresConsecutivos) {
      this.estado.erroresConsecutivos = 0;
    } else if (params.incrementarErroresConsecutivos) {
      this.estado.erroresConsecutivos += 1;
    } else if (params.erroresConsecutivos !== undefined) {
      this.estado.erroresConsecutivos = params.erroresConsecutivos;
    }

    if (
      params.ejecucionId &&
      !this.estado.ejecucionesInvolucradas.includes(params.ejecucionId)
    ) {
      this.estado.ejecucionesInvolucradas.push(params.ejecucionId);
    }

    if (params.persistir !== false) {
      await this.encolarEscritura(async () => {
        await this.guardarAtomico();
      });
    }
  }

  public async actualizarCiclo(ciclo: number, ejecucionId?: string): Promise<void> {
    await this.actualizarMetaCiclo({ ultimoCiclo: ciclo, ejecucionId });
  }

  public async reiniciarErroresConsecutivos(): Promise<void> {
    await this.actualizarMetaCiclo({ reiniciarErroresConsecutivos: true });
  }

  public async registrarErrorConsecutivo(): Promise<void> {
    await this.actualizarMetaCiclo({ incrementarErroresConsecutivos: true });
  }

  /**
   * Obtiene el valor actual del contador para una definición de unidad de trabajo específica
   * (o para `UNIDAD_TRABAJO_POR_DEFECTO` si no se indica).
   */
  public obtenerConteoUnidades(
    definicion: DefinicionUnidadTrabajo = UNIDAD_TRABAJO_POR_DEFECTO,
  ): number {
    this.asegurarCargaSincrona();
    switch (definicion) {
      case "oficialFinAFin":
      case "oficial_fin_a_fin":
        // Criterio oficial S4: los procesos fallidos NO cuentan como unidades completadas para condiciones de parada
        return this.estado.contadoresUnidades.exitosasFinAFin;
      case "evaluados_agente1":
        return this.estado.contadoresUnidades.evaluadosAgente1;
      case "clasificados_si":
        return this.estado.contadoresUnidades.clasificadosSi;
      case "completados_agentes_2_3":
        return this.estado.contadoresUnidades.completadosAgentes2y3;
    }
  }

  /**
   * Devuelve una copia profunda del estado persistente actual.
   */
  public obtenerEstado(): DatosEstadoPersistenteCarga {
    this.asegurarCargaSincrona();
    this.sincronizarArreglosEtapas();
    return JSON.parse(JSON.stringify(this.estado)) as DatosEstadoPersistenteCarga;
  }

  /**
   * Acceso interno controlado para que `GestorBitacoraTareas` actualice `tareasEnVuelo`
   * y el desglose de costos por tarea sobre el mismo estado y la misma cola atómica.
   */
  public obtenerReferenciaInterna(): {
    estado: DatosEstadoPersistenteCarga;
    setsEtapa: Record<EtapaCanonica, Set<string>>;
    enVueloPrevioAlInicio: Set<string>;
  } {
    this.asegurarCargaSincrona();
    return {
      estado: this.estado,
      setsEtapa: this.setsEtapa,
      enVueloPrevioAlInicio: this.enVueloPrevioAlInicio,
    };
  }
}

// ============================================================================
// 5. INSTANCIA COMPARTIDA Y FUNCIONES DE CONVENIENCIA DE NIVEL SUPERIOR
// ============================================================================

let gestorEstadoPorDefecto: GestorEstadoCarga | null = null;

/**
 * Obtiene la instancia compartida por defecto de `GestorEstadoCarga`.
 */
export function obtenerGestorEstado(): GestorEstadoCarga {
  if (!gestorEstadoPorDefecto) {
    gestorEstadoPorDefecto = new GestorEstadoCarga();
  }
  return gestorEstadoPorDefecto;
}

/**
 * Permite reemplazar la instancia compartida por defecto (útil en pruebas aisladas).
 */
export function establecerGestorEstadoPorDefecto(gestor: GestorEstadoCarga | null): void {
  gestorEstadoPorDefecto = gestor;
}

/**
 * Verifica si un `id` ya fue procesado en la `etapa` indicada usando el gestor activo.
 */
export function esProcesado(id: string, etapa: EtapaProcesoCarga): boolean {
  return obtenerGestorEstado().esProcesado(id, etapa);
}

/**
 * Marca un `id` como procesado en la `etapa` indicada de forma idempotente y atómica.
 */
export function marcar(
  id: string,
  etapa: EtapaProcesoCarga,
  opciones?: OpcionesMarcarEtapa,
): Promise<boolean> {
  return obtenerGestorEstado().marcar(id, etapa, opciones);
}

/**
 * Registra un evento en `eventos.jsonl` (append + sync inmediato a disco).
 */
export function registrarEventoCarga(
  tipo: string,
  detalles: Record<string, unknown> = {},
): Promise<EventoCarga> {
  return obtenerGestorEstado().registrarEvento(tipo, detalles);
}

