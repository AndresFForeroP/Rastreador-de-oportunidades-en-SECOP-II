/**
 * Prueba de verificación para el contador completadosAgentes123 (S4-FINAL A.1).
 * Verifica que una unidad "si" con resumenOk=true y documentosOk=true incremente completadosAgentes123,
 * y que una unidad "dudoso" incremente oficialFinAFin pero NO completadosAgentes123.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GestorEstadoCarga,
  establecerGestorEstadoPorDefecto,
} from "../carga/estado.js";
import {
  GestorBitacoraTareas,
  type FilaBitacoraTarea,
} from "../carga/bitacora-tareas.js";

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "secop-test-a123-"));
  console.log(`[test-a123] Directorio temporal: ${tmpDir}`);

  try {
    const rutaEstado = path.join(tmpDir, "estado.json");
    const gestorEstado = new GestorEstadoCarga({
      dirCarga: tmpDir,
      rutaEstado,
      rutaEventos: path.join(tmpDir, "eventos.jsonl"),
    });
    establecerGestorEstadoPorDefecto(gestorEstado);
    await gestorEstado.inicializar();

    const gestorBitacora = new GestorBitacoraTareas({
      dirCarga: tmpDir,
      rutaEstado,
    });
    await gestorBitacora.inicializar();

    // 1. Registrar unidad "si" completa (resumenOk=true, documentosOk=true)
    const filaSi: FilaBitacoraTarea = {
      tareaId: "tarea_2026-10-23_CO1.REQ.TEST001",
      ejecucionId: "test-run",
      ciclo: 1,
      fuente: "historico",
      fechaDatos: "2026-10-23",
      horaInicio: new Date().toISOString(),
      horaFin: new Date().toISOString(),
      idProceso: "CO1.REQ.TEST001",
      entrada: "Proceso de prueba SI",
      resultado: {
        aptoPyme: "si",
        categoriaObjeto: "suministros",
        resumenOk: true,
        documentosOk: true,
      },
      exito: true,
      errorTipo: null,
      errorMensaje: null,
      recuperacion: "sin reintentos",
      tokensEntrada: 1000,
      tokensSalida: 200,
      tokensTotal: 1200,
      costoDirectoUSD: 0.005,
      costoAsignadoUSD: 0.001,
      latenciaSeg: 15.0,
    };

    const resSi = await gestorBitacora.registrarTareaFinalizada(filaSi);
    assert.equal(resSi.escrito, true);

    const st1 = gestorEstado.obtenerEstado();
    console.log(`[test-a123] Tras unidad SI:`, {
      oficialFinAFin: st1.contadoresUnidades.oficialFinAFin,
      completadosAgentes123: st1.contadoresUnidades.completadosAgentes123,
    });
    assert.equal(st1.contadoresUnidades.oficialFinAFin, 1, "oficialFinAFin debe ser 1");
    assert.equal(st1.contadoresUnidades.completadosAgentes123, 1, "completadosAgentes123 debe ser 1 para unidad SI completa");

    // 2. Registrar unidad "dudoso" (resumen y docs no aplican o ausentes)
    const filaDudoso: FilaBitacoraTarea = {
      tareaId: "tarea_2026-10-23_CO1.REQ.TEST002",
      ejecucionId: "test-run",
      ciclo: 1,
      fuente: "historico",
      fechaDatos: "2026-10-23",
      horaInicio: new Date().toISOString(),
      horaFin: new Date().toISOString(),
      idProceso: "CO1.REQ.TEST002",
      entrada: "Proceso de prueba DUDOSO",
      resultado: {
        aptoPyme: "dudoso",
        categoriaObjeto: "consultoria",
      },
      exito: true,
      errorTipo: null,
      errorMensaje: null,
      recuperacion: "sin reintentos",
      tokensEntrada: 500,
      tokensSalida: 50,
      tokensTotal: 550,
      costoDirectoUSD: 0.0,
      costoAsignadoUSD: 0.001,
      latenciaSeg: 2.5,
    };

    const resDudoso = await gestorBitacora.registrarTareaFinalizada(filaDudoso);
    assert.equal(resDudoso.escrito, true);

    const st2 = gestorEstado.obtenerEstado();
    console.log(`[test-a123] Tras unidad DUDOSO:`, {
      oficialFinAFin: st2.contadoresUnidades.oficialFinAFin,
      completadosAgentes123: st2.contadoresUnidades.completadosAgentes123,
    });
    assert.equal(st2.contadoresUnidades.oficialFinAFin, 2, "oficialFinAFin debe ser 2 tras dudoso");
    assert.equal(st2.contadoresUnidades.completadosAgentes123, 1, "completadosAgentes123 debe mantenerse en 1 tras dudoso");

    // 3. Registrar unidad "si" fallida (ej. resumenOk=false o documentosOk=false)
    const filaSiFallida: FilaBitacoraTarea = {
      tareaId: "tarea_2026-10-23_CO1.REQ.TEST003",
      ejecucionId: "test-run",
      ciclo: 1,
      fuente: "historico",
      fechaDatos: "2026-10-23",
      horaInicio: new Date().toISOString(),
      horaFin: new Date().toISOString(),
      idProceso: "CO1.REQ.TEST003",
      entrada: "Proceso SI fallido",
      resultado: {
        aptoPyme: "si",
        categoriaObjeto: "obras",
        resumenOk: true,
        documentosOk: false,
      },
      exito: false,
      errorTipo: "error_modelo_agente3",
      errorMensaje: "Fallback por timeout en Agente 3",
      recuperacion: "marcado fallido",
      tokensEntrada: 800,
      tokensSalida: 100,
      tokensTotal: 900,
      costoDirectoUSD: 0.002,
      costoAsignadoUSD: 0.001,
      latenciaSeg: 8.0,
    };

    const resSiFallida = await gestorBitacora.registrarTareaFinalizada(filaSiFallida);
    assert.equal(resSiFallida.escrito, true);

    const st3 = gestorEstado.obtenerEstado();
    console.log(`[test-a123] Tras unidad SI fallida (documentosOk=false):`, {
      oficialFinAFin: st3.contadoresUnidades.oficialFinAFin,
      fallidasFinAFin: st3.contadoresUnidades.fallidasFinAFin,
      completadosAgentes123: st3.contadoresUnidades.completadosAgentes123,
    });
    assert.equal(st3.contadoresUnidades.oficialFinAFin, 3, "oficialFinAFin debe ser 3");
    assert.equal(st3.contadoresUnidades.fallidasFinAFin, 1, "fallidasFinAFin debe ser 1");
    assert.equal(st3.contadoresUnidades.completadosAgentes123, 1, "completadosAgentes123 debe NO incrementar si documentosOk es false");

    console.log("✅ [test-a123] TODAS LAS ASERCIONES SUPERADAS EXITOSAMENTE.");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ [test-a123] Error:", err);
  process.exit(1);
});

