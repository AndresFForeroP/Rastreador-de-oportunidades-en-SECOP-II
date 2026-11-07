/**
 * Guarda dura de presupuesto (Hard Budget Guard) para llamadas al modelo (src/carga/presupuesto.ts).
 *
 * Cumple los requerimientos de S4-1:
 * 1. Envuelve TODA llamada al modelo (`envolverModeloConPresupuesto` en `src/llm.ts` y
 *    `crearMiddlewarePresupuesto` para agentes LangChain).
 * 2. Soporta las banderas `--presupuesto-usd=<n>` y, como respaldo cuando los precios son
 *    `null`, `--presupuesto-tokens=<n>`.
 * 3. Las corridas largas (`daemon`, `carga` / `load`) SE NIEGAN A INICIAR sin una de estas banderas
 *    (y si los precios son `null`, exigen `--presupuesto-tokens=<n>`).
 * 4. Antes de cada llamada verifica `gastado + margenSeguridad <= limite`.
 * 5. Después de cada llamada suma el consumo real usando la estimación conservadora
 *    (el mayor entre la Estimación A y la Estimación B del módulo de costos).
 * 6. Emite un evento de advertencia al alcanzar el 80% del presupuesto (`presupuesto_advertencia_80`).
 * 7. Al alcanzar el límite: deja de lanzar trabajo nuevo, espera a que terminen los ítems en vuelo,
 *    escribe el estado persistente atómico (`estado.json`) y sale con un mensaje claro y código 0.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import {
  GestorEstadoCarga,
  obtenerGestorEstado,
} from "./estado.js";

/**
 * Limitador de concurrencia para llamadas al gateway del reto (por defecto concurrencia 2).
 * Respeta el encabezado Retry-After en caso de respuesta HTTP 429.
 */
export class LimitadorConcurrenciaGateway {
  private maxConcurrencia: number;
  private concurrenciaActiva = 0;
  private readonly cola: Array<() => void> = [];

  constructor(maxConcurrencia = 3) {
    this.maxConcurrencia = Math.max(1, maxConcurrencia);
  }

  public setMaxConcurrencia(maxConcurrencia: number): void {
    this.maxConcurrencia = Math.max(1, maxConcurrencia);
  }

  public obtenerMaxConcurrencia(): number {
    return this.maxConcurrencia;
  }

  public async adquirir(): Promise<void> {
    if (this.concurrenciaActiva < this.maxConcurrencia) {
      this.concurrenciaActiva++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.cola.push(() => {
        this.concurrenciaActiva++;
        resolve();
      });
    });
  }

  public liberar(): void {
    this.concurrenciaActiva = Math.max(0, this.concurrenciaActiva - 1);
    const siguiente = this.cola.shift();
    if (siguiente) {
      siguiente();
    }
  }

  public async ejecutar<T>(fn: () => Promise<T>): Promise<T> {
    await this.adquirir();
    try {
      let intentos = 0;
      while (true) {
        try {
          return await fn();
        } catch (err: any) {
          const status = err?.status ?? err?.response?.status;
          const es429 = status === 429 || String(err?.message || "").includes("429");
          if (es429 && intentos < 4) {
            intentos++;
            const retryAfterHeader =
              err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
            let esperaMs = 2000 * Math.pow(2, intentos - 1);
            if (retryAfterHeader) {
              const segs = Number.parseFloat(String(retryAfterHeader));
              if (Number.isFinite(segs) && segs > 0) {
                esperaMs = Math.ceil(segs * 1000);
              }
            }
            console.warn(
              `[gateway-limiter] ⚠️ Error 429 (Rate Limit). Reintentando en ${(esperaMs / 1000).toFixed(1)}s (intento ${intentos}/4)...`,
            );
            await new Promise((r) => setTimeout(r, esperaMs));
            continue;
          }
          throw err;
        }
      }
    } finally {
      this.liberar();
    }
  }
}

export const limitadorGatewayGlobal = new LimitadorConcurrenciaGateway(3);

/** Nombre del modelo por defecto en el gateway del reto */
export const MODELO_POR_DEFECTO_PRESUPUESTO = "grok-4.6";

export interface TarifasPreciosModelo {
  porMillonEntrada: number | null;
  porMillonSalida: number | null;
  fuente?: string | null;
  actualizado?: string | null;
}

/**
 * Carga las tarifas del modelo desde `config/precios.json`.
 * Si el archivo no existe o tiene valores nulos, devuelve tarifas con valores nulos conforme a la regla de honestidad.
 */
export async function cargarTarifasModeloPresupuesto(
  modelo: string = MODELO_POR_DEFECTO_PRESUPUESTO,
  rutaPreciosPersonalizada?: string,
): Promise<TarifasPreciosModelo | null> {
  const ruta = rutaPreciosPersonalizada
    ? path.resolve(process.cwd(), rutaPreciosPersonalizada)
    : path.resolve(process.cwd(), "config", "precios.json");

  try {
    const raw = await readFile(ruta, "utf8");
    const json = JSON.parse(raw);
    const info =
      json.modelos?.[modelo] ??
      json.modelos?.["default"] ??
      json[modelo] ??
      json["default"];

    const pEntrada = info?.porMillonEntrada ?? info?.inputPorMillon ?? null;
    const pSalida = info?.porMillonSalida ?? info?.outputPorMillon ?? null;
    const fuente = typeof json.fuente === "string" ? json.fuente : null;
    const actualizado = typeof json.actualizado === "string" ? json.actualizado : null;

    if (typeof pEntrada === "number" && typeof pSalida === "number") {
      return { porMillonEntrada: pEntrada, porMillonSalida: pSalida, fuente, actualizado };
    }
    return { porMillonEntrada: null, porMillonSalida: null, fuente, actualizado };
  } catch {
    return null;
  }
}

// ============================================================================
// 1. TIPOS, ERRORES Y OPCIONES DE PRESUPUESTO
// ============================================================================

export class ErrorConfiguracionPresupuesto extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ErrorConfiguracionPresupuesto";
  }
}

