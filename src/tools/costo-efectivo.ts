/**
 * Herramienta de cálculo de costo efectivo por tarea a partir del gasto del panel (S4-7).
 *
 * Comando CLI: `pnpm carga:costo-efectivo --gasto-panel-usd=<n>`
 *
 * Cumple los requerimientos oficiales de S4-7 (Tarea 5):
 * (a) Computa la tasa efectiva USD por token de la corrida:
 *     tasaEfectiva = gastoPanelUSD / totalTokensRun (tokens_total)
 * (b) Escribe NUEVOS archivos `bitacora-tareas-con-costo.csv` y `bitacora-tareas-con-costo.jsonl`
 *     (sin sobreescribir jamás los originales) con `costoEstimadoUSD` por tarea prorrateado por tokens
 *     y `metodoCosto: "prorrateo_gasto_panel"`.
 * (c) Actualiza `docs/RESUMEN-S4.md` con el costo total y costo por tarea indicando el método.
 */
import { existsSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIR_CARGA,
  rutaBitacoraTareasCsv,
  rutaBitacoraTareasJsonl,
  rutaEstadoCarga,
  rutaRecursosCarga,
} from "../pruebas/rutas.js";
import { parsearContenidoCsv } from "../carga/bitacora-tareas.js";
import {
  generarBitacoraCarga,
  leerTareasCsv,
} from "../carga/bitacora.js";

export function parsearArgumentosCostoEfectivo(argv: string[] = process.argv.slice(2)): {
  gastoPanelUSD: number;
} {
  let gastoPanelUSD: number | null = process.env.GASTO_PANEL_USD
    ? Number.parseFloat(process.env.GASTO_PANEL_USD)
    : null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--gasto-panel-usd=")) {
      const v = Number.parseFloat(arg.slice("--gasto-panel-usd=".length).trim());
      if (Number.isFinite(v) && v > 0) gastoPanelUSD = v;
    } else if (arg === "--gasto-panel-usd" && argv[i + 1]) {
      const v = Number.parseFloat(argv[++i]!.trim());
      if (Number.isFinite(v) && v > 0) gastoPanelUSD = v;
    }
  }

  if (gastoPanelUSD === null || !Number.isFinite(gastoPanelUSD) || gastoPanelUSD <= 0) {
    console.error("================================================================================");
    console.error("❌ ERROR: Debe indicar el valor real facturado en el panel del reto.");
    console.error("   Uso: pnpm carga:costo-efectivo --gasto-panel-usd=<valor>");
    console.error("   Ejemplo: pnpm carga:costo-efectivo --gasto-panel-usd=1.45");
    console.error("================================================================================\n");
    process.exit(1);
  }

  return { gastoPanelUSD };
}

