/**
 * Pruebas unitarias e integración de `src/carga/bitacora-tareas.ts` con datos sintéticos (S4-0).
 *
 * Verifica (sin llamadas al modelo):
 * 1. Escritura inmediata por tarea al finalizar (append + sync en CSV y JSONL).
 * 2. Regla estricta de éxito: fallbacks como "sin respuesta del modelo" o errores en A2/A3 son FALLO (`exito: false`).
 * 3. Prorrateo del costo de página de Agente 1 (`costoAsignadoUSD`) y costo directo de Agentes 2 y 3 (`costoDirectoUSD`).
 * 4. Idempotencia tras un reinicio simulado usando el estado persistente (`estado.json`):
 *    - Cero filas duplicadas para tareas ya terminadas.
 *    - Continuación de tareas en vuelo marcando `"reanudado tras reinicio"` en `recuperacion`.
 * 5. Quoting RFC 4180 en CSV (comas, comillas dobles, saltos de línea, truncado a 120 chars en `entrada`,
 *    ocultamiento de secretos en `errorMensaje`, y celdas USD vacías cuando precios son `null`).
 * 6. Validación del gateway oficial del reto (`verificarGatewayReto`).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COLUMNAS_BITACORA_TAREAS,
  DEFINICION_UNIDAD_TRABAJO,
  ENCABEZADO_CSV_BITACORA,
  GestorBitacoraTareas,
  parsearContenidoCsv,
  RETO_GATEWAY_HOSTNAME,
  verificarGatewayReto,
} from "../carga/bitacora-tareas.js";
import { RETO_BASE_URL } from "../llm.js";

async function ejecutarPruebas(): Promise<void> {
  console.log("================================================================================");
  console.log("🧪 PRUEBAS S4-0: Bitácora por Tarea, Idempotencia y Criterios Oficiales (Sin LLM)");
  console.log("================================================================================\n");

  const dirTemporal = await mkdtemp(path.join(os.tmpdir(), "secop-s4-0-test-"));

  try {
    // -------------------------------------------------------------------------
    // PRUEBA 1: Verificación del Gateway del Reto (Challenge Key & Hostname)
    // -------------------------------------------------------------------------
    console.log("▶️ [Prueba 1] Verificación del gateway oficial del reto...");
    const checkOk = verificarGatewayReto({
      baseUrl: RETO_BASE_URL,
      apiKey: "mock-key",
    });
    assert.equal(checkOk.ok, true);
    assert.equal(checkOk.hostname, RETO_GATEWAY_HOSTNAME);

    assert.throws(
      () =>
        verificarGatewayReto({
          baseUrl: "https://api.openai.com/v1",
          apiKey: "mock-key",
          silencioso: true,
        }),
      /no corresponde al gateway oficial del reto/i,
      "Debe rechazar un gateway distinto al del reto",
    );

    assert.throws(
      () =>
        verificarGatewayReto({
          baseUrl: RETO_BASE_URL,
          apiKey: "",
          silencioso: true,
        }),
      /RETO_KEY no está definida/i,
      "Debe rechazar si falta RETO_KEY",
    );
    console.log("   ✅ Gateway oficial validado (imprime solo hostname, bloquea URLs ajenas).\n");

    // -------------------------------------------------------------------------
    // PRUEBA 2: Escritura fila por tarea, prorrateo de costos, fallbacks y CSV quoting
    // -------------------------------------------------------------------------
    console.log("▶️ [Prueba 2] Escritura por tarea al finalizar, costos y regla de éxito...");
    const dirCaso1 = path.join(dirTemporal, "corrida-1");
    const gestor1 = new GestorBitacoraTareas({
      dirCarga: dirCaso1,
      tarifasOverride: {
        porMillonEntrada: 2.0,
        porMillonSalida: 6.0,
      },
    });

    const horaInicioPag = "2026-11-05T12:00:00.000Z";
    const horaFinPag = "2026-11-05T12:00:05.000Z";

    // Simulamos una página de 4 procesos en Agente 1:
    // - tokensPagina: entrada=4000, salida=1200, total=6000 (incluye 800 de razonamiento)
    // - Costo página (Estimación A conservadora): (4000 * 2 + 2000 * 6) / 1e6 = $0.020000 USD
    // - Costo asignado por proceso (4 en la página): $0.005000 USD cada uno
    const nombreLargoConComillasYComas =
      'Suministro de equipos de cómputo, impresoras "láser" y accesorios\npara sedes regionales — Lote 1, 2 y 3 (texto extra que supera los ciento veinte caracteres permitidos en la columna de entrada de la bitácora)';

    const resPag = await gestor1.registrarResultadoPaginaAgente1({
      ejecucionId: "20261105-120000_a1b2",
      ciclo: 1,
      fuente: "hoy",
      fechaDatos: "2026-11-05",
      horaInicio: horaInicioPag,
      horaFin: horaFinPag,
      intentosPagina: 2, // 1 reintento en Agente 1
      tokensPagina: { entrada: 4000, salida: 1200, total: 6000 },
      incluirDudosos: false,
      resultados: [
        {
          id: "CO1.REQ.1001",
          nombreProceso: nombreLargoConComillasYComas,
          aptoPyme: "si",
          categoriaObjeto: 'Equipos, "cómputo" y redes',
          razon: "Monto y objeto viables para pyme tecnológica",
          senales: ["pyme_ti"],
        },
        {
          id: "CO1.REQ.1002",
          nombreProceso: 'Construcción de viaducto mayor, tramo "Norte"\nFase II',
          aptoPyme: "no",
          categoriaObjeto: "Obra pública pesada",
          razon: "Megaproyecto vial fuera del alcance pyme",
          senales: ["infraestructura_pesada"],
        },
        {
          id: "CO1.REQ.1003",
          nombreProceso: "Servicio de mantenimiento preventivo de aires acondicionados, sede central",
          aptoPyme: "dudoso",
          categoriaObjeto: "No clasificado",
          razon: "sin respuesta del modelo",
          senales: ["omision_modelo"],
        },
        {
          id: "CO1.REQ.1004",
          nombreProceso: "Adquisición de papelería, útiles de escritorio y carpetas colgantes",
          aptoPyme: "si",
          categoriaObjeto: "Suministro de papelería",
          razon: "Compra estándar de suministros de oficina",
          senales: ["suministro_simple"],
        },
      ],
    });

    // CO1.REQ.1002 ("no") y CO1.REQ.1003 (fallback "sin respuesta del modelo") terminan en A1.
    // CO1.REQ.1001 y CO1.REQ.1004 ("si") quedan en vuelo para A2 y A3.
    assert.equal(resPag.finalizadosInmediatos, 2, "Deben finalizar 2 procesos en Agente 1 ('no' y fallback)");
    assert.equal(resPag.enVueloParaEtapas2y3, 2, "Deben quedar 2 procesos 'si' en vuelo para A2 y A3");

    const filasTrasA1 = await gestor1.leerFilasRegistradas();
    assert.equal(filasTrasA1.length, 2, "Deben existir exactamente 2 filas en disco tras Agente 1");

    const filaNo = filasTrasA1.find((f) => f.idProceso === "CO1.REQ.1002")!;
    assert.equal(filaNo.exito, true, "El proceso 'no' con veredicto válido es una tarea exitosa");
    assert.equal(filaNo.costoAsignadoUSD, 0.005, "Costo asignado de A1 debe ser 1/4 de $0.02 = $0.005");
    assert.equal(filaNo.costoDirectoUSD, 0, "Proceso 'no' tiene costo directo $0 en A2/A3");
    assert.equal(filaNo.recuperacion, "reintentos_agente1=1");

    const filaFallbackA1 = filasTrasA1.find((f) => f.idProceso === "CO1.REQ.1003")!;
    assert.equal(filaFallbackA1.exito, false, "El fallback 'sin respuesta del modelo' DEBE marcarse como FALLO");
    assert.equal(filaFallbackA1.errorTipo, "omision_modelo_agente1");
    assert.match(filaFallbackA1.recuperacion, /marcado fallido \(sin respuesta del modelo\)/);

    // Ahora completamos CO1.REQ.1001 en Agente 2 y Agente 3 exitosamente
    await gestor1.registrarAvanceAgente2({
      idProceso: "CO1.REQ.1001",
      ejecucionId: "20261105-120000_a1b2",
      ciclo: 1,
      fuente: "hoy",
      fechaDatos: "2026-11-05",
      horaInicio: "2026-11-05T12:00:06.000Z",
      horaFin: "2026-11-05T12:00:09.200Z",
      intentosAgente2: 1,
      tokensAgente2: { entrada: 2000, salida: 500, total: 3000 }, // Costo A2: (2000*2 + 1000*6)/1e6 = $0.010000
      resumenOk: true,
    });

    const fin1001 = await gestor1.finalizarProcesoEnAgente3({
      idProceso: "CO1.REQ.1001",
      ejecucionId: "20261105-120000_a1b2",
      ciclo: 1,
      fuente: "hoy",
      fechaDatos: "2026-11-05",
      horaInicio: "2026-11-05T12:00:09.500Z",
      horaFin: "2026-11-05T12:00:11.000Z",
      intentosAgente3: 1,
      tokensAgente3: { entrada: 1000, salida: 300, total: 1500 }, // Costo A3: (1000*2 + 500*6)/1e6 = $0.005000
      documentosOk: true,
    });

    assert.equal(fin1001.escrito, true);
    assert.equal(fin1001.fila.exito, true);
    assert.equal(fin1001.fila.entrada.length <= 120, true, "La entrada debe truncarse a máximo 120 caracteres");
    assert.equal(fin1001.fila.costoAsignadoUSD, 0.005, "Costo asignado de A1 ($0.005)");
    assert.equal(fin1001.fila.costoDirectoUSD, 0.015, "Costo directo A2 ($0.010) + A3 ($0.005) = $0.015");
    assert.equal(fin1001.fila.tokensEntrada, 1000 + 2000 + 1000);
    assert.equal(fin1001.fila.tokensSalida, 300 + 500 + 300);
    assert.equal(fin1001.fila.tokensTotal, 1500 + 3000 + 1500);
    assert.deepEqual(fin1001.fila.resultado, {
      aptoPyme: "si",
      categoriaObjeto: 'Equipos, "cómputo" y redes',
      resumenOk: true,
      documentosOk: true,
    });

    console.log("   ✅ Escritura inmediata, prorrateo de página y regla de éxito verificados.\n");

    // -------------------------------------------------------------------------
    // PRUEBA 3: Idempotencia tras un reinicio simulado (sin duplicar filas)
    // -------------------------------------------------------------------------
    console.log("▶️ [Prueba 3] Simulando reinicio del proceso y verificando idempotencia...");
    // Nota: CO1.REQ.1004 quedó en vuelo tras Agente 1 en `estado.json` antes del "corte".
    const gestorTrasReinicio = new GestorBitacoraTareas({
      dirCarga: dirCaso1,
      tarifasOverride: {
        porMillonEntrada: 2.0,
        porMillonSalida: 6.0,
      },
    });

    // 3a. Intentar volver a registrar CO1.REQ.1001 y CO1.REQ.1002 tras el reinicio
    const reintentoDuplicado = await gestorTrasReinicio.registrarTareaFinalizada(fin1001.fila);
    assert.equal(reintentoDuplicado.escrito, false, "No debe escribir una tarea ya registrada antes del reinicio");
    assert.equal(reintentoDuplicado.duplicado, true, "Debe detectar duplicado tras reinicio");

    const filasAntesDeCompletar1004 = await gestorTrasReinicio.leerFilasRegistradas();
    assert.equal(filasAntesDeCompletar1004.length, 3, "El número de filas en disco debe seguir siendo 3");

    // 3b. Ahora CO1.REQ.1004 (que estaba en vuelo en estado.json) continúa tras el reinicio,
    // y simulamos que falla en Agente 2 con un error que contiene un token secreto para probar sanitización
    await gestorTrasReinicio.registrarAvanceAgente2({
      idProceso: "CO1.REQ.1004",
      ejecucionId: "20261105-120500_c3d4",
      ciclo: 2,
      fuente: "hoy",
      fechaDatos: "2026-11-05",
      horaInicio: "2026-11-05T12:05:01.000Z",
      horaFin: "2026-11-05T12:05:03.000Z",
      intentosAgente2: 3,
      tokensAgente2: { entrada: 500, salida: 0, total: 500 },
      resumenOk: false,
      errorMensaje: "Error HTTP 502 en gateway con " + "Bearer " + "sk-" + "secreto987654321" + " y nota: timeout",
    });

    const fin1004 = await gestorTrasReinicio.finalizarProcesoEnAgente3({
      idProceso: "CO1.REQ.1004",
      ejecucionId: "20261105-120500_c3d4",
      ciclo: 2,
      fuente: "hoy",
      fechaDatos: "2026-11-05",
      horaInicio: "2026-11-05T12:05:03.100Z",
      horaFin: "2026-11-05T12:05:03.500Z",
      intentosAgente3: 1,
      tokensAgente3: { entrada: 0, salida: 0, total: 0 },
      documentosOk: true,
    });

    assert.equal(fin1004.escrito, true);
    assert.equal(fin1004.fila.exito, false, "Al fallar Agente 2 (resumenOk=false), la tarea es FALLO");
    assert.match(
      fin1004.fila.recuperacion,
      /reanudado tras reinicio/,
      "Debe registrar que fue reanudado tras reinicio",
    );
    assert.equal(
      fin1004.fila.errorMensaje?.includes("sk-" + "secreto987654321"),
      false,
      "Nunca debe escribir secretos en errorMensaje",
    );
    assert.match(fin1004.fila.errorMensaje ?? "", /\[OCULTO\]/);

    const resumenFinal = await gestorTrasReinicio.obtenerResumenBitacora();
    assert.equal(resumenFinal.unidadesOficiales.total, 4);
    assert.equal(resumenFinal.unidadesOficiales.exitosas, 2); // 1001 ("si" completo) y 1002 ("no" válido)
    assert.equal(resumenFinal.unidadesOficiales.fallidas, 2); // 1003 (fallback A1) y 1004 (fallback A2)
    assert.equal(resumenFinal.conteosSecundarios.soloVeredictoAgente1, 3); // 1001, 1002, 1004
    assert.equal(resumenFinal.conteosSecundarios.siCompletadosAgentes123, 1); // 1001

    console.log("   ✅ Idempotencia tras reinicio y conteos paralelos verificados.\n");

    // -------------------------------------------------------------------------
    // PRUEBA 4: Quoting RFC 4180 en CSV y modo sin precios (tarifas = null)
    // -------------------------------------------------------------------------
    console.log("▶️ [Prueba 4] Validando parseo RFC 4180 del CSV (comas, comillas y saltos de línea) y modo precios=null...");
    const rutas1 = gestorTrasReinicio.obtenerRutas();
    const rawCsv = await readFile(rutas1.csv, "utf8");
    const filasCsv = parsearContenidoCsv(rawCsv);

    assert.equal(filasCsv.length, 5, "El CSV debe tener 1 fila de encabezado + 4 filas de tareas");
    assert.deepEqual(
      filasCsv[0],
      Array.from(COLUMNAS_BITACORA_TAREAS),
      "El encabezado del CSV debe coincidir exactamente con las 20 columnas especificadas",
    );

    for (let i = 1; i < filasCsv.length; i++) {
      assert.equal(
        filasCsv[i]!.length,
        COLUMNAS_BITACORA_TAREAS.length,
        `La fila ${i} del CSV debe tener exactamente ${COLUMNAS_BITACORA_TAREAS.length} columnas tras des-escapar comas y saltos de línea`,
      );
    }

    // Verificar que el salto de línea y las comillas dobles en la fila de CO1.REQ.1002 se preservaron intactos
    const idxId = COLUMNAS_BITACORA_TAREAS.indexOf("idProceso");
    const idxEntrada = COLUMNAS_BITACORA_TAREAS.indexOf("entrada");
    const filaCsv1002 = filasCsv.find((r) => r[idxId] === "CO1.REQ.1002")!;
    assert.ok(filaCsv1002[idxEntrada]!.includes('"Norte"\nFase II'), "Debe preservar comillas y saltos de línea en CSV");

    // Probar modo sin precios (tarifas = null)
    const dirSinPrecios = path.join(dirTemporal, "corrida-sin-precios");
    const gestorSinPrecios = new GestorBitacoraTareas({
      dirCarga: dirSinPrecios,
      tarifasOverride: null,
    });
    await gestorSinPrecios.registrarResultadoPaginaAgente1({
      ejecucionId: "20261105-121000_null",
      ciclo: 1,
      fuente: "historico",
      fechaDatos: "2026-10-15",
      horaInicio: horaInicioPag,
      horaFin: horaFinPag,
      intentosPagina: 1,
      tokensPagina: { entrada: 1000, salida: 250, total: 1500 },
      resultados: [
        {
          id: "CO1.REQ.9999",
          nombreProceso: "Proceso en modo sin precios configurados",
          aptoPyme: "no",
          categoriaObjeto: "Obra civil",
          razon: "No apto",
          senales: ["obra"],
        },
      ],
    });
    const rawCsvSinPrecios = await readFile(gestorSinPrecios.obtenerRutas().csv, "utf8");
    const filasSinPrecios = parsearContenidoCsv(rawCsvSinPrecios);
    const idxTokensEntrada = COLUMNAS_BITACORA_TAREAS.indexOf("tokensEntrada");
    const idxTokensTotal = COLUMNAS_BITACORA_TAREAS.indexOf("tokensTotal");
    const idxCostoDirecto = COLUMNAS_BITACORA_TAREAS.indexOf("costoDirectoUSD");
    const idxCostoAsignado = COLUMNAS_BITACORA_TAREAS.indexOf("costoAsignadoUSD");
    assert.equal(filasSinPrecios[1]![idxTokensEntrada], "1000", "Debe conservar tokensEntrada cuando precios son null");
    assert.equal(filasSinPrecios[1]![idxTokensTotal], "1500", "Debe conservar tokensTotal cuando precios son null");
    assert.equal(filasSinPrecios[1]![idxCostoDirecto], "", "costoDirectoUSD debe quedar vacío en CSV cuando precios son null");
    assert.equal(filasSinPrecios[1]![idxCostoAsignado], "", "costoAsignadoUSD debe quedar vacío en CSV cuando precios son null");

    console.log("   ✅ Quoting CSV RFC 4180 y fallback de precios nulos verificados.\n");

    // -------------------------------------------------------------------------
    // IMPRESIÓN DE RESUMEN Y 3 FILAS DE MUESTRA DEL CSV
    // -------------------------------------------------------------------------
    console.log("================================================================================");
    console.log("📊 RESUMEN DE CONTEOS PARALELOS DE UNIDADES DE TRABAJO (PRUEBA)");
    console.log("================================================================================");
    console.log(`• Definición oficial: ${DEFINICION_UNIDAD_TRABAJO}`);
    console.log(
      `• [1] Unidades oficiales (fin a fin):       ${resumenFinal.unidadesOficiales.total} ` +
        `(Éxito: ${resumenFinal.unidadesOficiales.exitosas}, Fallo: ${resumenFinal.unidadesOficiales.fallidas}, ` +
        `Tasa éxito: ${resumenFinal.unidadesOficiales.tasaExitoPorcentaje}%)`,
    );
    console.log(
      `• [2] Secundario (solo veredicto Agente 1): ${resumenFinal.conteosSecundarios.soloVeredictoAgente1}`,
    );
    console.log(
      `• [3] Secundario ("si" completados 1+2+3):  ${resumenFinal.conteosSecundarios.siCompletadosAgentes123}`,
    );
    console.log(
      `• Costo Total USD: $${resumenFinal.costos.costoTotalUSD?.toFixed(6)} ` +
        `(Asignado A1: $${resumenFinal.costos.costoAsignadoTotalUSD?.toFixed(6)}, ` +
        `Directo A2+A3: $${resumenFinal.costos.costoDirectoTotalUSD?.toFixed(6)})`,
    );

    console.log("\n================================================================================");
    console.log("📄 MUESTRA DE ENCABEZADO Y 3 FILAS DE bitacora-tareas.csv");
    console.log("================================================================================");
    console.log(ENCABEZADO_CSV_BITACORA);
    // Reconstruimos cada fila física desde las filas registradas para mostrar las 3 primeras filas completas
    const filasJsonl = await gestorTrasReinicio.leerFilasRegistradas();
    const { serializarFilaCsv } = await import("../carga/bitacora-tareas.js");
    for (const f of filasJsonl.slice(0, 3)) {
      console.log(serializarFilaCsv(f));
    }
    console.log("================================================================================\n");
    console.log("✅ TODAS LAS PRUEBAS DE S4-0 PASARON EXITOSAMENTE (0 llamadas al modelo).");
  } finally {
    await rm(dirTemporal, { recursive: true, force: true });
  }
}

ejecutarPruebas().catch((err) => {
  console.error("❌ Fallo en las pruebas de S4-0:", err);
  process.exit(1);
});

