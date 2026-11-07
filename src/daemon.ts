/**
 * Daemon desatendido de 12 horas y procesamiento a escala para el Reto Agente 2026 (S4-2+3).
 *
 * Cumple los requerimientos oficiales de la Semana de Carga (S4-0, S4-1, S4-2+3):
 * 1. Banderas CLI:
 *    --fuente=hoy|historico       (por defecto: hoy; historico es cola de prueba de días pasados)
 *    --fechas=YYYY-MM-DD,...      (lista explícita de fechas pasadas en orden)
 *    --desde-ultimos-dias=N       (toma los últimos N días disponibles en data/dias/)
 *    --unidades=1100              (meta de unidades bajo la definición oficial fin a fin)
 *    --horas=12                   (ventana de tiempo; 0 = sin límite de tiempo)
 *    --lote=25                    (candidatos por ciclo/lote enviado al pipeline)
 *    --presupuesto-usd=<n>        (límite duro de gasto en USD)
 *    --presupuesto-tokens=<n>     (límite duro de tokens facturados; requerido si precios son null)
 *    --dry-run                    (inspección estricta sin llamadas al modelo)
 * 2. Guarda de presupuesto obligatoria: rehúsa arrancar sin tope en USD o tokens.
 * 3. Verificación de pasarela oficial: rehúsa iniciar si la URL no es api.reto.pltk.mx.
 * 4. Pacing continuo: distribuye el trabajo homogéneamente a lo largo de la ventana de horas.
 * 5. Cola histórica: procesa de más reciente a más antiguo, omite días con <150 procesos y
 *    marca modo: "carga".
 * 6. Heartbeat cada 60s en data/pruebas-reto/carga/heartbeat.json.
 * 7. Resiliencia: circuit breaker (enfriamiento tras fallos consecutivos), retiros limpios en SIGINT/SIGTERM.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import "./config/entorno.js";
import { fechaHoy, leerCache } from "./datos/socrata.js";
import { prefiltrar } from "./filtro/prefiltro.js";
import { graph } from "./graph/graph.js";
import type { EstadoGrafo } from "./graph/state.js";
import { MODEL_NAME } from "./llm.js";
import {
  ejecutarConContextoBitacora,
  GestorBitacoraTareas,
  verificarGatewayReto,
} from "./carga/bitacora-tareas.js";
import {
  DESCRIPCIONES_UNIDADES_TRABAJO,
  establecerGestorEstadoPorDefecto,
  GestorEstadoCarga,
  UNIDAD_TRABAJO_POR_DEFECTO,
} from "./carga/estado.js";
import {
  cargarTarifasModeloPresupuesto,
  ejecutarConGuardaPresupuesto,
  GuardaPresupuesto,
  limitadorGatewayGlobal,
  obtenerTiempoPrimerLlamadoMs,
  obtenerYReiniciarBrechaMaximaGateway,
} from "./carga/presupuesto.js";
import {
  calcularCostoEstimado,
  finalizarEjecucion,
  iniciarEjecucion,
} from "./pruebas/registro-ejecuciones.js";
import {
  asegurarEstructuraPruebas,
  DIR_CARGA,
  rutaHeartbeatCarga,
} from "./pruebas/rutas.js";
import {
  cerrarTrazas,
  configEjecucion,
  iniciarTrazas,
  PROYECTO_POR_DEFECTO,
} from "./trazas.js";
import {
  ejecutarConContextoTokens,
  leerRegistrosTokens,
} from "./cost.js";
import { ejecutarEstimacionCarga } from "./tools/estimar-carga.js";
import { generarBitacoraCarga } from "./carga/bitacora.js";

// ============================================================================
// 1. TIPOS Y PARSEO DE ARGUMENTOS CLI
// ============================================================================

export interface OpcionesDaemon {
  fuente: "hoy" | "historico";
  fechas?: string[];
  desdeUltimosDias?: number;
  unidades: number;
  horas: number;
  horasMinimas: number;
  ritmoPorHora?: number;
  lote: number;
  concurrencia: number;
  presupuestoUSD: number | null;
  presupuestoTokens: number | null;
  ignorarProyeccion: boolean;
  dryRun: boolean;
}

export interface ParametroConfigEfectivo<T = any> {
  clave: string;
  valor: T;
  origen: "flag" | "env" | "default";
  detalleOrigen: string;
}

export interface ConfiguracionEfectivaDaemon {
  unidades: ParametroConfigEfectivo<number>;
  horas: ParametroConfigEfectivo<number>;
  horasMinimas: ParametroConfigEfectivo<number>;
  lote: ParametroConfigEfectivo<number>;
  concurrencia: ParametroConfigEfectivo<number>;
  presupuestoTokens: ParametroConfigEfectivo<number | null>;
  presupuestoUSD: ParametroConfigEfectivo<number | null>;
  modelo: ParametroConfigEfectivo<string>;
  fuente: ParametroConfigEfectivo<"hoy" | "historico">;
  diasCola: ParametroConfigEfectivo<string[]>;
}

export function resolverConfiguracionEfectivaDaemon(
  argv: string[] = process.argv.slice(2),
): ConfiguracionEfectivaDaemon {
  // 1. Unidades (default: 1050)
  let unidadesVal = 1050;
  let unidadesOrigen: "flag" | "env" | "default" = "default";
  let unidadesDetalle = "valor por defecto oficial S4-FINAL (1050 unidades)";
  if (process.env.DAEMON_UNIDADES) {
    const v = Number.parseInt(process.env.DAEMON_UNIDADES, 10);
    if (Number.isFinite(v) && v > 0) {
      unidadesVal = v;
      unidadesOrigen = "env";
      unidadesDetalle = "variable DAEMON_UNIDADES en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--unidades=")) {
      const v = Number.parseInt(a.slice("--unidades=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        unidadesVal = v;
        unidadesOrigen = "flag";
        unidadesDetalle = `flag CLI --unidades=${v}`;
      }
    } else if (a === "--unidades" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        unidadesVal = v;
        unidadesOrigen = "flag";
        unidadesDetalle = `flag CLI --unidades ${v}`;
      }
    }
  }

  // 2. Horas (default: 12.5)
  let horasVal = 12.5;
  let horasOrigen: "flag" | "env" | "default" = "default";
  let horasDetalle = "valor por defecto (12.5 horas)";
  if (process.env.DAEMON_HORAS) {
    const v = Number.parseFloat(process.env.DAEMON_HORAS);
    if (Number.isFinite(v) && v >= 0) {
      horasVal = v;
      horasOrigen = "env";
      horasDetalle = "variable DAEMON_HORAS en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--horas=")) {
      const v = Number.parseFloat(a.slice("--horas=".length).trim());
      if (Number.isFinite(v) && v >= 0) {
        horasVal = v;
        horasOrigen = "flag";
        horasDetalle = `flag CLI --horas=${v}`;
      }
    } else if (a === "--horas" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v >= 0) {
        horasVal = v;
        horasOrigen = "flag";
        horasDetalle = `flag CLI --horas ${v}`;
      }
    }
  }

  // 3. Horas mínimas (default: 12.2)
  let horasMinVal = 12.2;
  let horasMinOrigen: "flag" | "env" | "default" = "default";
  let horasMinDetalle = "valor por defecto de seguridad (12.2 horas)";
  if (process.env.DAEMON_HORAS_MINIMAS) {
    const v = Number.parseFloat(process.env.DAEMON_HORAS_MINIMAS);
    if (Number.isFinite(v) && v >= 0) {
      horasMinVal = v;
      horasMinOrigen = "env";
      horasMinDetalle = "variable DAEMON_HORAS_MINIMAS en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--horas-minimas=")) {
      const v = Number.parseFloat(a.slice("--horas-minimas=".length).trim());
      if (Number.isFinite(v) && v >= 0) {
        horasMinVal = v;
        horasMinOrigen = "flag";
        horasMinDetalle = `flag CLI --horas-minimas=${v}`;
      }
    } else if (a === "--horas-minimas" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v >= 0) {
        horasMinVal = v;
        horasMinOrigen = "flag";
        horasMinDetalle = `flag CLI --horas-minimas ${v}`;
      }
    }
  }

  // 4. Lote (default: 6)
  let loteVal = 6;
  let loteOrigen: "flag" | "env" | "default" = "default";
  let loteDetalle = "valor por defecto granular S4-FINAL (6 procesos/lote)";
  if (process.env.DAEMON_LOTE) {
    const v = Number.parseInt(process.env.DAEMON_LOTE, 10);
    if (Number.isFinite(v) && v > 0) {
      loteVal = v;
      loteOrigen = "env";
      loteDetalle = "variable DAEMON_LOTE en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--lote=")) {
      const v = Number.parseInt(a.slice("--lote=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        loteVal = v;
        loteOrigen = "flag";
        loteDetalle = `flag CLI --lote=${v}`;
      }
    } else if (a === "--lote" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        loteVal = v;
        loteOrigen = "flag";
        loteDetalle = `flag CLI --lote ${v}`;
      }
    }
  }

  // 5. Concurrencia (default: 3)
  let concVal = 3;
  let concOrigen: "flag" | "env" | "default" = "default";
  let concDetalle = "valor por defecto (3 llamadas simultáneas)";
  if (process.env.DAEMON_CONCURRENCIA) {
    const v = Number.parseInt(process.env.DAEMON_CONCURRENCIA, 10);
    if (Number.isFinite(v) && v > 0) {
      concVal = v;
      concOrigen = "env";
      concDetalle = "variable DAEMON_CONCURRENCIA en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--concurrencia=")) {
      const v = Number.parseInt(a.slice("--concurrencia=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        concVal = v;
        concOrigen = "flag";
        concDetalle = `flag CLI --concurrencia=${v}`;
      }
    } else if (a === "--concurrencia" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        concVal = v;
        concOrigen = "flag";
        concDetalle = `flag CLI --concurrencia ${v}`;
      }
    }
  }

  // 6. Presupuesto Tokens
  let presTokVal: number | null = null;
  let presTokOrigen: "flag" | "env" | "default" = "default";
  let presTokDetalle = "no configurado por defecto";
  if (process.env.DAEMON_PRESUPUESTO_TOKENS) {
    const v = Number.parseInt(process.env.DAEMON_PRESUPUESTO_TOKENS, 10);
    if (Number.isFinite(v) && v > 0) {
      presTokVal = v;
      presTokOrigen = "env";
      presTokDetalle = "variable DAEMON_PRESUPUESTO_TOKENS en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--presupuesto-tokens=")) {
      const v = Number.parseInt(a.slice("--presupuesto-tokens=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        presTokVal = v;
        presTokOrigen = "flag";
        presTokDetalle = `flag CLI --presupuesto-tokens=${v}`;
      }
    } else if (a === "--presupuesto-tokens" && argv[i + 1]) {
      const v = Number.parseInt(argv[++i]!.trim(), 10);
      if (Number.isFinite(v) && v > 0) {
        presTokVal = v;
        presTokOrigen = "flag";
        presTokDetalle = `flag CLI --presupuesto-tokens ${v}`;
      }
    }
  }

  // 7. Presupuesto USD
  let presUSDVal: number | null = null;
  let presUSDOrigen: "flag" | "env" | "default" = "default";
  let presUSDDetalle = "no configurado por defecto";
  if (process.env.DAEMON_PRESUPUESTO_USD) {
    const v = Number.parseFloat(process.env.DAEMON_PRESUPUESTO_USD);
    if (Number.isFinite(v) && v > 0) {
      presUSDVal = v;
      presUSDOrigen = "env";
      presUSDDetalle = "variable DAEMON_PRESUPUESTO_USD en entorno/.env";
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--presupuesto-usd=")) {
      const v = Number.parseFloat(a.slice("--presupuesto-usd=".length).trim());
      if (Number.isFinite(v) && v > 0) {
        presUSDVal = v;
        presUSDOrigen = "flag";
        presUSDDetalle = `flag CLI --presupuesto-usd=${v}`;
      }
    } else if (a === "--presupuesto-usd" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v > 0) {
        presUSDVal = v;
        presUSDOrigen = "flag";
        presUSDDetalle = `flag CLI --presupuesto-usd ${v}`;
      }
    }
  }

  // 8. Modelo
  const modeloVal = MODEL_NAME;
  const modeloOrigen = "default";
  const modeloDetalle = `modelo oficial inmutable (${MODEL_NAME})`;

  // 9. Fuente
  let fuenteVal: "hoy" | "historico" = "historico";
  let fuenteOrigen: "flag" | "env" | "default" = "default";
  let fuenteDetalle = "valor por defecto para corrida de carga (historico)";
  if (process.env.DAEMON_FUENTE === "hoy" || process.env.DAEMON_FUENTE === "historico") {
    fuenteVal = process.env.DAEMON_FUENTE;
    fuenteOrigen = "env";
    fuenteDetalle = `variable DAEMON_FUENTE=${fuenteVal} en entorno/.env`;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--fuente=")) {
      const v = a.slice("--fuente=".length).trim().toLowerCase();
      if (v === "hoy" || v === "historico") {
        fuenteVal = v;
        fuenteOrigen = "flag";
        fuenteDetalle = `flag CLI --fuente=${v}`;
      }
    } else if (a === "--fuente" && argv[i + 1]) {
      const v = argv[++i]!.trim().toLowerCase();
      if (v === "hoy" || v === "historico") {
        fuenteVal = v;
        fuenteOrigen = "flag";
        fuenteDetalle = `flag CLI --fuente ${v}`;
      }
    }
  }

  // 10. Días de la cola
  let fechasVal: string[] = [];
  let fechasOrigen: "flag" | "env" | "default" = "default";
  let fechasDetalle = "descubrimiento automático en data/dias/";
  if (process.env.DAEMON_FECHAS) {
    fechasVal = process.env.DAEMON_FECHAS.split(",").map((f) => f.trim()).filter(Boolean);
    if (fechasVal.length > 0) {
      fechasOrigen = "env";
      fechasDetalle = `variable DAEMON_FECHAS (${fechasVal.length} fechas)`;
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--fechas=")) {
      fechasVal = a.slice("--fechas=".length).split(",").map((f) => f.trim()).filter(Boolean);
      fechasOrigen = "flag";
      fechasDetalle = `flag CLI --fechas (${fechasVal.length} fechas)`;
    }
  }

  return {
    unidades: { clave: "unidades", valor: unidadesVal, origen: unidadesOrigen, detalleOrigen: unidadesDetalle },
    horas: { clave: "horas", valor: horasVal, origen: horasOrigen, detalleOrigen: horasDetalle },
    horasMinimas: { clave: "horasMinimas", valor: horasMinVal, origen: horasMinOrigen, detalleOrigen: horasMinDetalle },
    lote: { clave: "lote", valor: loteVal, origen: loteOrigen, detalleOrigen: loteDetalle },
    concurrencia: { clave: "concurrencia", valor: concVal, origen: concOrigen, detalleOrigen: concDetalle },
    presupuestoTokens: { clave: "presupuestoTokens", valor: presTokVal, origen: presTokOrigen, detalleOrigen: presTokDetalle },
    presupuestoUSD: { clave: "presupuestoUSD", valor: presUSDVal, origen: presUSDOrigen, detalleOrigen: presUSDDetalle },
    modelo: { clave: "modelo", valor: modeloVal, origen: modeloOrigen, detalleOrigen: modeloDetalle },
    fuente: { clave: "fuente", valor: fuenteVal, origen: fuenteOrigen, detalleOrigen: fuenteDetalle },
    diasCola: { clave: "diasCola", valor: fechasVal, origen: fechasOrigen, detalleOrigen: fechasDetalle },
  };
}

export function parsearArgumentosDaemon(argv: string[] = process.argv.slice(2)): OpcionesDaemon {
  const configEfectiva = resolverConfiguracionEfectivaDaemon(argv);

  let fuente = configEfectiva.fuente.valor;
  let fechas: string[] | undefined = configEfectiva.diasCola.valor.length > 0 ? configEfectiva.diasCola.valor : undefined;
  let desdeUltimosDias: number | undefined = process.env.DAEMON_DESDE_ULTIMOS_DIAS
    ? Number.parseInt(process.env.DAEMON_DESDE_ULTIMOS_DIAS, 10) || undefined
    : undefined;
  let unidades = configEfectiva.unidades.valor;
  let horas = configEfectiva.horas.valor;
  let horasMinimas = configEfectiva.horasMinimas.valor;
  let ritmoPorHora: number | undefined = process.env.DAEMON_RITMO_POR_HORA
    ? Number.parseFloat(process.env.DAEMON_RITMO_POR_HORA) || undefined
    : undefined;
  let lote = configEfectiva.lote.valor;
  let concurrencia = configEfectiva.concurrencia.valor;
  let presupuestoUSD = configEfectiva.presupuestoUSD.valor;
  let presupuestoTokens = configEfectiva.presupuestoTokens.valor;

  let ignorarProyeccion =
    process.env.DAEMON_IGNORAR_PROYECCION === "true" || process.env.DAEMON_IGNORAR_PROYECCION === "1";
  let dryRun =
    process.env.DAEMON_DRY_RUN === "true" || process.env.DAEMON_DRY_RUN === "1";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(`
Uso: pnpm daemon [opciones]

Daemon desatendido de carga para el Reto Agente 2026 (Semana 4).

Opciones:
  --fuente=hoy|historico       Fuente de datos (default: historico)
  --unidades=<n>               Meta de unidades de trabajo oficialFinAFin (default: 1050)
  --horas=<n>                  Ventana máxima en horas (default: 12.5; 0 = sin límite)
  --horas-minimas=<n>          Duración mínima obligatoria en horas (default: 12.2)
  --ritmo-por-hora=<n>         Ritmo explícito de unidades por hora
  --lote=<n>                   Tamaño del lote de candidatos por ciclo (default: 6)
  --concurrencia=<n>           Concurrencia de llamadas al modelo (default: 3)
  --presupuesto-tokens=<n>     Límite duro de tokens facturados (requerido para corrida real)
  --presupuesto-usd=<n>        Límite duro en USD
  --fechas=YYYY-MM-DD,...      Lista explícita de fechas para la cola histórica
  --desde-ultimos-dias=<n>     Cantidad de días recientes a incluir en la cola
  --ignorar-proyeccion         Permite iniciar aun si el presupuesto es menor a P90
  --dry-run                    Inspecciona la cola y calcula proyección sin invocar el modelo
  --help, -h                   Muestra esta ayuda y sale
`);
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--ignorar-proyeccion") {
      ignorarProyeccion = true;
    } else if (arg.startsWith("--desde-ultimos-dias=")) {
      const v = Number.parseInt(arg.slice("--desde-ultimos-dias=".length).trim(), 10);
      if (Number.isFinite(v) && v > 0) desdeUltimosDias = v;
    } else if (arg.startsWith("--ritmo-por-hora=")) {
      const v = Number.parseFloat(arg.slice("--ritmo-por-hora=".length).trim());
      if (Number.isFinite(v) && v > 0) ritmoPorHora = v;
    } else if (arg === "--ritmo-por-hora" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v > 0) ritmoPorHora = v;
    }
  }

  return {
    fuente,
    fechas,
    desdeUltimosDias,
    unidades,
    horas,
    horasMinimas,
    ritmoPorHora,
    lote,
    concurrencia,
    presupuestoUSD,
    presupuestoTokens,
    ignorarProyeccion,
    dryRun,
  };
}

// ============================================================================
// 2. DESCUBRIMIENTO Y ORDENAMIENTO DE LA COLA HISTÓRICA
// ============================================================================

export interface InfoDiaCola {
  fecha: string;
  totalProcesos: number;
  candidatosPrefiltro: number;
  esValido: boolean;
  motivoDescarte?: string;
}

/**
 * Escanea el directorio data/dias/ y devuelve las fechas ordenadas de la más reciente
 * a la más antigua (consumo inverso), evaluando el tope mínimo de 150 procesos.
 */