export class ErrorPresupuestoAlcanzado extends Error {
  public readonly motivo: "usd" | "tokens";
  public readonly gastadoUSD: number;
  public readonly limiteUSD: number | null;
  public readonly gastadoTokens: number;
  public readonly limiteTokens: number | null;

  constructor(params: {
    mensaje: string;
    motivo: "usd" | "tokens";
    gastadoUSD: number;
    limiteUSD: number | null;
    gastadoTokens: number;
    limiteTokens: number | null;
  }) {
    super(params.mensaje);
    this.name = "ErrorPresupuestoAlcanzado";
    this.motivo = params.motivo;
    this.gastadoUSD = params.gastadoUSD;
    this.limiteUSD = params.limiteUSD;
    this.gastadoTokens = params.gastadoTokens;
    this.limiteTokens = params.limiteTokens;
  }
}

export interface OpcionesPresupuestoCLI {
  presupuestoUSD?: number | null;
  presupuestoTokens?: number | null;
  margenSeguridadUSD?: number;
  margenSeguridadTokens?: number;
}

export interface UsoTokensLlamada {
  tokensEntrada: number;
  tokensSalida: number;
  tokensTotal: number;
}

export interface ResultadoCostoConservador {
  tokensEntrada: number;
  tokensSalida: number;
  tokensRazonamiento: number;
  tokensTotalEfectivo: number;
  costoUSD_A: number | null;
  costoUSD_B: number | null;
  /** El mayor entre Estimación A y Estimación B (null si los precios no están configurados) */
  costoConservadorUSD: number | null;
}

export interface OpcionesGuardaPresupuesto {
  /** Límite máximo en USD (`--presupuesto-usd=<n>`) */
  presupuestoUSD?: number | null;
  /** Límite máximo en tokens (`--presupuesto-tokens=<n>`, respaldo cuando precios son null) */
  presupuestoTokens?: number | null;
  /** Margen de seguridad en USD verificado antes de cada llamada (por defecto: costo medio/último observado o valor explícito) */
  margenSeguridadUSD?: number;
  /** Margen de seguridad en tokens verificado antes de cada llamada */
  margenSeguridadTokens?: number;
  /**Si es true (por defecto), usa el promedio conservador por llamada observada cuando no se fijó un margen explícito */
  usarMargenDinamicoPorLlamada?: boolean;
  /** Gestor de estado persistente asociado */
  gestorEstado?: GestorEstadoCarga;
  /** Tarifas del modelo (undefined lee config/precios.json; null fuerza modo sin precios) */
  tarifasOverride?: TarifasPreciosModelo | null;
  /**Ruta opcional a un archivo de configuración de precios */
  rutaConfigPrecios?: string;
  /** Nombre del modelo para consultar tarifas (por defecto `MODEL_NAME`) */
  modelo?: string;
  /**
   * Función invocada al completar el cierre ordenado cuando se alcanza el límite de presupuesto.
   * Por defecto ejecuta `process.exit(0)`. En pruebas puede inyectarse un callback para verificar
   * el código 0 sin terminar el proceso de pruebas.
   */
  onExit?: (codigo: number) => void | Promise<void>;
  /**
   * Si es true (por defecto), cuando una llamada detecta el límite alcanzado dispara automáticamente
   * el cierre ordenado (esperar ítems en vuelo + guardar estado + salir con código 0).
   */
  autoCerrarAlAlcanzarLimite?: boolean;
  /** Silencia mensajes de consola durante pruebas si se desea */
  silencioso?: boolean;
}

export interface ResumenEstadoPresupuesto {
  activo: boolean;
  modoControl: "usd" | "tokens" | "ambos";
  preciosConfigurados: boolean;
  presupuestoUSD: number | null;
  presupuestoTokens: number | null;
  gastadoUSD: number;
  gastadoTokens: number;
  margenSeguridadUSD: number;
  margenSeguridadTokens: number;
  porcentajeUSD: number | null;
  porcentajeTokens: number | null;
  porcentajeMaximo: number;
  llamadasContabilizadas: number;
  advertencia80Emitida: boolean;
  limiteAlcanzado: boolean;
  cierreEjecutado: boolean;
  codigoSalidaRegistrado: number | null;
  itemsEnVuelo: number;
}

// ============================================================================
// 2. PARSEO DE BANDERAS CLI Y CÁLCULO CONSERVADOR (ESTIMACIÓN A vs B)
// ============================================================================

/**
 * Extrae `--presupuesto-usd=<n>` y `--presupuesto-tokens=<n>` de una lista de argumentos CLI.
 */
export function parsearOpcionesPresupuesto(
  argv: string[] = process.argv.slice(2),
): OpcionesPresupuestoCLI {
  const resultado: OpcionesPresupuestoCLI = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith("--presupuesto-usd=")) {
      const val = Number.parseFloat(arg.slice("--presupuesto-usd=".length).trim());
      if (!Number.isFinite(val) || val <= 0) {
        throw new ErrorConfiguracionPresupuesto(
          `[presupuesto] Valor inválido en ${arg}. --presupuesto-usd debe ser un número positivo mayor a 0.`,
        );
      }
      resultado.presupuestoUSD = val;
    } else if (arg === "--presupuesto-usd" && argv[i + 1]) {
      const val = Number.parseFloat(argv[++i]!.trim());
      if (!Number.isFinite(val) || val <= 0) {
        throw new ErrorConfiguracionPresupuesto(
          `[presupuesto] Valor inválido para --presupuesto-usd. Debe ser un número positivo mayor a 0.`,
        );
      }
      resultado.presupuestoUSD = val;
    } else if (arg.startsWith("--presupuesto-tokens=")) {
      const val = Number.parseInt(arg.slice("--presupuesto-tokens=".length).trim(), 10);
      if (!Number.isFinite(val) || val <= 0) {
        throw new ErrorConfiguracionPresupuesto(
          `[presupuesto] Valor inválido en ${arg}. --presupuesto-tokens debe ser un entero positivo mayor a 0.`,
        );
      }
      resultado.presupuestoTokens = val;
    } else if (arg === "--presupuesto-tokens" && argv[i + 1]) {
      const val = Number.parseInt(argv[++i]!.trim(), 10);
      if (!Number.isFinite(val) || val <= 0) {
        throw new ErrorConfiguracionPresupuesto(
          `[presupuesto] Valor inválido para --presupuesto-tokens. Debe ser un entero positivo mayor a 0.`,
        );
      }
      resultado.presupuestoTokens = val;
    } else if (arg.startsWith("--margen-seguridad-usd=")) {
      const val = Number.parseFloat(arg.slice("--margen-seguridad-usd=".length).trim());
      if (Number.isFinite(val) && val >= 0) {
        resultado.margenSeguridadUSD = val;
      }
    } else if (arg.startsWith("--margen-seguridad-tokens=")) {
      const val = Number.parseInt(arg.slice("--margen-seguridad-tokens=".length).trim(), 10);
      if (Number.isFinite(val) && val >= 0) {
        resultado.margenSeguridadTokens = val;
      }
    }
  }

  return resultado;
}

