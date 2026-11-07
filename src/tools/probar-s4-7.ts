/**
 * Pruebas unitarias y de integración para S4-7 (src/tools/probar-s4-7.ts).
 * 0 llamadas al modelo / 0 créditos consumidos.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatearHoraLocalCO,
  COLUMNAS_BITACORA_TAREAS,
  serializarFilaCsv,
  FilaBitacoraTarea,
} from "../carga/bitacora-tareas.js";
import { archivarEnsayosPrevios } from "./archivar-ensayos.js";
import { calcularCostoEfectivoPorTarea } from "./costo-efectivo.js";
import { parsearArgumentosDaemon } from "../daemon.js";
import {
  obtenerTiempoPrimerLlamadoMs,
  establecerTiempoPrimerLlamadoMs,
  registrarMomentoLlamadoGateway,
  obtenerYReiniciarBrechaMaximaGateway,
} from "../carga/presupuesto.js";

async function probarS4_7(): Promise<void> {
  console.log("================================================================================");
  console.log("🧪 PRUEBAS UNITARIAS E INTEGRACIÓN S4-7 (Sin LLM)");
  console.log("================================================================================");

  // 1. Prueba de formateo y columna horaLocalCO (UTC-5 America/Bogota)
  console.log("\n▶️ [Prueba 1] Verificación de horaLocalCO (America/Bogota, UTC-5)...");
  const isoUtc = "2026-11-06T23:30:00.000Z";
  const horaCol = formatearHoraLocalCO(isoUtc);
  assert.equal(horaCol, "2026-11-06T18:30:00.000-05:00", "Debe convertir UTC a UTC-5 sin desvío");
  assert.ok(COLUMNAS_BITACORA_TAREAS.includes("horaLocalCO"), "COLUMNAS_BITACORA_TAREAS debe incluir horaLocalCO");

  const filaSintetica: FilaBitacoraTarea = {
    tareaId: "t-001",
    ejecucionId: "e-001",
    ciclo: 1,
    fuente: "historico",
    fechaDatos: "2026-10-15",
    horaInicio: isoUtc,
    horaFin: isoUtc,
    horaLocalCO: horaCol,
    idProceso: "CO1.REQ.9999",
    entrada: "Suministro de prueba",
    resultado: { aptoPyme: "si", categoriaObjeto: "Tecnología" },
    exito: true,
    errorTipo: null,
    errorMensaje: null,
    recuperacion: "ninguna",
    tokensEntrada: 1200,
    tokensSalida: 300,
    tokensTotal: 1500,
    costoDirectoUSD: null,
    costoAsignadoUSD: null,
    latenciaSeg: 2.5,
  };

  const csvSerializado = serializarFilaCsv(filaSintetica);
  assert.ok(csvSerializado.includes("2026-11-06T18:30:00.000-05:00"), "El CSV debe contener horaLocalCO");
  console.log("   ✔ horaLocalCO y serialización CSV validadas.");

  // 2. Prueba de seguimiento de brechas de gateway
  console.log("\n▶️ [Prueba 2] Seguimiento de brechas y tiempo de primer llamado al gateway...");
  establecerTiempoPrimerLlamadoMs(Date.now() - 10000);
  const tPrimer = obtenerTiempoPrimerLlamadoMs();
  assert.ok(typeof tPrimer === "number" && tPrimer > 0, "Debe registrar tiempo de primer llamado");

  registrarMomentoLlamadoGateway();
  const brechaMax = obtenerYReiniciarBrechaMaximaGateway();
  assert.ok(brechaMax >= 0, "Debe obtener brecha máxima");
  assert.equal(obtenerYReiniciarBrechaMaximaGateway(), 0, "Debe resetearse a 0 tras lectura");
  console.log("   ✔ Seguimiento de brechas temporales validado.");

  // 3. Prueba de banderas CLI de daemon (--horas-minimas, --ritmo-por-hora, --ignorar-proyeccion)
  console.log("\n▶️ [Prueba 3] Banderas CLI nuevas del daemon...");
  const opts = parsearArgumentosDaemon([
    "--fuente=historico",
    "--unidades=1150",
    "--horas=12.5",
    "--horas-minimas=12.2",
    "--ritmo-por-hora=600",
    "--lote=5",
    "--ignorar-proyeccion",
  ]);
  assert.equal(opts.horasMinimas, 12.2, "horasMinimas debe ser 12.2");
  assert.equal(opts.ritmoPorHora, 600, "ritmoPorHora debe ser 600");
  assert.equal(opts.lote, 5, "lote debe ser 5");
  assert.equal(opts.ignorarProyeccion, true, "ignorarProyeccion debe ser true");
  console.log("   ✔ Banderas CLI del daemon parseadas correctamente.");

  // 4. Prueba aislada de archivar-ensayos y costo-efectivo en directorio temporal
  console.log("\n▶️ [Prueba 4] Archivador de ensayos y generador de costo efectivo...");
  const dirTmp = path.join(process.cwd(), "data", "pruebas-reto", "carga", "test-tmp-s4-7");
  await mkdir(dirTmp, { recursive: true });

  try {
    const csvTestContenido = [
      COLUMNAS_BITACORA_TAREAS.join(","),
      serializarFilaCsv(filaSintetica),
      serializarFilaCsv({ ...filaSintetica, tareaId: "t-002", idProceso: "CO1.REQ.9998", tokensTotal: 2500 }),
    ].join("\n") + "\n";

    await writeFile(path.join(dirTmp, "bitacora-tareas.csv"), csvTestContenido, "utf8");
    await writeFile(path.join(dirTmp, "bitacora-tareas.jsonl"), JSON.stringify(filaSintetica) + "\n", "utf8");
    await writeFile(path.join(dirTmp, "heartbeat.json"), JSON.stringify({ ok: true }) + "\n", "utf8");

    // Probar costo efectivo
    const resCosto = await calcularCostoEfectivoPorTarea({
      gastoPanelUSD: 2.0,
      dirCarga: dirTmp,
      silencioso: true,
    });

    assert.equal(resCosto.totalTareas, 2, "Debe procesar 2 tareas");
    assert.equal(resCosto.totalTokens, 4000, "1500 + 2500 = 4000 tokens");
    assert.equal(resCosto.costoPromedioPorTareaUSD, 1.0, "$2.00 / 2 tareas = $1.00");
    assert.equal(resCosto.tasaEfectivaUSDPorToken, 2.0 / 4000);

    const conCostoRaw = await readFile(path.join(dirTmp, "bitacora-tareas-con-costo.csv"), "utf8");
    assert.ok(conCostoRaw.includes("costoEstimadoUSD"), "Debe tener columna costoEstimadoUSD");
    assert.ok(conCostoRaw.includes("prorrateo_gasto_panel"), "Debe tener valor metodoCosto prorrateo_gasto_panel");

    // Probar archivar-ensayos en el directorio de pruebas
    const resArchivado = await archivarEnsayosPrevios({
      dirCarga: dirTmp,
      timestamp: "test-archivado-s4-7",
      silencioso: true,
    });
    assert.ok(resArchivado.archivosMovidos.length >= 3, "Debe haber movido al menos los 3 archivos creados");
    console.log("   ✔ Costo efectivo y archivador de ensayos verificados.");
  } finally {
    await rm(dirTmp, { recursive: true, force: true });
  }

  console.log("\n================================================================================");
  console.log("✅ TODAS LAS PRUEBAS DE S4-7 PASARON SATISFACTORIAMENTE (0 llamadas al modelo)");
  console.log("================================================================================");
}

probarS4_7().catch((err) => {
  console.error("❌ Fallo en probar-s4-7:", err);
  process.exit(1);
});