export async function descubrirColaHistorica(opciones?: {
  fechasEspecificas?: string[];
  desdeUltimosDias?: number;
}): Promise<InfoDiaCola[]> {
  const dirDias = path.resolve(process.cwd(), "data", "dias");
  let nombresArchivos: string[] = [];

  try {
    nombresArchivos = await readdir(dirDias);
  } catch {
    return [];
  }

  // Filtrar archivos YYYY-MM-DD.json
  const regexFecha = /^\d{4}-\d{2}-\d{2}\.json$/;
  let fechas = nombresArchivos
    .filter((f) => regexFecha.test(f))
    .map((f) => f.replace(/\.json$/, ""));

  if (opciones?.fechasEspecificas && opciones.fechasEspecificas.length > 0) {
    const setEspecificas = new Set(opciones.fechasEspecificas);
    fechas = fechas.filter((f) => setEspecificas.has(f));
  }

  // Ordenar de más reciente a más antigua (descendente)
  fechas.sort((a, b) => b.localeCompare(a));

  if (opciones?.desdeUltimosDias && opciones.desdeUltimosDias > 0) {
    fechas = fechas.slice(0, opciones.desdeUltimosDias);
  }

  const cola: InfoDiaCola[] = [];

  for (const fecha of fechas) {
    try {
      const filas = (await leerCache(fecha)) ?? [];
      const totalProcesos = filas.length;

      if (totalProcesos < 150) {
        cola.push({
          fecha,
          totalProcesos,
          candidatosPrefiltro: 0,
          esValido: false,
          motivoDescarte: `menos de 150 procesos (${totalProcesos})`,
        });
        continue;
      }

      // Pre-filtrado determinista en memoria (0 tokens, 0 llamadas a LLM)
      const resPrefiltro = await prefiltrar(filas);
      cola.push({
        fecha,
        totalProcesos,
        candidatosPrefiltro: resPrefiltro.candidatos.length,
        esValido: true,
      });
    } catch (err) {
      cola.push({
        fecha,
        totalProcesos: 0,
        candidatosPrefiltro: 0,
        esValido: false,
        motivoDescarte: `error de lectura: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return cola;
}

// ============================================================================
// 3. HEARTBEAT PERIODICO
// ============================================================================

export interface DatosHeartbeat {
  timestamp: string;
  pid: number;
  cycle: number;
  ciclo: number;
  status:
    | "iniciando"
    | "procesando_lote"
    | "esperando_pacing"
    | "enfriamiento_circuit_breaker"
    | "completado"
    | "detenido"
    | "error_ciclo";
  counters: {
    oficialFinAFin: number;
    exitosasFinAFin: number;
    fallidasFinAFin: number;
    evaluadosAgente1: number;
    clasificadosSi: number;
    completadosAgentes123: number;
  };
  contadores: {
    oficialFinAFin: number;
    exitosasFinAFin: number;
    fallidasFinAFin: number;
    evaluadosAgente1: number;
    clasificadosSi: number;
    completadosAgentes123: number;
  };
  spend: {
    tokensEntrada: number;
    tokensSalida: number;
    tokensTotal: number;
    costoConservadorUSD: number;
    costoTotalUSD: number;
  };
  gasto: {
    tokensEntrada: number;
    tokensSalida: number;
    tokensTotal: number;
    costoTotalUSD: number;
  };
  limites: {
    metaUnidades: number;
    horasObjetivo: number;
    presupuestoTokens: number | null;
    presupuestoUSD: number | null;
  };
  nextBatchTime: string | null;
  proximoLoteEn: string | null;
  duracionTranscurridaSeg: number;
  intervaloCicloSeg: number;
  fuente: "hoy" | "historico";
  fechaActual: string;
}

async function emitirHeartbeat(datos: DatosHeartbeat): Promise<void> {
  const ruta = rutaHeartbeatCarga();
  const contenido = JSON.stringify(datos, null, 2) + "\n";
  try {
    await writeFile(ruta, contenido, "utf8");
  } catch (err) {
    console.warn(`[heartbeat] Advertencia: No se pudo escribir heartbeat.json:`, err);
  }
}

// ============================================================================
// 4. PARTE 2: DRY-RUN (--dry-run)
// ============================================================================

async function ejecutarDryRun(
  opciones: OpcionesDaemon,
  gestorEstado: GestorEstadoCarga,
): Promise<void> {
  console.log("================================================================================");
  console.log("🔍 MODO DRY-RUN: INSPECCIÓN DE COLA, CANDIDATOS Y PROYECCIÓN DE CARGA");
  console.log("   (Sin llamadas al modelo, sin consumo de créditos, verificación determinista)");
  console.log("================================================================================\n");

  const cola = await descubrirColaHistorica({
    fechasEspecificas: opciones.fechas,
    desdeUltimosDias: opciones.desdeUltimosDias,
  });

  const idsExcluidos = new Set(gestorEstado.obtenerEstado().procesadosPorEtapa.agente1);

  console.log(`📋 Configuración solicitada:`);
  console.log(`   • Fuente:                 ${opciones.fuente.toUpperCase()}`);
  console.log(`   • Meta de unidades:       ${opciones.unidades.toLocaleString("es-CO")} unidades`);
  console.log(`   • Ventana de tiempo:      ${opciones.horas} horas`);
  console.log(`   • Tamaño de lote:         ${opciones.lote} procesos/lote`);
  console.log(
    `   • Presupuesto:            ${
      opciones.presupuestoUSD !== null
        ? `$${opciones.presupuestoUSD.toFixed(2)} USD`
        : opciones.presupuestoTokens !== null
        ? `${opciones.presupuestoTokens.toLocaleString("es-CO")} tokens`
        : "No especificado (Requerido para corrida real)"
    }`,
  );
  console.log(`   • Procesados previamente: ${idsExcluidos.size} candidatos registrados en estado.json\n`);

  console.log("📅 Cola de días descubierta en data/dias/ (orden de consumo más reciente a más antiguo):");
  console.log("--------------------------------------------------------------------------------");
  console.log("| Fecha      | Procesos | Candidatos Pre-filtro | Estado     | Observación             |");
  console.log("--------------------------------------------------------------------------------");

  let totalCandidatosDisponibles = 0;
  let diasValidos = 0;
  let diasOmitidos = 0;

  for (const dia of cola) {
    if (dia.esValido) {
      diasValidos++;
      totalCandidatosDisponibles += dia.candidatosPrefiltro;
      console.log(
        `| ${dia.fecha} | ${String(dia.totalProcesos).padStart(8)} | ${String(
          dia.candidatosPrefiltro,
        ).padStart(21)} | VIABLE     | Apto para consumo       |`,
      );
    } else {
      diasOmitidos++;
      console.log(
        `| ${dia.fecha} | ${String(dia.totalProcesos).padStart(8)} | ${String(0).padStart(
          21,
        )} | OMITIDO    | ${(dia.motivoDescarte ?? "").padEnd(23)} |`,
      );
    }
  }
  console.log("--------------------------------------------------------------------------------\n");

  console.log(`📊 Balance de la cola:`);
  console.log(`   • Días viables (≥150 procesos):  ${diasValidos}`);
  console.log(`   • Días omitidos (<150 procesos): ${diasOmitidos}`);
  console.log(`   • Total candidatos viables:      ${totalCandidatosDisponibles.toLocaleString("es-CO")}`);
  console.log(`   • Meta requerida:                ${opciones.unidades.toLocaleString("es-CO")}\n`);

  // Proyección de tiempo y costo mediante el estimador oficial
  const estimacion = await ejecutarEstimacionCarga({
    unidades: opciones.unidades,
    margenPorcentaje: 25,
    lote: opciones.lote,
    silencioso: true,
  });

  const proyeccionOficial =
    estimacion.proyecciones.find((p) => p.definicion === "oficialFinAFin") ??
    estimacion.proyecciones[0]!;

  // S4-7: Cálculo explícito de días a consumir y unidades aportadas por día
  const diasAConsumir: Array<{
    fecha: string;
    totalProcesos: number;
    candidatosDia: number;
    unidadesEsperadas: number;
    acumulado: number;
  }> = [];

  let acumuladoUnidades = 0;
  for (const dia of cola) {
    if (!dia.esValido) continue;
    if (acumuladoUnidades >= opciones.unidades) break;

    const faltantes = opciones.unidades - acumuladoUnidades;
    const aporte = Math.min(dia.candidatosPrefiltro, faltantes);
    acumuladoUnidades += aporte;
    diasAConsumir.push({
      fecha: dia.fecha,
      totalProcesos: dia.totalProcesos,
      candidatosDia: dia.candidatosPrefiltro,
      unidadesEsperadas: aporte,
      acumulado: acumuladoUnidades,
    });
  }

  console.log(`📆 DÍAS A CONSUMIR PARA ALCANZAR LA META (${opciones.unidades.toLocaleString("es-CO")} unidades):`);
  console.log("--------------------------------------------------------------------------------");
  console.log("| Fecha      | Procesos | Candidatos Día | Unidades Aportadas | Acumulado Meta |");
  console.log("--------------------------------------------------------------------------------");
  for (const d of diasAConsumir) {
    console.log(
      `| ${d.fecha} | ${String(d.totalProcesos).padStart(8)} | ${String(d.candidatosDia).padStart(14)} | ${String(d.unidadesEsperadas).padStart(18)} | ${String(d.acumulado).padStart(14)} |`,
    );
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(`   • Días requeridos: ${diasAConsumir.length} de ${diasValidos} días viables disponibles.`);
  console.log(`   • Unidades totales a procesar: ${acumuladoUnidades.toLocaleString("es-CO")} unidades.\n`);

  console.log("📈 Proyección estimada según base empírica medida (escenario P90 / conservador):");
  console.log(`   • Tokens proyectados (con 25% margen): ${proyeccionOficial.p90.presupuestoTokensConMargen.toLocaleString("es-CO")} tokens`);
  if (proyeccionOficial.p90.presupuestoUSDConMargen !== null) {
    console.log(`   • Costo proyectado (con 25% margen):   $${proyeccionOficial.p90.presupuestoUSDConMargen.toFixed(2)} USD`);
  } else {
    console.log(`   • Costo en USD:                        Tarifas en null en config/precios.json (proyección en tokens)`);
  }
  console.log(`   • Duración regulada (con pacing):      ${opciones.horas} horas (mínimo de seguridad: ${opciones.horasMinimas} horas)`);
  console.log(`   • Tasa regulada:                       ${(opciones.unidades / (opciones.horas || 1)).toFixed(1)} unidades/hora (${opciones.lote} candidatos cada ${(((opciones.lote / (opciones.unidades / (opciones.horas || 1))) * 3600) / 60).toFixed(2)} min)\n`);

  // Medición empírica para el cálculo de capacidad (S4-FINAL B.4):
  const segSi = 82.0;
  const segNoSi = 9.5;
  const tasaSi = 0.08;

  const segPonderadosPorUnidad = (tasaSi * segSi) + ((1 - tasaSi) * segNoSi);
  const capacidadUnidadesPorHora = Number(((opciones.concurrencia * 3600) / segPonderadosPorUnidad).toFixed(1));

  const horasObjetivo = opciones.horas > 0 ? opciones.horas : 12.5;
  const ritmoRequeridoParaMeta = Number((opciones.unidades / horasObjetivo).toFixed(1));
  const porcentajeCapacidad = Number(((ritmoRequeridoParaMeta / capacidadUnidadesPorHora) * 100).toFixed(1));

  console.log("⚡ ANÁLISIS DE RENDIMIENTO Y CAPACIDAD EFECTIVA (S4-FINAL B.4):");
  console.log(`   • Concurrencia configurada:                  ${opciones.concurrencia}`);
  console.log(`   • Duración unitaria medida "si" (1+2+3):     ${segSi.toFixed(1)} s/unidad`);
  console.log(`   • Duración unitaria medida no-"si" (A1):     ${segNoSi.toFixed(1)} s/unidad`);
  console.log(`   • Tasa "si" observada:                       ${(tasaSi * 100).toFixed(1)}%`);
  console.log(`   • Duración promedio ponderada:               ${segPonderadosPorUnidad.toFixed(2)} s/unidad`);
  console.log(`   • Capacidad teórica estimada:                ${capacidadUnidadesPorHora} unidades/hora`);
  console.log(`   • Ritmo requerido para ${opciones.unidades} u en ${horasObjetivo}h: ${ritmoRequeridoParaMeta} unidades/hora (${porcentajeCapacidad}% de la capacidad)`);

  if (porcentajeCapacidad > 70.0) {
    console.error("================================================================================");
    console.error(`❌ FALLO DRY-RUN: El ritmo requerido (${ritmoRequeridoParaMeta} u/h) supera el 70% de la capacidad medida (${capacidadUnidadesPorHora} u/h).`);
    console.error(`   El límite del 70% es ${(0.70 * capacidadUnidadesPorHora).toFixed(1)} u/h.`);
    console.error("================================================================================");
    process.exit(1);
  } else {
    console.log(`   • Dictamen de compuerta de ritmo:            CUMPLE (${porcentajeCapacidad}% <= 70.0% de capacidad)`);
  }

  const horasRecomendadas = ritmoRequeridoParaMeta <= (0.70 * capacidadUnidadesPorHora) ? 12.5 : 14.0;
  console.log(`   • Recomendación de duración:                 --horas=${horasRecomendadas}\n`);

  if (totalCandidatosDisponibles < opciones.unidades) {
    const faltantes = opciones.unidades - totalCandidatosDisponibles;
    const diasAdicionalesEstimados = Math.ceil(faltantes / 150);
    console.error("================================================================================");
    console.error(`❌ FALLO DRY-RUN: LOS DÍAS DISPONIBLES NO ALCANZAN LA META SOLICITADA.`);
    console.error(`   Candidatos disponibles: ${totalCandidatosDisponibles} | Meta: ${opciones.unidades}`);
    console.error(`   Faltan al menos ${faltantes} candidatos viables.`);
    console.error(`   Sugerencia: Descargue o agregue al menos ${diasAdicionalesEstimados} día(s) adicional(es) en data/dias/.`);
    console.error("================================================================================");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log(`✅ DRY-RUN EXITOSO: Se dispone de ${totalCandidatosDisponibles} candidatos viables en la cola.`);
  console.log(`   La cola cubre holgadamente la meta de ${opciones.unidades} unidades de trabajo.`);
  console.log(`   Se consumirán ${diasAConsumir.length} días para alcanzar exactamente ${opciones.unidades} unidades.`);
  console.log("================================================================================");
  process.exit(0);
}

// ============================================================================
// 5. DEMONIO PRINCIPAL (src/daemon.ts)
// ============================================================================

async function main(): Promise<void> {
  const opciones = parsearArgumentosDaemon();
  limitadorGatewayGlobal.setMaxConcurrencia(opciones.concurrencia);

  await asegurarEstructuraPruebas();

  const gestorEstado = new GestorEstadoCarga();
  establecerGestorEstadoPorDefecto(gestorEstado);
  await gestorEstado.inicializar();

  // En modo dry-run, ejecutar la verificación y salir inmediatamente sin llamadas al modelo
  if (opciones.dryRun) {
    await ejecutarDryRun(opciones, gestorEstado);
    return;
  }

  // REGLA S4-1: Una corrida larga REHÚSA iniciar sin presupuesto explícito
  if (opciones.presupuestoUSD === null && opciones.presupuestoTokens === null) {
    console.error("\n================================================================================");
    console.error("❌ ERROR: El daemon desatendido de carga REHÚSA iniciar sin un presupuesto explícito.");
    console.error("   Debe proporcionar obligatoriamente una de las dos banderas:");
    console.error("   • --presupuesto-usd=<n>     (Tope financiero en dólares)");
    console.error("   • --presupuesto-tokens=<n>  (Tope estricto en tokens facturados)");
    console.error("================================================================================\n");
    process.exit(1);
  }

  // REGLA S4-7 (Tarea 6): Rieles de presupuesto explícito y cotejo contra proyección P90 del estimador
  const estimacionP90 = await ejecutarEstimacionCarga({
    unidades: opciones.unidades,
    margenPorcentaje: 25,
    lote: opciones.lote,
    silencioso: true,
  });
  const proyeccionDefecto =
    estimacionP90.proyecciones.find((p) => p.definicion === "oficialFinAFin" || p.esPorDefecto) ??
    estimacionP90.proyecciones[0]!;
  const p90Tokens = proyeccionDefecto.p90.tokensEstimados;
  const p90ConMargenTokens = proyeccionDefecto.p90.presupuestoTokensConMargen;

  const capTokens = opciones.presupuestoTokens;
  const precios = await cargarTarifasModeloPresupuesto();
  const preciosConfigurados =
    precios !== null &&
    typeof precios.porMillonEntrada === "number" &&
    typeof precios.porMillonSalida === "number";
  const fuentePrecios = precios?.fuente ?? "no configurada";

  let equivUSDStr = "Tarifas en null en config/precios.json (precios no configurados)";
  let costoCapUSD: number | null = null;
  if (capTokens !== null && preciosConfigurados) {
    costoCapUSD =
      (capTokens * 0.75 * precios!.porMillonEntrada!) / 1_000_000 +
      (capTokens * 0.25 * precios!.porMillonSalida!) / 1_000_000;
    equivUSDStr = `$${costoCapUSD.toFixed(4)} USD`;
  }

  console.log("--------------------------------------------------------------------------------");
  console.log(`🛡️ [daemon:inicio] Configuración de Precios y Presupuesto:`);
  console.log(`   • Precios configurados:      ${preciosConfigurados ? "Sí" : "No"}`);
  if (preciosConfigurados) {
    console.log(`   • Tarifas activas:           $${precios!.porMillonEntrada}/1M entrada, $${precios!.porMillonSalida}/1M salida (USD)`);
    console.log(`   • Fuente de precios:         ${fuentePrecios}`);
    if (precios!.actualizado) {
      console.log(`   • Fecha calibración:         ${precios!.actualizado}`);
    }
  }
  console.log(`   • Tope explícito:            ${capTokens !== null ? `${capTokens.toLocaleString("es-CO")} tokens` : (opciones.presupuestoUSD !== null ? `$${opciones.presupuestoUSD} USD` : "No especificado")}`);
  console.log(`   • Equivalente en USD:        ${equivUSDStr}`);
  console.log(`   • Proyección P90 estimada:   ${p90Tokens.toLocaleString("es-CO")} tokens (con 25% margen: ${p90ConMargenTokens.toLocaleString("es-CO")} tokens)`);
  console.log("--------------------------------------------------------------------------------\n");

  if (capTokens !== null && capTokens < p90Tokens) {
    if (!opciones.ignorarProyeccion) {
      console.error(
        `\n❌ [daemon:presupuesto] RECHAZADO: El tope de presupuesto (${capTokens.toLocaleString("es-CO")} tokens) ` +
          `es menor que la proyección P90 requerida (${p90Tokens.toLocaleString("es-CO")} tokens) para ${opciones.unidades.toLocaleString("es-CO")} unidades.\n` +
          `   El daemon rehúsa arrancar para garantizar que la meta oficial pueda completarse sin agotar créditos a mitad de corrida.\n` +
          `   Para forzar el arranque configure un presupuesto de al menos ${p90Tokens.toLocaleString("es-CO")} tokens ` +
          `o use la bandera --ignorar-proyeccion (DAEMON_IGNORAR_PROYECCION=true).\n`,
      );
      process.exit(1);
    } else {
      console.warn(
        `\n⚠️ [daemon:presupuesto] Advertencia: El tope configurado (${capTokens.toLocaleString("es-CO")} tokens) es inferior a la proyección P90 (${p90Tokens.toLocaleString("es-CO")} tokens), ` +
          `pero se especificó --ignorar-proyeccion. Continuando arranque bajo riesgo del operador...\n`,
      );
    }
  }

  // REGLA S4-0: Verificar gateway oficial del reto
  console.log("[daemon] Verificando pasarela oficial del reto...");
  try {
    verificarGatewayReto();
  } catch (err) {
    console.error("\n❌ ERROR DE GATEWAY:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const gestorBitacora = new GestorBitacoraTareas();
  await gestorBitacora.inicializar();

  const ejecucionId = `daemon-${Date.now()}`;
  const runId = randomUUID();

  const guarda = new GuardaPresupuesto({
    presupuestoUSD: opciones.presupuestoUSD ?? undefined,
    presupuestoTokens: opciones.presupuestoTokens ?? undefined,
    gestorEstado,
    silencioso: false,
    onExit: async (codigo) => {
      try {
        const st = gestorEstado.obtenerEstado();
        await finalizarEjecucion(ejecucionId, {
          tipo: "daemon",
          modo: opciones.fuente === "hoy" ? "hoy" : "carga",
          fechaDatos: colaDias[0] ?? fechaHoy(),
          parametros: opciones as unknown as Record<string, unknown>,
          etapas: {
            candidatos: st.contadoresUnidades.evaluadosAgente1,
            aptos: st.contadoresUnidades.clasificadosSi,
            resumidos: st.contadoresUnidades.completadosAgentes123,
            documentados: st.contadoresUnidades.completadosAgentes123,
          },
          errores: [],
          tokens: {
            entrada: st.gastoAcumulado.tokensEntrada,
            salida: st.gastoAcumulado.tokensSalida,
            razonamiento: null,
            total: st.gastoAcumulado.tokensTotal,
          },
          costoUSD: null,
          langsmith: { proyecto: PROYECTO_POR_DEFECTO, runId, url: null },
        });
      } catch {
        // Ignorar si falla el cierre en el ledger
      }
      process.exit(codigo);
    },
  });
  await guarda.inicializar({ exigirParaCorridaLarga: true });

  // Registro del evento inicial del daemon con configuración de precios y presupuesto
  await gestorEstado.registrarEvento("inicio_daemon", {
    preciosConfigurados,
    precios: {
      porMillonEntrada: precios?.porMillonEntrada ?? null,
      porMillonSalida: precios?.porMillonSalida ?? null,
      fuente: fuentePrecios,
      actualizado: precios?.actualizado ?? null,
    },
    presupuestoTokens: capTokens,
    presupuestoTokensUSD: costoCapUSD !== null ? Number(costoCapUSD.toFixed(4)) : null,
    presupuestoUSD: opciones.presupuestoUSD,
    unidadesObjetivo: opciones.unidades,
    horasObjetivo: opciones.horas,
    horasMinimas: opciones.horasMinimas,
    lote: opciones.lote,
    fuenteCola: opciones.fuente,
  });

  await iniciarTrazas();

  // Construir cola de fechas
  let colaDias: string[] = [];
  if (opciones.fuente === "hoy") {
    colaDias = [fechaHoy()];
  } else {
    const infoCola = await descubrirColaHistorica({
      fechasEspecificas: opciones.fechas,
      desdeUltimosDias: opciones.desdeUltimosDias,
    });
    for (const d of infoCola) {
      if (d.esValido) {
        colaDias.push(d.fecha);
      } else {
        await gestorEstado.registrarEvento("dia_omitido", {
          fecha: d.fecha,
          totalProcesos: d.totalProcesos,
          motivo: d.motivoDescarte,
        });
      }
    }
  }

  if (colaDias.length === 0) {
    console.error("❌ ERROR: No hay fechas válidas en la cola para procesar.");
    process.exit(1);
  }

  const tiempoInicioTotal = Date.now();

  await iniciarEjecucion({
    ejecucionId,
    tipo: "daemon",
    modo: opciones.fuente === "hoy" ? "hoy" : "carga",
    fechaDatos: colaDias[0]!,
    parametros: {
      fuente: opciones.fuente,
      unidadesObjetivo: opciones.unidades,
      horasObjetivo: opciones.horas,
      lote: opciones.lote,
      presupuestoUSD: opciones.presupuestoUSD,
      presupuestoTokens: opciones.presupuestoTokens,
    },
  });

  console.log("================================================================================");
  console.log(`🤖 SECOP II — DAEMON DESATENDIDO DE CARGA (S4)`);
  console.log(`🆔 ID Ejecución:   ${ejecucionId}`);
  console.log(`📅 Modo / Fuente:  ${opciones.fuente === "hoy" ? "HOY (PRODUCCIÓN)" : "HISTÓRICO (COLA DE CARGA)"}`);
  console.log(`🎯 Meta Unidades:  ${opciones.unidades.toLocaleString("es-CO")} (${UNIDAD_TRABAJO_POR_DEFECTO})`);
  console.log(`⏱️ Ventana Tiempo: ${opciones.horas > 0 ? `${opciones.horas} horas` : "Sin límite de tiempo"}`);
  console.log(`📦 Tamaño Lote:    ${opciones.lote} candidatos/ciclo`);
  console.log(`🛡️ Presupuesto:    ${opciones.presupuestoUSD ? `$${opciones.presupuestoUSD} USD` : `${opciones.presupuestoTokens} tokens`}`);
  console.log(`🗓️ Días en cola:   ${colaDias.join(", ")}`);
  console.log("================================================================================\n");

  console.log("********************************************************************************");
  console.log("📢 ATENCIÓN OPERADOR: ANOTE LOS NÚMEROS DE SU PANEL DE CONTROL DEL RETO");
  console.log("   (https://api.reto.pltk.mx) JUSTO ANTES DE INICIAR Y JUSTO DESPUÉS DE FINALIZAR:");
  console.log("   • Total Requests | Prompt Tokens | Output Tokens | Cost USD | Balance USD");
  console.log("********************************************************************************\n");

  let deteniendo = false;
  let intervaloPacingMs = 0;
  let tasaPorHora = 0;
  if (opciones.ritmoPorHora && opciones.ritmoPorHora > 0) {
    tasaPorHora = opciones.ritmoPorHora;
  } else if (opciones.horas > 0 && opciones.unidades > 0) {
    tasaPorHora = opciones.unidades / opciones.horas;
  }

  if (tasaPorHora > 0) {
    intervaloPacingMs = Math.round((opciones.lote / tasaPorHora) * 3600 * 1000);
    console.log(
      `⏱️ [pacing] Ritmo regulado: ${tasaPorHora.toFixed(1)} unidades/hora. ` +
        `Intervalo objetivo entre lotes de ${opciones.lote}: ${(intervaloPacingMs / 1000).toFixed(1)} segundos ` +
        `(${(((intervaloPacingMs / 1000)) / 60).toFixed(2)} min entre lotes).\n`,
    );
  }

  let cicloActual = gestorEstado.obtenerEstado().ultimoCiclo || 0;
  let indiceDia = 0;
  let consecutivosErrores = 0;
  let motivoParada = "completado";
  let ultimoMomentoBitacora = Date.now();
  let numeroHoraCorrida = 0;

  // Manejo elegante de señales del sistema operativo (SIGINT / SIGTERM)
  const terminarGraciosamente = async (senal: string) => {
    if (deteniendo) return;
    deteniendo = true;
    motivoParada = `interrumpido_${senal.toLowerCase()}`;
    console.log(`\n\n🛑 [daemon] Señal ${senal} recibida. Concluyendo ciclo en vuelo y guardando estado...`);
  };

  process.on("SIGINT", () => {
    void terminarGraciosamente("SIGINT");
  });
  process.on("SIGTERM", () => {
    void terminarGraciosamente("SIGTERM");
  });

  // Temporizador de heartbeat cada 60 segundos
  const timerHeartbeat = setInterval(async () => {
    const st = gestorEstado.obtenerEstado();
    await emitirHeartbeat({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      cycle: cicloActual,
      ciclo: cicloActual,
      status: deteniendo ? "detenido" : "procesando_lote",
      counters: st.contadoresUnidades,
      contadores: st.contadoresUnidades,
      spend: {
        tokensEntrada: st.gastoAcumulado.tokensEntrada,
        tokensSalida: st.gastoAcumulado.tokensSalida,
        tokensTotal: st.gastoAcumulado.tokensTotal,
        costoConservadorUSD: st.gastoAcumulado.costoConservadorLlamadasUSD,
        costoTotalUSD: st.gastoAcumulado.costoTotalUSD,
      },
      gasto: {
        tokensEntrada: st.gastoAcumulado.tokensEntrada,
        tokensSalida: st.gastoAcumulado.tokensSalida,
        tokensTotal: st.gastoAcumulado.tokensTotal,
        costoTotalUSD: st.gastoAcumulado.costoTotalUSD,
      },
      limites: {
        metaUnidades: opciones.unidades,
        horasObjetivo: opciones.horas,
        presupuestoTokens: opciones.presupuestoTokens,
        presupuestoUSD: opciones.presupuestoUSD,
      },
      nextBatchTime: null,
      proximoLoteEn: null,
      duracionTranscurridaSeg: Number(((Date.now() - tiempoInicioTotal) / 1000).toFixed(1)),
      intervaloCicloSeg: intervaloPacingMs > 0 ? Math.round(intervaloPacingMs / 1000) : 60,
      fuente: opciones.fuente,
      fechaActual: colaDias[indiceDia] ?? "n/a",
    });
  }, 60_000);

  // Bucle principal desatendido
  try {
    while (!deteniendo) {
      // S4-5 y S4-7: Regeneración horaria de la bitácora y registro de brecha máxima al gateway
      if (Date.now() - ultimoMomentoBitacora >= 3600_000) {
        numeroHoraCorrida++;
        const brechaMaxHora = obtenerYReiniciarBrechaMaximaGateway();
        await gestorEstado.registrarEvento("brecha_maxima_gateway_horaria", {
          hora: numeroHoraCorrida,
          brechaMaximaSeg: brechaMaxHora,
          timestamp: new Date().toISOString(),
        });
        ultimoMomentoBitacora = Date.now();
        try {
          await generarBitacoraCarga({ silencioso: true });
        } catch (err) {
          console.warn("[daemon] Advertencia en regeneración horaria de bitácora:", err);
        }
      }

      // 1. Comprobación de condiciones de parada (S4-7)
      const primerLlamadoTs = obtenerTiempoPrimerLlamadoMs();
      const horasDesdePrimerLlamado = primerLlamadoTs
        ? (Date.now() - primerLlamadoTs) / 3600000
        : (Date.now() - tiempoInicioTotal) / 3600000;

      const exitosasFinAFin = gestorEstado.obtenerConteoUnidades("oficialFinAFin");
      if (exitosasFinAFin >= opciones.unidades) {
        if (horasDesdePrimerLlamado >= opciones.horasMinimas) {
          motivoParada = "meta_y_duracion_minima_cumplidas";
          console.log(
            `\n🎉 [daemon] Meta alcanzada (${exitosasFinAFin} / ${opciones.unidades} unidades) ` +
              `y duración mínima cumplida (${horasDesdePrimerLlamado.toFixed(2)}h >= ${opciones.horasMinimas}h). Finalizando corrida...`,
          );
          break;
        } else {
          console.log(
            `\nℹ️ [daemon:duracion-minima] Meta de unidades alcanzada (${exitosasFinAFin} / ${opciones.unidades}), ` +
              `pero la duración transcurrida desde el primer llamado (${horasDesdePrimerLlamado.toFixed(2)}h) es menor que --horas-minimas (${opciones.horasMinimas}h). ` +
              `Continuando procesamiento real de la cola sin llamadas artificiales...`,
          );
        }
      }

      const tiempoTranscurridoMs = Date.now() - tiempoInicioTotal;
      if (
        opciones.horas > 0 &&
        (tiempoTranscurridoMs >= opciones.horas * 3600 * 1000 ||
          horasDesdePrimerLlamado >= opciones.horas)
      ) {
        motivoParada = "tiempo_limite_alcanzado";
        console.log(
          `\n⏱️ [daemon] Ventana de tiempo cumplida: ${(tiempoTranscurridoMs / 3600000).toFixed(2)} horas transcurridas ` +
            `(${horasDesdePrimerLlamado.toFixed(2)}h desde el primer llamado al modelo).`,
        );
        break;
      }

      if (guarda.haAlcanzadoLimite()) {
        motivoParada = "presupuesto_alcanzado";
        console.log(`\n🛑 [daemon] Límite de presupuesto alcanzado en la guarda.`);
        break;
      }

      // 2. Localizar día activo en la cola con candidatos pendientes
      let fechaActiva: string | null = null;
      let candidatosDisponiblesDia: number = 0;

      while (indiceDia < colaDias.length) {
        const fecha = colaDias[indiceDia]!;
        const filas = (await leerCache(fecha)) ?? [];
        const resPrefiltro = await prefiltrar(filas);
        const procesadosA1 = new Set(gestorEstado.obtenerEstado().procesadosPorEtapa.agente1);
        const restantes = resPrefiltro.candidatos.filter((c) => !procesadosA1.has(c.id));

        if (restantes.length > 0) {
          fechaActiva = fecha;
          candidatosDisponiblesDia = restantes.length;
          break;
        }

        // Día completamente consumido
        console.log(`[daemon] Día ${fecha} completado en su totalidad (0 candidatos pendientes).`);
        await gestorEstado.registrarEvento("dia_completado", { fecha });
        indiceDia++;
      }

      if (!fechaActiva) {
        motivoParada = "cola_agotada";
        console.log(`\n🏁 [daemon] Cola de días agotada: No quedan más candidatos pendientes en las fechas configuradas.`);
        break;
      }

      // 3. Preparación del ciclo
      cicloActual++;
      const inicioCiclo = Date.now();
      await gestorEstado.actualizarCiclo(cicloActual, ejecucionId);

      console.log(`\n================================================================================`);
      console.log(`🔄 [daemon] INICIANDO CICLO ${cicloActual} | Fecha: ${fechaActiva} | Pendientes en día: ${candidatosDisponiblesDia}`);
      console.log(`   Progreso oficial fin a fin: ${exitosasFinAFin} / ${opciones.unidades}`);
      console.log(`================================================================================`);

      await gestorEstado.registrarEvento("ciclo_iniciado", {
        ciclo: cicloActual,
        fecha: fechaActiva,
        lote: opciones.lote,
      });

      // Configurar entorno para la fecha activa
      if (opciones.fuente === "historico") {
        process.env.SECOP_FECHA_PRUEBA = fechaActiva;
      } else {
        delete process.env.SECOP_FECHA_PRUEBA;
      }

      const idsExcluidos = Array.from(gestorEstado.obtenerEstado().procesadosPorEtapa.agente1);

      const estadoInicialGrafo: EstadoGrafo = {
        fecha: fechaActiva,
        modo: opciones.fuente === "hoy" ? "hoy" : "carga",
        fechaReferencia: `${fechaActiva}T00:00:00-05:00`,
        caps: {
          max: opciones.lote,
          maxAptos: opciones.lote,
          incluirDudosos: false,
          completo: false,
          concurrencia: opciones.concurrencia,
        },
        idsExcluidos,
        totalDescargados: 0,
        descartadosPorRegla: {},
        totalCandidatos: 0,
        candidatos: [],
        clasificacionAptos: [],
        conteoClasificacion: { si: 0, no: 0, dudoso: 0 },
        resumenes: [],
        documentos: [],
        errores: [],
        reporteRutas: null,
        tokensTotales: { entrada: 0, salida: 0, total: 0 },
      };

      const configTrace = configEjecucion({
        runName: "secop-ciclo",
        tags: ["secop", "daemon"],
        metadata: {
          ciclo: cicloActual,
          fecha: fechaActiva,
          lote: opciones.lote,
          modo: opciones.fuente === "hoy" ? "hoy" : "carga",
        },
      });

      let errorEnCiclo: unknown = null;

      try {
        await ejecutarConGuardaPresupuesto(guarda, async () => {
          await ejecutarConContextoBitacora(
            {
              gestor: gestorBitacora,
              ejecucionId,
              ciclo: cicloActual,
              fuente: opciones.fuente,
              fechaDatos: fechaActiva!,
            },
            async () => {
              await ejecutarConContextoTokens(
                { ejecucionId, agente: "secop-daemon" },
                async () => {
                  const resultadoGrafo = (await graph.invoke(
                    estadoInicialGrafo,
                    configTrace,
                  )) as EstadoGrafo;

                  // Asegurar que todos los procesos clasificados queden marcados en el gestor de estado
                  for (const c of resultadoGrafo.clasificacionAptos) {
                    await gestorEstado.marcar(c.id, "agente1", {
                      ciclo: cicloActual,
                      ejecucionId,
                      aptoPyme: c.aptoPyme,
                    });
                  }
                },
              );
            },
          );
        });

        consecutivosErrores = 0;
        await gestorEstado.reiniciarErroresConsecutivos();
        await cerrarTrazas();

        const duracionCicloSeg = Number(((Date.now() - inicioCiclo) / 1000).toFixed(1));
        console.log(`✅ [daemon] Ciclo ${cicloActual} concluido exitosamente en ${duracionCicloSeg}s.`);

        await gestorEstado.registrarEvento("ciclo_completado", {
          ciclo: cicloActual,
          fecha: fechaActiva,
          duracionSeg: duracionCicloSeg,
          contadores: gestorEstado.obtenerEstado().contadoresUnidades,
        });
      } catch (err) {
        errorEnCiclo = err;
        consecutivosErrores++;
        await gestorEstado.registrarErrorConsecutivo();
        console.error(`❌ [daemon] Error en ciclo ${cicloActual} (consecutivo ${consecutivosErrores}):`, err);

        await gestorEstado.registrarEvento("ciclo_error", {
          ciclo: cicloActual,
          fecha: fechaActiva,
          consecutivosErrores,
          error: err instanceof Error ? err.message : String(err),
        });

        // Circuito de enfriamiento (Circuit breaker)
        if (consecutivosErrores >= 5) {
          const enfriamientoMs = 15 * 60 * 1000;
          console.warn(
            `\n⚠️ [daemon:circuit-breaker] Se alcanzaron 5 errores consecutivos. Entrando en enfriamiento de 15 minutos...`,
          );
          await emitirHeartbeat({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            cycle: cicloActual,
            ciclo: cicloActual,
            status: "enfriamiento_circuit_breaker",
            counters: gestorEstado.obtenerEstado().contadoresUnidades,
            contadores: gestorEstado.obtenerEstado().contadoresUnidades,
            spend: {
              tokensEntrada: gestorEstado.obtenerEstado().gastoAcumulado.tokensEntrada,
              tokensSalida: gestorEstado.obtenerEstado().gastoAcumulado.tokensSalida,
              tokensTotal: gestorEstado.obtenerEstado().gastoAcumulado.tokensTotal,
              costoConservadorUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoConservadorLlamadasUSD,
              costoTotalUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoTotalUSD,
            },
            gasto: {
              tokensEntrada: gestorEstado.obtenerEstado().gastoAcumulado.tokensEntrada,
              tokensSalida: gestorEstado.obtenerEstado().gastoAcumulado.tokensSalida,
              tokensTotal: gestorEstado.obtenerEstado().gastoAcumulado.tokensTotal,
              costoTotalUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoTotalUSD,
            },
            limites: {
              metaUnidades: opciones.unidades,
              horasObjetivo: opciones.horas,
              presupuestoTokens: opciones.presupuestoTokens,
              presupuestoUSD: opciones.presupuestoUSD,
            },
            nextBatchTime: new Date(Date.now() + enfriamientoMs).toISOString(),
            proximoLoteEn: new Date(Date.now() + enfriamientoMs).toISOString(),
            duracionTranscurridaSeg: Number(((Date.now() - tiempoInicioTotal) / 1000).toFixed(1)),
            intervaloCicloSeg: intervaloPacingMs > 0 ? Math.round(intervaloPacingMs / 1000) : 60,
            fuente: opciones.fuente,
            fechaActual: fechaActiva,
          });

          // Dormir 15 minutos de forma interrumpible
          const corte = Date.now() + enfriamientoMs;
          while (Date.now() < corte && !deteniendo) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } else {
          // Backoff exponencial para errores transitorios
          const esperaMs = Math.min(60_000, 3000 * Math.pow(2, consecutivosErrores - 1));
          console.log(`⏳ [daemon] Esperando ${(esperaMs / 1000).toFixed(1)}s antes de reintentar...`);
          await new Promise((r) => setTimeout(r, esperaMs));
        }
      }

      // 4. Regulación de Pacing entre lotes
      if (!deteniendo && !errorEnCiclo && intervaloPacingMs > 0) {
        const duracionLoteMs = Date.now() - inicioCiclo;
        const tiempoEsperaPacingMs = Math.max(0, intervaloPacingMs - duracionLoteMs);

        if (tiempoEsperaPacingMs > 0) {
          const proximoLoteEn = new Date(Date.now() + tiempoEsperaPacingMs).toISOString();
          console.log(
            `⏱️ [daemon:pacing] Regulando consumo continuo: Próximo lote en ${(
              tiempoEsperaPacingMs / 1000
            ).toFixed(1)}s (${new Date(Date.now() + tiempoEsperaPacingMs).toLocaleTimeString()})...`,
          );

          await emitirHeartbeat({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            cycle: cicloActual,
            ciclo: cicloActual,
            status: "esperando_pacing",
            counters: gestorEstado.obtenerEstado().contadoresUnidades,
            contadores: gestorEstado.obtenerEstado().contadoresUnidades,
            spend: {
              tokensEntrada: gestorEstado.obtenerEstado().gastoAcumulado.tokensEntrada,
              tokensSalida: gestorEstado.obtenerEstado().gastoAcumulado.tokensSalida,
              tokensTotal: gestorEstado.obtenerEstado().gastoAcumulado.tokensTotal,
              costoConservadorUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoConservadorLlamadasUSD,
              costoTotalUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoTotalUSD,
            },
            gasto: {
              tokensEntrada: gestorEstado.obtenerEstado().gastoAcumulado.tokensEntrada,
              tokensSalida: gestorEstado.obtenerEstado().gastoAcumulado.tokensSalida,
              tokensTotal: gestorEstado.obtenerEstado().gastoAcumulado.tokensTotal,
              costoTotalUSD: gestorEstado.obtenerEstado().gastoAcumulado.costoTotalUSD,
            },
            limites: {
              metaUnidades: opciones.unidades,
              horasObjetivo: opciones.horas,
              presupuestoTokens: opciones.presupuestoTokens,
              presupuestoUSD: opciones.presupuestoUSD,
            },
            nextBatchTime: proximoLoteEn,
            proximoLoteEn,
            duracionTranscurridaSeg: Number(((Date.now() - tiempoInicioTotal) / 1000).toFixed(1)),
            intervaloCicloSeg: Math.round(intervaloPacingMs / 1000),
            fuente: opciones.fuente,
            fechaActual: fechaActiva,
          });

          // Dormir de forma interrumpible
          const despertar = Date.now() + tiempoEsperaPacingMs;
          while (Date.now() < despertar && !deteniendo) {
            const paso = Math.min(1000, despertar - Date.now());
            if (paso > 0) await new Promise((r) => setTimeout(r, paso));
          }
        }
      }
    }
  } finally {
    clearInterval(timerHeartbeat);

    const brechaFinal = obtenerYReiniciarBrechaMaximaGateway();
    if (brechaFinal > 0) {
      try {
        await gestorEstado.registrarEvento("brecha_maxima_gateway_horaria", {
          hora: numeroHoraCorrida + 1,
          brechaMaximaSeg: brechaFinal,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Ignorar si falla el registro final
      }
    }

    const duracionFinalTotalSeg = Number(((Date.now() - tiempoInicioTotal) / 1000).toFixed(1));
    const stFinal = gestorEstado.obtenerEstado();

    await emitirHeartbeat({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      cycle: cicloActual,
      ciclo: cicloActual,
      status: "completado",
      counters: stFinal.contadoresUnidades,
      contadores: stFinal.contadoresUnidades,
      spend: {
        tokensEntrada: stFinal.gastoAcumulado.tokensEntrada,
        tokensSalida: stFinal.gastoAcumulado.tokensSalida,
        tokensTotal: stFinal.gastoAcumulado.tokensTotal,
        costoConservadorUSD: stFinal.gastoAcumulado.costoConservadorLlamadasUSD,
        costoTotalUSD: stFinal.gastoAcumulado.costoTotalUSD,
      },
      gasto: {
        tokensEntrada: stFinal.gastoAcumulado.tokensEntrada,
        tokensSalida: stFinal.gastoAcumulado.tokensSalida,
        tokensTotal: stFinal.gastoAcumulado.tokensTotal,
        costoTotalUSD: stFinal.gastoAcumulado.costoTotalUSD,
      },
      limites: {
        metaUnidades: opciones.unidades,
        horasObjetivo: opciones.horas,
        presupuestoTokens: opciones.presupuestoTokens,
        presupuestoUSD: opciones.presupuestoUSD,
      },
      nextBatchTime: null,
      proximoLoteEn: null,
      duracionTranscurridaSeg: duracionFinalTotalSeg,
      intervaloCicloSeg: intervaloPacingMs > 0 ? Math.round(intervaloPacingMs / 1000) : 60,
      fuente: opciones.fuente,
      fechaActual: colaDias[indiceDia] ?? "finalizado",
    });

    await gestorEstado.guardarAtomico();
    await cerrarTrazas();

    const costoUSD = await calcularCostoEstimado(
      MODEL_NAME,
      stFinal.gastoAcumulado.tokensEntrada,
      stFinal.gastoAcumulado.tokensSalida,
    );

    await finalizarEjecucion(ejecucionId, {
      tipo: "daemon",
      modo: opciones.fuente === "hoy" ? "hoy" : "carga",
      fechaDatos: colaDias[0]!,
      parametros: opciones as unknown as Record<string, unknown>,
      etapas: {
        candidatos: stFinal.contadoresUnidades.evaluadosAgente1,
        aptos: stFinal.contadoresUnidades.clasificadosSi,
        resumidos: stFinal.contadoresUnidades.completadosAgentes123,
        documentados: stFinal.contadoresUnidades.completadosAgentes123,
      },
      errores: [],
      tokens: {
        entrada: stFinal.gastoAcumulado.tokensEntrada,
        salida: stFinal.gastoAcumulado.tokensSalida,
        razonamiento: null,
        total: stFinal.gastoAcumulado.tokensTotal,
      },
      costoUSD,
      langsmith: {
        proyecto: PROYECTO_POR_DEFECTO,
        runId,
        url: null,
      },
      estado: "ok",
      reporteRutas: null,
      trazasCompactas: {
        proyecto: PROYECTO_POR_DEFECTO,
        runId,
        url: null,
        error: null,
      },
    });

    // S4-5: Regeneración final de bitácora oficial y resumen S4 al concluir
    try {
      await generarBitacoraCarga({ silencioso: true });
    } catch (err) {
      console.warn("[daemon] Advertencia en regeneración final de bitácora:", err);
    }

    const resumenBitacora = await gestorBitacora.obtenerResumen();

    console.log("\n================================================================================");
    console.log(`🏁 DAEMON FINALIZADO | Motivo: ${motivoParada.toUpperCase()}`);
    console.log(`⏱️ Duración total:      ${(duracionFinalTotalSeg / 3600).toFixed(2)} horas (${duracionFinalTotalSeg}s)`);
    console.log(`📦 Ciclos ejecutados:    ${cicloActual}`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`📊 CONTEO DE UNIDADES DE TRABAJO:`);
    console.log(`   1. Oficial Fin a Fin (Éxito completo):   ${stFinal.contadoresUnidades.exitosasFinAFin} unidades`);
    console.log(`      • Fallidas / Contingencias:           ${stFinal.contadoresUnidades.fallidasFinAFin} procesos`);
    console.log(`      • Total registrados en bitácora:      ${stFinal.contadoresUnidades.oficialFinAFin} procesos`);
    console.log(`      • Tasa de éxito oficial:              ${resumenBitacora.unidadesOficiales.tasaExitoPorcentaje.toFixed(1)}%`);
    console.log(`   2. Secundario (Evaluados Agente 1):      ${stFinal.contadoresUnidades.evaluadosAgente1} procesos`);
    console.log(`   3. Secundario ("Sí" Completos 1, 2 y 3): ${stFinal.contadoresUnidades.completadosAgentes123} procesos`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`💰 CONSUMO Y GASTO:`);
    console.log(`   • Tokens entrada:                        ${stFinal.gastoAcumulado.tokensEntrada.toLocaleString("es-CO")}`);
    console.log(`   • Tokens salida:                         ${stFinal.gastoAcumulado.tokensSalida.toLocaleString("es-CO")}`);
    console.log(`   • Tokens totales facturados:             ${stFinal.gastoAcumulado.tokensTotal.toLocaleString("es-CO")}`);
    if (resumenBitacora.costos.preciosConfigurados && resumenBitacora.costos.costoTotalUSD !== null) {
      console.log(`   • Costo total estimado:                  $${resumenBitacora.costos.costoTotalUSD.toFixed(4)} USD`);
      console.log(`   • Costo promedio por tarea:              $${(resumenBitacora.costos.costoPromedioPorTareaUSD ?? 0).toFixed(4)} USD/tarea`);
    } else {
      console.log(`   • Costo total en USD:                    Precio no configurado (nulls en precios.json)`);
    }
    console.log("================================================================================\n");

    console.log("********************************************************************************");
    console.log("📢 ATENCIÓN OPERADOR: LA EJECUCIÓN HA CONCLUIDO.");
    console.log("   ANOTE AHORA LOS NÚMEROS ACTUALIZADOS DE SU PANEL DE CONTROL DEL RETO");
    console.log("   (https://api.reto.pltk.mx):");
    console.log("   • Total Requests | Prompt Tokens | Output Tokens | Cost USD | Balance USD");
    console.log("********************************************************************************\n");
  }
}

import { fileURLToPath } from "node:url";

const esModuloPrincipal =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esModuloPrincipal) {
  main().catch((err) => {
    console.error("❌ Fallo crítico en el daemon:", err);
    process.exit(1);
  });
}