export async function calcularCostoEfectivoPorTarea(params: {
  gastoPanelUSD: number;
  dirCarga?: string;
  silencioso?: boolean;
}): Promise<{
  gastoPanelUSD: number;
  totalTareas: number;
  totalTokens: number;
  tasaEfectivaUSDPorToken: number;
  costoPromedioPorTareaUSD: number;
  rutaCsvSalida: string;
  rutaJsonlSalida: string;
}> {
  const dirCarga = params.dirCarga ?? DIR_CARGA;
  const rutaCsvOriginal = path.join(dirCarga, "bitacora-tareas.csv");
  const rutaJsonlOriginal = path.join(dirCarga, "bitacora-tareas.jsonl");

  if (!existsSync(rutaCsvOriginal)) {
    throw new Error(
      `No se encontró el archivo de bitácora original en: ${rutaCsvOriginal}. ` +
        `Asegúrese de haber ejecutado al menos un ensayo o la corrida antes de calcular costos efectivos.`,
    );
  }

  const rawCsv = await readFile(rutaCsvOriginal, "utf8");
  const filasCsv = parsearContenidoCsv(rawCsv);

  if (filasCsv.length <= 1) {
    throw new Error(`El archivo ${rutaCsvOriginal} no contiene registros de tareas finalizadas.`);
  }

  const encabezadoOriginal = filasCsv[0]!;
  const idxTokensTotal = encabezadoOriginal.indexOf("tokensTotal");

  if (idxTokensTotal === -1) {
    throw new Error(`La columna 'tokensTotal' no existe en el encabezado del archivo CSV.`);
  }

  // 1. Sumar tokens totales de las filas de la corrida
  let totalTokens = 0;
  const totalTareas = filasCsv.length - 1;

  for (let i = 1; i < filasCsv.length; i++) {
    const tokensFila = Number(filasCsv[i]![idxTokensTotal] ?? 0);
    if (Number.isFinite(tokensFila) && tokensFila > 0) {
      totalTokens += tokensFila;
    }
  }

  if (totalTokens <= 0) {
    throw new Error(`El total de tokens registrados en ${rutaCsvOriginal} es 0. Imposible prorratear.`);
  }

  // (a) Tasa efectiva en USD por token
  const tasaEfectivaUSDPorToken = params.gastoPanelUSD / totalTokens;
  const costoPromedioPorTareaUSD = params.gastoPanelUSD / totalTareas;

  if (!params.silencioso) {
    console.log("================================================================================");
    console.log("💰 CALCULO DE COSTO EFECTIVO POR TAREA (S4-7)");
    console.log("================================================================================");
    console.log(`💵 Gasto reportado en el Panel del Reto: $${params.gastoPanelUSD.toFixed(4)} USD`);
    console.log(`📦 Tareas registradas en la corrida:     ${totalTareas.toLocaleString("es-CO")} tareas`);
    console.log(`🪙 Total de tokens facturados (ledger):  ${totalTokens.toLocaleString("es-CO")} tokens`);
    console.log(`📈 Tasa efectiva prorrateada:            $${(tasaEfectivaUSDPorToken * 1_000_000).toFixed(4)} USD / millón de tokens`);
    console.log(`🎯 Costo promedio por tarea:             $${costoPromedioPorTareaUSD.toFixed(6)} USD / tarea`);
    console.log("--------------------------------------------------------------------------------\n");
  }

  // (b) Generar NUEVOS archivos bitacora-tareas-con-costo.csv/.jsonl sin sobreescribir los originales
  const rutaCsvSalida = path.join(dirCarga, "bitacora-tareas-con-costo.csv");
  const rutaJsonlSalida = path.join(dirCarga, "bitacora-tareas-con-costo.jsonl");

  // Encabezado extendido
  const encabezadoExtendido = [...encabezadoOriginal, "costoEstimadoUSD", "metodoCosto"];
  const lineasCsvSalida: string[] = [encabezadoExtendido.join(",")];

  for (let i = 1; i < filasCsv.length; i++) {
    const fila = filasCsv[i]!;
    const tokensFila = Number(fila[idxTokensTotal] ?? 0);
    const costoEstimadoUSD = Number((tokensFila * tasaEfectivaUSDPorToken).toFixed(6));
    const metodoCosto = "prorrateo_gasto_panel";

    // Escapar celdas para CSV RFC 4180
    const filaExtendida = [
      ...fila.map((c) => (c.includes(",") || c.includes('"') || c.includes("\n") ? `"${c.replace(/"/g, '""')}"` : c)),
      costoEstimadoUSD.toFixed(6),
      metodoCosto,
    ];
    lineasCsvSalida.push(filaExtendida.join(","));
  }

  await writeFile(rutaCsvSalida, lineasCsvSalida.join("\n") + "\n", "utf8");

  // Procesar JSONL si existe
  if (existsSync(rutaJsonlOriginal)) {
    const rawJsonl = await readFile(rutaJsonlOriginal, "utf8");
    const lineasJsonl = rawJsonl.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const lineasJsonlSalida: string[] = [];

    for (const linea of lineasJsonl) {
      try {
        const item = JSON.parse(linea);
        const tokensItem = Number(item.tokensTotal ?? 0);
        item.costoEstimadoUSD = Number((tokensItem * tasaEfectivaUSDPorToken).toFixed(6));
        item.metodoCosto = "prorrateo_gasto_panel";
        lineasJsonlSalida.push(JSON.stringify(item));
      } catch {
        // Ignorar línea corrupta
      }
    }

    await writeFile(rutaJsonlSalida, lineasJsonlSalida.join("\n") + "\n", "utf8");
  }

  if (!params.silencioso) {
    console.log(`📄 Archivo CSV con costo efectivo escrito en:`);
    console.log(`   ➜ ${rutaCsvSalida}`);
    console.log(`📄 Archivo JSONL con costo efectivo escrito en:`);
    console.log(`   ➜ ${rutaJsonlSalida}\n`);
  }

  // (c) Regenerar bitacora-carga.md y actualizar docs/RESUMEN-S4.md indicando el método
  try {
    await generarBitacoraCarga({
      gastoPanelUSD: params.gastoPanelUSD,
      dirCarga,
      silencioso: true,
    });
    if (!params.silencioso) {
      console.log(`✅ Bitácora consolidada (bitacora-carga.md) y Resumen (docs/RESUMEN-S4.md) actualizados con éxito.`);
      console.log(`   Método registrado: 'prorrateo_gasto_panel'`);
      console.log("================================================================================\n");
    }
  } catch (err) {
    console.warn("⚠️ Advertencia: No se pudo regenerar automáticamente la bitácora tras actualizar costos:", err);
  }

  return {
    gastoPanelUSD: params.gastoPanelUSD,
    totalTareas,
    totalTokens,
    tasaEfectivaUSDPorToken,
    costoPromedioPorTareaUSD,
    rutaCsvSalida,
    rutaJsonlSalida,
  };
}

// Ejecución directa desde CLI
if (process.argv[1] && process.argv[1].endsWith("costo-efectivo.ts")) {
  const { gastoPanelUSD } = parsearArgumentosCostoEfectivo();
  calcularCostoEfectivoPorTarea({ gastoPanelUSD }).catch((err) => {
    console.error("❌ Fallo en costo-efectivo:", err);
    process.exit(1);
  });
}