/**
 * Calcula el consumo real de una llamada usando la estimación conservadora:
 * el mayor entre la Estimación A (todo token no-entrada facturado a tarifa de salida,
 * incluyendo razonamiento) y la Estimación B (solo tokens de salida visibles).
 */
export function calcularUsoConservadorLlamada(
  uso: UsoTokensLlamada,
  tarifas: TarifasPreciosModelo | null,
): ResultadoCostoConservador {
  const tokensEntrada = Math.max(0, Math.round(uso.tokensEntrada || 0));
  const tokensSalida = Math.max(0, Math.round(uso.tokensSalida || 0));
  const tokensTotalEfectivo = Math.max(
    tokensEntrada + tokensSalida,
    Math.round(uso.tokensTotal || 0),
  );
  const tokensRazonamiento = Math.max(0, tokensTotalEfectivo - (tokensEntrada + tokensSalida));

  if (
    !tarifas ||
    typeof tarifas.porMillonEntrada !== "number" ||
    typeof tarifas.porMillonSalida !== "number"
  ) {
    return {
      tokensEntrada,
      tokensSalida,
      tokensRazonamiento,
      tokensTotalEfectivo,
      costoUSD_A: null,
      costoUSD_B: null,
      costoConservadorUSD: null,
    };
  }

  const pIn = tarifas.porMillonEntrada;
  const pOut = tarifas.porMillonSalida;

  // Estimación A: tokens no-entrada (salida visible + razonamiento) a tarifa de salida
  const tokensNoEntrada = Math.max(tokensSalida, tokensTotalEfectivo - tokensEntrada);
  const costoA = (tokensEntrada * pIn + tokensNoEntrada * pOut) / 1_000_000;

  // Estimación B: solo tokens de salida visibles a tarifa de salida
  const costoB = (tokensEntrada * pIn + tokensSalida * pOut) / 1_000_000;

  // Estimación conservadora: el mayor entre A y B
  const mayor = Math.max(costoA, costoB);

  return {
    tokensEntrada,
    tokensSalida,
    tokensRazonamiento,
    tokensTotalEfectivo,
    costoUSD_A: Number(costoA.toFixed(6)),
    costoUSD_B: Number(costoB.toFixed(6)),
    costoConservadorUSD: Number(mayor.toFixed(6)),
  };
}

/**
 * Valida que una corrida larga (`daemon`, `carga` / `load`) cuente obligatoriamente con
 * `--presupuesto-usd=<n>` o `--presupuesto-tokens=<n>`.
 * Si los precios en `config/precios.json` son `null`, exige `--presupuesto-tokens=<n>`.
 */
export async function exigirPresupuestoParaEjecucionLarga(params: {
  modo: "daemon" | "carga" | "load" | string;
  presupuestoUSD?: number | null;
  presupuestoTokens?: number | null;
  tarifasOverride?: TarifasPreciosModelo | null;
  rutaConfigPrecios?: string;
  modelo?: string;
}): Promise<{
  tarifas: TarifasPreciosModelo | null;
  preciosConfigurados: boolean;
  modoControl: "usd" | "tokens" | "ambos";
}> {
  const tieneUSD =
    typeof params.presupuestoUSD === "number" &&
    Number.isFinite(params.presupuestoUSD) &&
    params.presupuestoUSD > 0;
  const tieneTokens =
    typeof params.presupuestoTokens === "number" &&
    Number.isFinite(params.presupuestoTokens) &&
    params.presupuestoTokens > 0;

  if (!tieneUSD && !tieneTokens) {
    throw new ErrorConfiguracionPresupuesto(
      `[presupuesto] RECHAZADO: La ejecución larga (${params.modo}) requiere obligatoriamente ` +
        `--presupuesto-usd=<n> o --presupuesto-tokens=<n>. Ninguno fue especificado.`,
    );
  }

  const tarifas =
    params.tarifasOverride !== undefined
      ? params.tarifasOverride
      : await cargarTarifasModeloPresupuesto(
          params.modelo ?? MODELO_POR_DEFECTO_PRESUPUESTO,
          params.rutaConfigPrecios,
        );

  const preciosConfigurados =
    tarifas !== null &&
    typeof tarifas.porMillonEntrada === "number" &&
    typeof tarifas.porMillonSalida === "number";

  if (!preciosConfigurados && !tieneTokens) {
    throw new ErrorConfiguracionPresupuesto(
      `[presupuesto] RECHAZADO: Los precios del modelo son null (no configurados en config/precios.json) ` +
        `y solo se proporcionó --presupuesto-usd. Especifique --presupuesto-tokens=<n> como respaldo obligatorio.`,
    );
  }

  const modoControl: "usd" | "tokens" | "ambos" =
    tieneUSD && preciosConfigurados && tieneTokens
      ? "ambos"
      : tieneUSD && preciosConfigurados
        ? "usd"
        : "tokens";

  return {
    tarifas,
    preciosConfigurados,
    modoControl,
  };
}

// ============================================================================
// 3. CLASE PRINCIPAL: GUARDA DURA DE PRESUPUESTO
// ============================================================================

export class GuardaPresupuesto {
  private readonly presupuestoUSD: number | null;
  private readonly presupuestoTokens: number | null;
  private readonly margenExplicitoUSD: number | undefined;
  private readonly margenExplicitoTokens: number | undefined;
  private readonly usarMargenDinamico: boolean;
  private readonly gestorEstado: GestorEstadoCarga;
  private readonly tarifasOverride: TarifasPreciosModelo | null | undefined;
  private readonly rutaConfigPrecios: string | undefined;
  private readonly modelo: string;
  private readonly onExit: (codigo: number) => void | Promise<void>;
  private readonly autoCerrarAlAlcanzarLimite: boolean;
  private readonly silencioso: boolean;

  private inicializado = false;
  private tarifas: TarifasPreciosModelo | null = null;
  private preciosConfigurados = false;

  private gastadoUSD = 0;
  private gastadoTokens = 0;
  private llamadasContabilizadas = 0;

  private advertencia80Emitida = false;
  private limiteAlcanzado = false;
  private motivoLimite: "usd" | "tokens" | null = null;
  private cierreEnCursoPromesa: Promise<void> | null = null;
  private cierreEjecutado = false;
  private codigoSalidaRegistrado: number | null = null;

  /** Promesas de ítems de trabajo actualmente en vuelo que deben finalizar antes de salir */
  private readonly itemsEnVuelo = new Map<string, Promise<unknown>>();

  /** Contexto AsyncLocalStorage para identificar si una llamada al modelo pertenece a un ítem ya en vuelo */
  private readonly contextoItemEnVuelo = new AsyncLocalStorage<string>();

  constructor(opciones: OpcionesGuardaPresupuesto) {
    this.presupuestoUSD =
      typeof opciones.presupuestoUSD === "number" && opciones.presupuestoUSD > 0
        ? opciones.presupuestoUSD
        : null;
    this.presupuestoTokens =
      typeof opciones.presupuestoTokens === "number" && opciones.presupuestoTokens > 0
        ? opciones.presupuestoTokens
        : null;

    this.margenExplicitoUSD = opciones.margenSeguridadUSD;
    this.margenExplicitoTokens = opciones.margenSeguridadTokens;
    this.usarMargenDinamico = opciones.usarMargenDinamicoPorLlamada ?? false;
    this.gestorEstado = opciones.gestorEstado ?? obtenerGestorEstado();
    this.tarifasOverride = opciones.tarifasOverride;
    this.rutaConfigPrecios = opciones.rutaConfigPrecios;
    this.modelo = opciones.modelo ?? MODELO_POR_DEFECTO_PRESUPUESTO;
    this.autoCerrarAlAlcanzarLimite = opciones.autoCerrarAlAlcanzarLimite ?? true;
    this.silencioso = opciones.silencioso ?? false;
    this.onExit =
      opciones.onExit ??
      ((codigo: number) => {
        process.exit(codigo);
      });
  }

  /**
   * Inicializa la guarda, validando que exista un presupuesto válido (USD o tokens),
   * cargando tarifas y recuperando cualquier gasto previo desde `estado.json`.
   */
  public async inicializar(opciones?: { exigirParaCorridaLarga?: boolean; modo?: string }): Promise<void> {
    if (this.inicializado) return;

    if (opciones?.exigirParaCorridaLarga ?? true) {
      const validacion = await exigirPresupuestoParaEjecucionLarga({
        modo: opciones?.modo ?? "carga",
        presupuestoUSD: this.presupuestoUSD,
        presupuestoTokens: this.presupuestoTokens,
        tarifasOverride: this.tarifasOverride,
        rutaConfigPrecios: this.rutaConfigPrecios,
        modelo: this.modelo,
      });
      this.tarifas = validacion.tarifas;
      this.preciosConfigurados = validacion.preciosConfigurados;
    } else {
      this.tarifas =
        this.tarifasOverride !== undefined
          ? this.tarifasOverride
          : await cargarTarifasModeloPresupuesto(this.modelo, this.rutaConfigPrecios);
      this.preciosConfigurados =
        this.tarifas !== null &&
        typeof this.tarifas.porMillonEntrada === "number" &&
        typeof this.tarifas.porMillonSalida === "number";
    }

    await this.gestorEstado.inicializar();
    const estadoPrevio = this.gestorEstado.obtenerEstado();

    // Sincronizar con el gasto acumulado ya persistido si se reanuda una corrida
    if (estadoPrevio.gastoAcumulado.tokensTotal > this.gastadoTokens) {
      this.gastadoTokens = estadoPrevio.gastoAcumulado.tokensTotal;
    }
    const usdPrevio = Math.max(
      estadoPrevio.gastoAcumulado.costoConservadorLlamadasUSD || 0,
      estadoPrevio.gastoAcumulado.costoTotalUSD || 0,
    );
    if (usdPrevio > this.gastadoUSD) {
      this.gastadoUSD = usdPrevio;
    }
    if (estadoPrevio.gastoAcumulado.llamadasModelo > this.llamadasContabilizadas) {
      this.llamadasContabilizadas = estadoPrevio.gastoAcumulado.llamadasModelo;
    }

    this.inicializado = true;
  }

  /**
   * Calcula el margen de seguridad en USD a aplicar antes de lanzar una nueva llamada.
   */
  public obtenerMargenSeguridadUSD(): number {
    if (typeof this.margenExplicitoUSD === "number" && this.margenExplicitoUSD >= 0) {
      return this.margenExplicitoUSD;
    }
    if (this.usarMargenDinamico && this.llamadasContabilizadas > 0 && this.gastadoUSD > 0) {
      return Number((this.gastadoUSD / this.llamadasContabilizadas).toFixed(6));
    }
    return 0;
  }

  /**
   * Calcula el margen de seguridad en tokens a aplicar antes de lanzar una nueva llamada.
   */
  public obtenerMargenSeguridadTokens(): number {
    if (typeof this.margenExplicitoTokens === "number" && this.margenExplicitoTokens >= 0) {
      return this.margenExplicitoTokens;
    }
    if (this.usarMargenDinamico && this.llamadasContabilizadas > 0 && this.gastadoTokens > 0) {
      return Math.round(this.gastadoTokens / this.llamadasContabilizadas);
    }
    return 0;
  }

  /**
   * Indica si se ha alcanzado el límite de presupuesto y no debe lanzarse nuevo trabajo.
   */
  public haAlcanzadoLimite(): boolean {
    return this.debeDetenerNuevosTrabajos();
  }

  /**
   * Indica si se ha alcanzado el límite de presupuesto y no debe lanzarse nuevo trabajo.
   */
  public debeDetenerNuevosTrabajos(): boolean {
    if (this.limiteAlcanzado) return true;

    const margenUSD = this.obtenerMargenSeguridadUSD();
    const margenTokens = this.obtenerMargenSeguridadTokens();

    if (
      this.presupuestoUSD !== null &&
      this.preciosConfigurados &&
      (this.gastadoUSD >= this.presupuestoUSD ||
        this.gastadoUSD + margenUSD > this.presupuestoUSD)
    ) {
      return true;
    }

    if (
      this.presupuestoTokens !== null &&
      (this.gastadoTokens >= this.presupuestoTokens ||
        this.gastadoTokens + margenTokens > this.presupuestoTokens)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Registra y ejecuta un ítem de trabajo (por ejemplo, un proceso que entra al pipeline).
   * - Si el presupuesto ya alcanzó su límite, se niega a lanzar el nuevo ítem.
   * - Si el ítem ya está en vuelo cuando otra tarea alcanza el límite, la guarda espera
   *   a que este ítem en vuelo termine antes de escribir `estado.json` y salir con código 0.
   */
  public async ejecutarItemTrabajo<T>(idItem: string, fn: () => Promise<T>): Promise<T> {
    await this.inicializar();

    if (this.debeDetenerNuevosTrabajos()) {
      await this.marcarLimiteYDispararCierreSiCorresponde();
      throw this.construirErrorLimite();
    }

    let resolverPromesa!: () => void;
    const promesaEnVuelo = new Promise<void>((resolve) => {
      resolverPromesa = resolve;
    });

    this.itemsEnVuelo.set(idItem, promesaEnVuelo);

    try {
      return await this.contextoItemEnVuelo.run(idItem, fn);
    } finally {
      this.itemsEnVuelo.delete(idItem);
      resolverPromesa();
    }
  }

  /**
   * Registra manualmente una promesa de trabajo en vuelo para que el cierre ordenado
   * la espere antes de persistir el estado final y salir.
   */
  public registrarPromesaEnVuelo<T>(idItem: string, promesa: Promise<T>): Promise<T> {
    const rastreada = promesa.finally(() => {
      this.itemsEnVuelo.delete(idItem);
    });
    this.itemsEnVuelo.set(idItem, rastreada);
    return rastreada;
  }

  private construirErrorLimite(): ErrorPresupuestoAlcanzado {
    const motivo: "usd" | "tokens" =
      this.motivoLimite ??
      (this.presupuestoUSD !== null && this.preciosConfigurados ? "usd" : "tokens");

    const detalle =
      motivo === "usd"
        ? `gastado=$${this.gastadoUSD.toFixed(6)} USD, margen=$${this.obtenerMargenSeguridadUSD().toFixed(6)} USD, límite=$${(this.presupuestoUSD ?? 0).toFixed(6)} USD`
        : `gastado=${this.gastadoTokens} tokens, margen=${this.obtenerMargenSeguridadTokens()} tokens, límite=${this.presupuestoTokens ?? 0} tokens`;

    return new ErrorPresupuestoAlcanzado({
      mensaje: `[presupuesto] Límite de presupuesto alcanzado (${detalle}). No se lanzarán nuevas tareas.`,
      motivo,
      gastadoUSD: this.gastadoUSD,
      limiteUSD: this.presupuestoUSD,
      gastadoTokens: this.gastadoTokens,
      limiteTokens: this.presupuestoTokens,
    });
  }

  /**
   * Verifica antes de una llamada al modelo si `gastado + margenSeguridad` supera el límite.
   */
  public async verificarAntesDeLlamada(): Promise<void> {
    await this.inicializar();

    const margenUSD = this.obtenerMargenSeguridadUSD();
    const margenTokens = this.obtenerMargenSeguridadTokens();

    const excedeUSD =
      this.presupuestoUSD !== null &&
      this.preciosConfigurados &&
      (this.gastadoUSD >= this.presupuestoUSD ||
        Number((this.gastadoUSD + margenUSD).toFixed(8)) > this.presupuestoUSD);

    const excedeTokens =
      this.presupuestoTokens !== null &&
      (this.gastadoTokens >= this.presupuestoTokens ||
        this.gastadoTokens + margenTokens > this.presupuestoTokens);

    if (this.limiteAlcanzado || excedeUSD || excedeTokens) {
      if (!this.motivoLimite) {
        this.motivoLimite = excedeUSD ? "usd" : "tokens";
      }
      await this.marcarLimiteYDispararCierreSiCorresponde();
      throw this.construirErrorLimite();
    }
  }

  /**
   * Contabiliza el consumo real tras finalizar una llamada al modelo usando la estimación
   * conservadora (el mayor entre A y B), emite la advertencia del 80% si corresponde y
   * verifica si se alcanzó el 100% del límite.
   */
  public async registrarUsoDespuesDeLlamada(
    uso: UsoTokensLlamada,
    meta?: { agente?: string; ejecucionId?: string; ciclo?: number },
  ): Promise<ResultadoCostoConservador> {
    await this.inicializar();

    const calculo = calcularUsoConservadorLlamada(uso, this.tarifas);

    this.llamadasContabilizadas += 1;
    this.gastadoTokens += calculo.tokensTotalEfectivo;
    if (calculo.costoConservadorUSD !== null) {
      this.gastadoUSD = Number((this.gastadoUSD + calculo.costoConservadorUSD).toFixed(6));
    }

    await this.gestorEstado.registrarGastoLlamada({
      tokensEntrada: calculo.tokensEntrada,
      tokensSalida: calculo.tokensSalida,
      tokensTotal: calculo.tokensTotalEfectivo,
      costoConservadorUSD: calculo.costoConservadorUSD,
      ejecucionId: meta?.ejecucionId,
      ciclo: meta?.ciclo,
      persistirInmediatamente: true,
    });

    // Evaluar porcentaje de consumo para advertencia al 80%
    const pctUSD =
      this.presupuestoUSD !== null && this.preciosConfigurados && this.presupuestoUSD > 0
        ? (this.gastadoUSD / this.presupuestoUSD) * 100
        : 0;
    const pctTokens =
      this.presupuestoTokens !== null && this.presupuestoTokens > 0
        ? (this.gastadoTokens / this.presupuestoTokens) * 100
        : 0;
    const pctMaximo = Math.max(pctUSD, pctTokens);

    if (!this.advertencia80Emitida && pctMaximo >= 80) {
      this.advertencia80Emitida = true;
      const detallesAdvertencia = {
        porcentajeConsumido: Number(pctMaximo.toFixed(2)),
        gastadoUSD: this.gastadoUSD,
        presupuestoUSD: this.presupuestoUSD,
        gastadoTokens: this.gastadoTokens,
        presupuestoTokens: this.presupuestoTokens,
        llamadasContabilizadas: this.llamadasContabilizadas,
        agente: meta?.agente ?? null,
      };
      await this.gestorEstado.registrarEvento("presupuesto_advertencia_80", detallesAdvertencia);
      if (!this.silencioso) {
        console.warn(
          `[presupuesto] ⚠️ ADVERTENCIA 80%: Se ha consumido el ${pctMaximo.toFixed(1)}% del presupuesto ` +
            `(USD: $${this.gastadoUSD.toFixed(4)}/${this.presupuestoUSD ?? "N/A"}, ` +
            `Tokens: ${this.gastadoTokens}/${this.presupuestoTokens ?? "N/A"}).`,
        );
      }
    }

    // Evaluar si tras sumar el consumo real ya se alcanzó el límite (o gastado + margen >= límite)
    const margenUSD = this.obtenerMargenSeguridadUSD();
    const margenTokens = this.obtenerMargenSeguridadTokens();

    const alcanzoUSD =
      this.presupuestoUSD !== null &&
      this.preciosConfigurados &&
      Number((this.gastadoUSD + margenUSD).toFixed(8)) >= this.presupuestoUSD;

    const alcanzoTokens =
      this.presupuestoTokens !== null &&
      this.gastadoTokens + margenTokens >= this.presupuestoTokens;

    if (alcanzoUSD || alcanzoTokens) {
      if (!this.motivoLimite) {
        this.motivoLimite = alcanzoUSD ? "usd" : "tokens";
      }
      await this.marcarLimiteYDispararCierreSiCorresponde();
    }

    return calculo;
  }

  /**
   * Marca el límite como alcanzado, registra el evento en `eventos.jsonl` y, si corresponde,
   * ejecuta el cierre ordenado (esperar ítems en vuelo, guardar `estado.json` y salir con código 0).
   */
  private async marcarLimiteYDispararCierreSiCorresponde(): Promise<void> {
    if (!this.limiteAlcanzado) {
      this.limiteAlcanzado = true;
      await this.gestorEstado.registrarEvento("presupuesto_limite_alcanzado", {
        motivo: this.motivoLimite ?? (this.preciosConfigurados ? "usd" : "tokens"),
        gastadoUSD: this.gastadoUSD,
        presupuestoUSD: this.presupuestoUSD,
        margenSeguridadUSD: this.obtenerMargenSeguridadUSD(),
        gastadoTokens: this.gastadoTokens,
        presupuestoTokens: this.presupuestoTokens,
        margenSeguridadTokens: this.obtenerMargenSeguridadTokens(),
        llamadasContabilizadas: this.llamadasContabilizadas,
        itemsEnVueloAlDetectar: this.itemsEnVuelo.size,
      });
    }

    if (this.autoCerrarAlAlcanzarLimite) {
      // Si estamos dentro de un ítem actualmente en vuelo que está terminando su llamada actual,
      // dejamos que la promesa del cierre espere a que todos los ítems en vuelo terminen.
      const itemActual = this.contextoItemEnVuelo.getStore();
      if (!itemActual) {
        await this.ejecutarCierreOrdenado();
      }
    }
  }

  /**
   * Al alcanzar el límite de presupuesto:
   * 1. Deja de lanzar trabajo nuevo (`limiteAlcanzado = true`).
   * 2. Espera a que terminen todos los ítems actualmente en vuelo (`itemsEnVuelo`).
   * 3. Escribe el estado persistente de forma atómica (`estado.json`) y registra el evento de cierre.
   * 4. Imprime un mensaje claro y sale con código 0 (`onExit(0)`).
   */
  public async ejecutarCierreOrdenado(): Promise<void> {
    if (this.cierreEnCursoPromesa) {
      return this.cierreEnCursoPromesa;
    }

    this.cierreEnCursoPromesa = (async () => {
      this.limiteAlcanzado = true;

      // 1. Esperar a que terminen todos los ítems en vuelo (excluyendo el propio si se invocó desde dentro)
      const itemActual = this.contextoItemEnVuelo.getStore();
      while (true) {
        const pendientes = Array.from(this.itemsEnVuelo.entries())
          .filter(([id]) => id !== itemActual)
          .map(([, p]) => p);
        if (pendientes.length === 0) break;
        await Promise.allSettled(pendientes);
      }

      // 2. Persistir el estado de forma atómica y registrar el evento final
      await this.gestorEstado.encolarEscritura(async () => {
        await this.gestorEstado.guardarAtomico();
      });

      const resumenUnidades = this.gestorEstado.obtenerEstado().contadoresUnidades;
      await this.gestorEstado.registrarEvento("presupuesto_cierre_ordenado", {
        codigoSalida: 0,
        gastadoUSD: this.gastadoUSD,
        presupuestoUSD: this.presupuestoUSD,
        gastadoTokens: this.gastadoTokens,
        presupuestoTokens: this.presupuestoTokens,
        llamadasContabilizadas: this.llamadasContabilizadas,
        contadoresUnidades: resumenUnidades,
      });

      this.cierreEjecutado = true;
      this.codigoSalidaRegistrado = 0;

      if (!this.silencioso) {
        console.log(
          `[presupuesto] Límite de presupuesto alcanzado de forma segura ` +
            `(USD: $${this.gastadoUSD.toFixed(6)}/${this.presupuestoUSD ?? "N/A"}, ` +
            `Tokens: ${this.gastadoTokens}/${this.presupuestoTokens ?? "N/A"}). ` +
            `Ítems en vuelo finalizados y estado persistido en estado.json. Saliendo con código 0.`,
        );
      }

      await this.onExit(0);
    })();

    return this.cierreEnCursoPromesa;
  }

  /**
   * Envuelve la ejecución de una llamada individual al modelo verificando antes el presupuesto
   * y sumando después el uso conservador.
   */
  public async ejecutarLlamadaModeloProtegida<T>(
    fnLlamada: () => Promise<T>,
    extraerUso: (resultado: T) => UsoTokensLlamada,
    meta?: { agente?: string; ejecucionId?: string; ciclo?: number },
  ): Promise<T> {
    await this.verificarAntesDeLlamada();
    const resultado = await fnLlamada();
    const uso = extraerUso(resultado);
    await this.registrarUsoDespuesDeLlamada(uso, meta);
    return resultado;
  }

  /**
   * Devuelve un resumen instantáneo del estado de la guarda de presupuesto.
   */
  public obtenerResumen(): ResumenEstadoPresupuesto {
    const modoControl: "usd" | "tokens" | "ambos" =
      this.presupuestoUSD !== null && this.preciosConfigurados && this.presupuestoTokens !== null
        ? "ambos"
        : this.presupuestoUSD !== null && this.preciosConfigurados
          ? "usd"
          : "tokens";

    const pctUSD =
      this.presupuestoUSD !== null && this.preciosConfigurados && this.presupuestoUSD > 0
        ? Number(((this.gastadoUSD / this.presupuestoUSD) * 100).toFixed(2))
        : null;
    const pctTokens =
      this.presupuestoTokens !== null && this.presupuestoTokens > 0
        ? Number(((this.gastadoTokens / this.presupuestoTokens) * 100).toFixed(2))
        : null;

    return {
      activo: true,
      modoControl,
      preciosConfigurados: this.preciosConfigurados,
      presupuestoUSD: this.presupuestoUSD,
      presupuestoTokens: this.presupuestoTokens,
      gastadoUSD: this.gastadoUSD,
      gastadoTokens: this.gastadoTokens,
      margenSeguridadUSD: this.obtenerMargenSeguridadUSD(),
      margenSeguridadTokens: this.obtenerMargenSeguridadTokens(),
      porcentajeUSD: pctUSD,
      porcentajeTokens: pctTokens,
      porcentajeMaximo: Math.max(pctUSD ?? 0, pctTokens ?? 0),
      llamadasContabilizadas: this.llamadasContabilizadas,
      advertencia80Emitida: this.advertencia80Emitida,
      limiteAlcanzado: this.limiteAlcanzado,
      cierreEjecutado: this.cierreEjecutado,
      codigoSalidaRegistrado: this.codigoSalidaRegistrado,
      itemsEnVuelo: this.itemsEnVuelo.size,
    };
  }
}

// ============================================================================
// 4. EXTRACCIÓN DE TOKENS Y ENVOLTORIO UNIVERSAL PARA EL MODELO (`src/llm.ts`)
// ============================================================================

/**
 * Extrae `tokensEntrada`, `tokensSalida` y `tokensTotal` desde cualquier formato de respuesta
 * de LangChain (`AIMessage`, `ChatResult`, `LLMResult`, o respuesta simulada en pruebas).
 */
export function extraerUsoTokensDeRespuestaModelo(respuesta: unknown): UsoTokensLlamada {
  const obj = respuesta as Record<string, any> | null | undefined;
  if (!obj || typeof obj !== "object") {
    return { tokensEntrada: 0, tokensSalida: 0, tokensTotal: 0 };
  }

  // Caso 1: AIMessage directo con usage_metadata
  const usageDirecto =
    obj.usage_metadata ??
    obj.response_metadata?.usage ??
    obj.response_metadata?.tokenUsage ??
    obj.llmOutput?.tokenUsage ??
    obj.llmOutput?.usage;

  // Caso 2: ChatResult ({ generations: [[{ message: AIMessage }]], llmOutput })
  const primerMensaje = obj.generations?.[0]?.[0]?.message ?? obj.generations?.[0]?.message;
  const usageGen =
    primerMensaje?.usage_metadata ??
    primerMensaje?.response_metadata?.usage ??
    primerMensaje?.response_metadata?.tokenUsage;

  const u = usageDirecto ?? usageGen ?? obj;

  const tokensEntrada = Number(
    u?.input_tokens ??
      u?.prompt_tokens ??
      u?.promptTokens ??
      u?.tokens_entrada ??
      u?.tokensEntrada ??
      0,
  );
  const tokensSalida = Number(
    u?.output_tokens ??
      u?.completion_tokens ??
      u?.completionTokens ??
      u?.tokens_salida ??
      u?.tokensSalida ??
      0,
  );
  const tokensTotal = Number(
    u?.total_tokens ??
      u?.totalTokens ??
      u?.tokens_total ??
      u?.tokensTotal ??
      tokensEntrada + tokensSalida,
  );

  return {
    tokensEntrada: Number.isFinite(tokensEntrada) ? Math.max(0, tokensEntrada) : 0,
    tokensSalida: Number.isFinite(tokensSalida) ? Math.max(0, tokensSalida) : 0,
    tokensTotal: Number.isFinite(tokensTotal)
      ? Math.max(tokensEntrada + tokensSalida, tokensTotal)
      : 0,
  };
}

const SIMBOLO_ENVUELTO_PRESUPUESTO = Symbol.for("secop.modelo.envuelto.presupuesto");
const almacenamientoGuardaContexto = new AsyncLocalStorage<GuardaPresupuesto>();

let guardaActivaGlobal: GuardaPresupuesto | null = null;

/**
 * Establece la guarda de presupuesto activa globalmente para todas las llamadas al modelo.
 */
export function establecerGuardaPresupuestoActiva(guarda: GuardaPresupuesto | null): void {
  guardaActivaGlobal = guarda;
}

/**
 * Obtiene la guarda de presupuesto activa (en el contexto actual o global).
 */
export function obtenerGuardaPresupuestoActiva(): GuardaPresupuesto | null {
  return almacenamientoGuardaContexto.getStore() ?? guardaActivaGlobal;
}

/**
 * Ejecuta una función dentro de un contexto con una `GuardaPresupuesto` específica.
 */
export function ejecutarConGuardaPresupuesto<T>(
  guarda: GuardaPresupuesto,
  fn: () => Promise<T>,
): Promise<T> {
  return almacenamientoGuardaContexto.run(guarda, fn);
}

let interceptorGlobalInstalado = false;

// ============================================================================
// 12. SEGUIMIENTO DE LLAMADOS AL GATEWAY Y BRECHAS TEMPORALES (S4-7)
// ============================================================================

let globalTiempoPrimerLlamadoMs: number | null = null;
let globalUltimoLlamadoGatewayMs: number | null = null;
let globalBrechaMaximaGatewaySeg: number = 0;

/**
 * Registra el momento exacto en que se efectúa una llamada al gateway del modelo,
 * calculando la brecha en segundos desde la última petición.
 */
export function registrarMomentoLlamadoGateway(): { brechaSeg: number; esPrimerLlamado: boolean } {
  const ahora = Date.now();
  let esPrimerLlamado = false;
  if (globalTiempoPrimerLlamadoMs === null) {
    globalTiempoPrimerLlamadoMs = ahora;
    esPrimerLlamado = true;
  }
  let brechaSeg = 0;
  if (globalUltimoLlamadoGatewayMs !== null) {
    brechaSeg = Number(((ahora - globalUltimoLlamadoGatewayMs) / 1000).toFixed(1));
    if (brechaSeg > globalBrechaMaximaGatewaySeg) {
      globalBrechaMaximaGatewaySeg = brechaSeg;
    }
  }
  globalUltimoLlamadoGatewayMs = ahora;
  return { brechaSeg, esPrimerLlamado };
}

/** Devuelve la marca de tiempo (ms) del primer llamado real al gateway */
export function obtenerTiempoPrimerLlamadoMs(): number | null {
  return globalTiempoPrimerLlamadoMs;
}

/** Permite restaurar el tiempo del primer llamado (p.ej. al reanudar desde estado.json) */
export function establecerTiempoPrimerLlamadoMs(ts: number): void {
  globalTiempoPrimerLlamadoMs = ts;
}

/** Devuelve la brecha máxima observada en el período y la reinicia a 0 (para cubos horarios) */
export function obtenerYReiniciarBrechaMaximaGateway(): number {
  const max = globalBrechaMaximaGatewaySeg;
  globalBrechaMaximaGatewaySeg = 0;
  return max;
}

/** Devuelve la brecha máxima observada sin reinicio */
export function obtenerBrechaMaximaGatewayActual(): number {
  return globalBrechaMaximaGatewaySeg;
}

/**
 * Instala el punto único centralizado de contabilidad y limitación de concurrencia
 * interceptando `ChatOpenAI.prototype._generate`.
 *
 * Todas las llamadas al modelo en LangChain (directas, con tools, agentes o clones)
 * pasan obligatoriamente por `ChatOpenAI.prototype._generate` EXACTAMENTE UNA VEZ.
 */
export function instalarInterceptorPresupuestoGlobal(): void {
  if (interceptorGlobalInstalado) return;

  const originalGenerate = ChatOpenAI.prototype._generate;

  ChatOpenAI.prototype._generate = async function (
    messages: any[],
    options: any,
    runManager?: any,
  ) {
    registrarMomentoLlamadoGateway();
    const guarda = obtenerGuardaPresupuestoActiva();
    if (!guarda) {
      return limitadorGatewayGlobal.ejecutar(() =>
        originalGenerate.call(this, messages, options, runManager),
      );
    }

    return limitadorGatewayGlobal.ejecutar(async () => {
      await guarda.verificarAntesDeLlamada();
      const resultado = await originalGenerate.call(this, messages, options, runManager);
      const uso = extraerUsoTokensDeRespuestaModelo(resultado);
      await guarda.registrarUsoDespuesDeLlamada(uso);
      return resultado;
    });
  };

  interceptorGlobalInstalado = true;
}

// Instalar el interceptor único global de ChatOpenAI al cargar este módulo
instalarInterceptorPresupuestoGlobal();

/**
 * Envuelve una instancia de modelo. Si es `ChatOpenAI`, ya está cubierta por el interceptor
 * global de prototipo; si es un objeto simulado (mock en pruebas unitarias), intercepta `invoke`.
 */
export function envolverModeloConPresupuesto<T extends object>(modelo: T): T {
  const m = modelo as Record<string | symbol, any>;
  if (!m || typeof m !== "object" || m[SIMBOLO_ENVUELTO_PRESUPUESTO]) {
    return modelo;
  }

  Object.defineProperty(m, SIMBOLO_ENVUELTO_PRESUPUESTO, {
    value: true,
    enumerable: false,
    configurable: true,
  });

  // Para objetos simulados en pruebas que no sean instancias de ChatOpenAI
  if (!(modelo instanceof ChatOpenAI)) {
    if (typeof m.invoke === "function") {
      const originalInvoke = m.invoke.bind(modelo);
      m.invoke = async function (...args: any[]) {
        const guarda = obtenerGuardaPresupuestoActiva();
        if (!guarda) {
          return originalInvoke(...args);
        }
        return guarda.ejecutarLlamadaModeloProtegida(
          () => originalInvoke(...args),
          extraerUsoTokensDeRespuestaModelo,
        );
      };
    }
  }

  return modelo;
}
