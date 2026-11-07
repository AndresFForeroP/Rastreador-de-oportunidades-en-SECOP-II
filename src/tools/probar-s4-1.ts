/**
 * Suite de pruebas automatizadas con datos simulados (sin llamadas reales al modelo) para S4-1:
 * 1. Rechazo de inicio en corridas largas (daemon/carga) sin presupuesto y respaldo con --presupuesto-tokens cuando precios son null.
 * 2. Guarda dura de presupuesto (`src/carga/presupuesto.ts`): estimación conservadora (máx entre A y B),
 *    evento de advertencia al 80%, detención de nuevo trabajo al límite, finalización de ítems en vuelo,
 *    escritura atómica de `estado.json` y salida limpia con código 0.
 * 3. Supervivencia de `estado.json` ante una escritura interrumpida (archivo temporal truncado antes de `rename`).
 * 4. Idempotencia estricta tras un reinicio simulado con `esProcesado(id, etapa)` y `marcar(id, etapa)`
 *    sin reprocesar ni duplicar contadores de unidades.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DESCRIPCIONES_UNIDADES_TRABAJO,
  GestorEstadoCarga,
  UNIDAD_TRABAJO_POR_DEFECTO,
} from "../carga/estado.js";
import {
  calcularUsoConservadorLlamada,
  ejecutarConGuardaPresupuesto,
  envolverModeloConPresupuesto,
  ErrorConfiguracionPresupuesto,
  ErrorPresupuestoAlcanzado,
  exigirPresupuestoParaEjecucionLarga,
  GuardaPresupuesto,
  parsearOpcionesPresupuesto,
} from "../carga/presupuesto.js";
import { ejecutarEstimacionCarga } from "./estimar-carga.js";

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ejecutarPruebasS4_1(): Promise<void> {
  console.log("========================================================================");
  console.log("PRUEBAS S4-1: GUARDA DE PRESUPUESTO, ESTADO ATÓMICO E IDEMPOTENCIA");
  console.log("(0 llamadas reales al modelo — datos 100% simulados)");
  console.log("========================================================================\n");

  const dirTmpBase = await mkdtemp(path.join(os.tmpdir(), "secop-s4-1-test-"));

  try {
    // ========================================================================
    // PRUEBA 1: Validación obligatoria de banderas de presupuesto y modo precios null
    // ========================================================================
    console.log("▶ [Prueba 1] Validación de --presupuesto-usd y respaldo --presupuesto-tokens...");

    const cliOpts = parsearOpcionesPresupuesto([
      "--presupuesto-usd=4.50",
      "--presupuesto-tokens=250000",
    ]);
    assert.equal(cliOpts.presupuestoUSD, 4.5);
    assert.equal(cliOpts.presupuestoTokens, 250000);

    // Corrida larga sin ninguna bandera debe negarse a iniciar
    let rechazoSinBandera = false;
    try {
      await exigirPresupuestoParaEjecucionLarga({
        modo: "daemon",
        presupuestoUSD: null,
        presupuestoTokens: null,
      });
    } catch (err) {
      rechazoSinBandera = err instanceof ErrorConfiguracionPresupuesto;
    }
    assert.equal(
      rechazoSinBandera,
      true,
      "El modo daemon/carga debe negarse a iniciar sin --presupuesto-usd ni --presupuesto-tokens",
    );

    // Si los precios son null y solo se pasa --presupuesto-usd, debe negarse y pedir --presupuesto-tokens
    let rechazoPreciosNullSinTokens = false;
    try {
      await exigirPresupuestoParaEjecucionLarga({
        modo: "carga",
        presupuestoUSD: 5.0,
        presupuestoTokens: null,
        tarifasOverride: null,
      });
    } catch (err) {
      rechazoPreciosNullSinTokens = err instanceof ErrorConfiguracionPresupuesto;
    }
    assert.equal(
      rechazoPreciosNullSinTokens,
      true,
      "Cuando los precios son null, debe exigir --presupuesto-tokens como respaldo",
    );

    // Si los precios son null pero se pasa --presupuesto-tokens, debe permitir el inicio en modo tokens
    const validacionFallbackTokens = await exigirPresupuestoParaEjecucionLarga({
      modo: "carga",
      presupuestoUSD: null,
      presupuestoTokens: 100_000,
      tarifasOverride: null,
    });
    assert.equal(validacionFallbackTokens.preciosConfigurados, false);
    assert.equal(validacionFallbackTokens.modoControl, "tokens");

    console.log("  ✔ Corridas largas rechazan iniciar sin presupuesto y activan respaldo por tokens si precios=null.\n");

    // ========================================================================
    // PRUEBA 2: Guarda dura de presupuesto al límite, advertencia 80%, ítems en vuelo y salida código 0
    // ========================================================================
    console.log("▶ [Prueba 2] Guarda de presupuesto: estimación conservadora (A vs B), alerta 80%, parada al límite, ítems en vuelo y código 0...");

    const dirPruebaPresupuesto = path.join(dirTmpBase, "presupuesto");
    const gestorPresupuesto = new GestorEstadoCarga({ dirCarga: dirPruebaPresupuesto });
    await gestorPresupuesto.inicializar();

    // Verificar que la estimación conservadora toma el mayor entre A (incluye razonamiento) y B (solo salida visible)
    const tarifasPrueba = { porMillonEntrada: 2.0, porMillonSalida: 6.0 };
    const calculoMuestra = calcularUsoConservadorLlamada(
      {
        tokensEntrada: 2000, // $0.004
        tokensSalida: 1000, // visible: $0.006 -> Est B = $0.010
        tokensTotal: 4000, // no-entrada = 2000 ($0.012) -> Est A = $0.016
      },
      tarifasPrueba,
    );
    assert.equal(calculoMuestra.costoUSD_B, 0.01);
    assert.equal(calculoMuestra.costoUSD_A, 0.016);
    assert.equal(
      calculoMuestra.costoConservadorUSD,
      0.016,
      "Debe usar la estimación conservadora (el mayor entre A y B)",
    );

    // Configurar presupuesto de $0.050 USD con margen de seguridad de $0.005 USD por llamada
    // Cada llamada simulada al modelo consumirá exactamente $0.016 USD (Estimación A conservadora):
    // - Llamada 1: gastado = $0.016 (32%)
    // - Llamada 2: gastado = $0.032 (64%)
    // - Llamada 3: gastado = $0.048 (96% >= 80% -> emite advertencia 80%; y $0.048 + margen $0.005 = $0.053 >= $0.050 -> alcanza límite!)
    // - Llamada 4: bloqueada antes de invocar al modelo porque se alcanzó el límite.
    let codigoSalidaCapturado: number | null = null;
    let itemEnVueloCompletadoAntesDeSalir = false;
    let estadoItemEnVueloAlSalir = false;

    const guarda = new GuardaPresupuesto({
      presupuestoUSD: 0.05,
      margenSeguridadUSD: 0.005,
      gestorEstado: gestorPresupuesto,
      tarifasOverride: tarifasPrueba,
      silencioso: false,
      onExit: (codigo) => {
        codigoSalidaCapturado = codigo;
        estadoItemEnVueloAlSalir = itemEnVueloCompletadoAntesDeSalir;
      },
    });
    await guarda.inicializar();

    // Crear un modelo falso (mock) envuelto con envolverModeloConPresupuesto (0 llamadas de red)
    let invocacionesModeloFalso = 0;
    const modeloFalso = envolverModeloConPresupuesto({
      async invoke(_mensajes: unknown) {
        invocacionesModeloFalso += 1;
        return {
          content: `Respuesta simulada #${invocacionesModeloFalso}`,
          usage_metadata: {
            input_tokens: 2000,
            output_tokens: 1000,
            total_tokens: 4000,
          },
        };
      },
    });

    await ejecutarConGuardaPresupuesto(guarda, async () => {
      // Llamada 1 ($0.016 -> 32%)
      await modeloFalso.invoke("proceso-1");
      await gestorPresupuesto.marcar("CO1.PCCNTR.1001", "agente1", { aptoPyme: "si", ciclo: 1 });
      assert.equal(guarda.obtenerResumen().advertencia80Emitida, false);
      assert.equal(guarda.obtenerResumen().limiteAlcanzado, false);

      // Llamada 2 ($0.032 -> 64%)
      await modeloFalso.invoke("proceso-2");
      await gestorPresupuesto.marcar("CO1.PCCNTR.1002", "agente1", { aptoPyme: "no", ciclo: 1 });
      assert.equal(guarda.obtenerResumen().advertencia80Emitida, false);

      // Lanzar un ítem de trabajo en vuelo que tarda 60ms en terminar su post-procesamiento
      const promesaEnVuelo = guarda.ejecutarItemTrabajo("item-en-vuelo-3", async () => {
        await esperar(60);
        await gestorPresupuesto.marcar("CO1.PCCNTR.1003", "agente2", { ciclo: 1 });
        itemEnVueloCompletadoAntesDeSalir = true;
        return "ok-en-vuelo";
      });

      // Llamada 3 ($0.048 -> 96% del presupuesto de $0.05):
      // - Supera el 80% -> emite evento `presupuesto_advertencia_80`
      // - `gastado ($0.048) + margen ($0.005) = $0.053 >= $0.050` -> alcanza el límite,
      //   espera a `promesaEnVuelo`, escribe `estado.json` y ejecuta `onExit(0)`!
      await modeloFalso.invoke("proceso-3");
      await promesaEnVuelo;

      // Intentar lanzar una Llamada 4 o nuevo ítem después del límite: debe ser bloqueado sin invocar al modelo
      let llamada4Bloqueada = false;
      try {
        await modeloFalso.invoke("proceso-4-bloqueado");
      } catch (err) {
        llamada4Bloqueada = err instanceof ErrorPresupuestoAlcanzado;
      }
      assert.equal(llamada4Bloqueada, true, "La llamada 4 debe ser bloqueada por la guarda de presupuesto");
    });

    assert.equal(invocacionesModeloFalso, 3, "El modelo falso solo debió invocarse 3 veces (la 4ª fue bloqueada)");
    assert.equal(
      estadoItemEnVueloAlSalir,
      true,
      "El cierre ordenado esperó a que el ítem en vuelo terminara antes de invocar onExit(0)",
    );
    assert.equal(codigoSalidaCapturado, 0, "El código de salida al alcanzar el presupuesto debe ser 0");

    const eventosPresupuesto = await gestorPresupuesto.leerEventos();
    const tiposEventos = eventosPresupuesto.map((e) => e.tipo);
    assert.ok(
      tiposEventos.includes("presupuesto_advertencia_80"),
      "Debe haberse emitido el evento presupuesto_advertencia_80 en eventos.jsonl",
    );
    assert.ok(
      tiposEventos.includes("presupuesto_limite_alcanzado"),
      "Debe haberse emitido el evento presupuesto_limite_alcanzado en eventos.jsonl",
    );
    assert.ok(
      tiposEventos.includes("presupuesto_cierre_ordenado"),
      "Debe haberse emitido el evento presupuesto_cierre_ordenado en eventos.jsonl",
    );

    console.log(
      `  ✔ Presupuesto detenido en $${guarda.obtenerResumen().gastadoUSD.toFixed(4)} / $0.0500 USD ` +
        `(${invocacionesModeloFalso} llamadas, 4ª bloqueada).`,
    );
    console.log(
      `  ✔ Eventos registrados en eventos.jsonl: [${tiposEventos.join(", ")}] | Código de salida: ${codigoSalidaCapturado}.\n`,
    );

    // ========================================================================
    // PRUEBA 3: Escritura atómica sobrevive a una escritura interrumpida
    // ========================================================================
    console.log("▶ [Prueba 3] Escritura atómica de estado.json sobrevive a una escritura interrumpida...");

    const dirPruebaAtomica = path.join(dirTmpBase, "atomica");
    const gestorAtomico = new GestorEstadoCarga({ dirCarga: dirPruebaAtomica });
    await gestorAtomico.inicializar();

    // Guardar un estado válido conocido
    await gestorAtomico.marcar("PROC-ATOM-1", "agente1", {
      aptoPyme: "si",
      ciclo: 3,
      ejecucionId: "ejec-valida-01",
    });
    await gestorAtomico.marcar("PROC-ATOM-1", "agente3", {
      ciclo: 3,
      ejecucionId: "ejec-valida-01",
    });

    const rutaEstadoAtomico = gestorAtomico.obtenerRutas().estado;
    const jsonAntesDeInterrupcion = await readFile(rutaEstadoAtomico, "utf8");
    const objetoAntes = JSON.parse(jsonAntesDeInterrupcion);
    assert.equal(objetoAntes.ultimoCiclo, 3);
    assert.equal(objetoAntes.contadoresUnidades.evaluadosAgente1, 1);
    assert.equal(objetoAntes.contadoresUnidades.completadosAgentes2y3, 1);

    // Simular una escritura interrumpida a mitad de camino (escribe un .tmp truncado y falla antes del rename)
    let falloInterrupcionCapturado = false;
    try {
      await gestorAtomico.guardarAtomico({ simularInterrupcionAntesDeRename: true });
    } catch {
      falloInterrupcionCapturado = true;
    }
    assert.equal(falloInterrupcionCapturado, true, "Debe haberse simulado la interrupción antes del rename");

    // Verificar que quedó el archivo .tmp truncado en el directorio pero estado.json sigue 100% íntegro
    const archivosTrasFallo = await readdir(dirPruebaAtomica);
    const temporalesDejados = archivosTrasFallo.filter((f) => f.includes("estado.json.tmp."));
    assert.equal(
      temporalesDejados.length,
      1,
      "Debe existir el archivo temporal truncado producto de la escritura interrumpida",
    );

    const jsonDespuesDeInterrupcion = await readFile(rutaEstadoAtomico, "utf8");
    const objetoDespues = JSON.parse(jsonDespuesDeInterrupcion);
    assert.deepEqual(
      objetoDespues,
      objetoAntes,
      "El archivo estado.json debe permanecer exactamente igual y válido tras la escritura interrumpida",
    );

    // Al reiniciar (nueva instancia de GestorEstadoCarga), debe cargar el estado íntegro y limpiar el .tmp huérfano
    const gestorRecuperado = new GestorEstadoCarga({ dirCarga: dirPruebaAtomica });
    await gestorRecuperado.inicializar();

    const archivosTrasRecuperacion = await readdir(dirPruebaAtomica);
    const temporalesRestantes = archivosTrasRecuperacion.filter((f) =>
      f.includes("estado.json.tmp."),
    );
    assert.equal(
      temporalesRestantes.length,
      0,
      "Al inicializar tras un fallo, el gestor debe limpiar automáticamente los archivos .tmp huérfanos",
    );
    assert.equal(gestorRecuperado.esProcesado("PROC-ATOM-1", "agente1"), true);
    assert.equal(gestorRecuperado.esProcesado("PROC-ATOM-1", "agente3"), true);

    console.log(
      `  ✔ Escritura interrumpida dejó 1 archivo temporal truncado (${temporalesDejados[0]}), ` +
        `estado.json sobrevivió intacto y el reinicio limpió el temporal huérfano.\n`,
    );

    // ========================================================================
    // PRUEBA 4: Idempotencia tras reinicio simulado (`esProcesado` y `marcar`)
    // ========================================================================
    console.log("▶ [Prueba 4] Idempotencia tras reinicio simulado (esProcesado y marcar sin doble conteo)...");

    const dirPruebaIdem = path.join(dirTmpBase, "idempotencia");
    const gestorCorrida1 = new GestorEstadoCarga({ dirCarga: dirPruebaIdem });
    await gestorCorrida1.inicializar();

    // Corrida 1: Procesar P-101 ("si", completo hasta A3), P-102 ("no"), P-103 ("si", quedó en A1 antes del reinicio)
    assert.equal( await gestorCorrida1.marcar("P-101", "agente1", { aptoPyme: "si", ciclo: 1, ejecucionId: "run-1" }), true );
    assert.equal( await gestorCorrida1.marcar("P-101", "agente2", { ciclo: 1, ejecucionId: "run-1" }), true );
    assert.equal( await gestorCorrida1.marcar("P-101", "agente3", { ciclo: 1, ejecucionId: "run-1" }), true );
    assert.equal( await gestorCorrida1.marcar("P-101", "finalizado", { exito: true, ciclo: 1, ejecucionId: "run-1" }), true );

    assert.equal( await gestorCorrida1.marcar("P-102", "agente1", { aptoPyme: "no", ciclo: 1, ejecucionId: "run-1" }), true );
    assert.equal( await gestorCorrida1.marcar("P-102", "finalizado", { exito: true, ciclo: 1, ejecucionId: "run-1" }), true );

    assert.equal( await gestorCorrida1.marcar("P-103", "agente1", { aptoPyme: "si", ciclo: 1, ejecucionId: "run-1" }), true );

    const estadoFinCorrida1 = gestorCorrida1.obtenerEstado();
    assert.equal(estadoFinCorrida1.contadoresUnidades.evaluadosAgente1, 3);
    assert.equal(estadoFinCorrida1.contadoresUnidades.clasificadosSi, 2);
    assert.equal(estadoFinCorrida1.contadoresUnidades.completadosAgentes2y3, 1);
    assert.equal(estadoFinCorrida1.contadoresUnidades.oficialFinAFin, 2);

    // Simular reinicio creando una nueva instancia desde disco
    const gestorCorrida2 = new GestorEstadoCarga({ dirCarga: dirPruebaIdem });
    await gestorCorrida2.inicializar();

    // Verificar esProcesado tras el reinicio
    assert.equal(gestorCorrida2.esProcesado("P-101", "agente1"), true);
    assert.equal(gestorCorrida2.esProcesado("P-101", "agente3"), true);
    assert.equal(gestorCorrida2.esProcesado("P-102", "agente1"), true);
    assert.equal(gestorCorrida2.esProcesado("P-103", "agente1"), true);
    assert.equal(gestorCorrida2.esProcesado("P-103", "agente3"), false);
    assert.equal(gestorCorrida2.esProcesado("P-104", "agente1"), false);

    // Intentar volver a marcar procesos ya procesados: debe devolver false y NO incrementar contadores
    const remarcadoP101A1 = await gestorCorrida2.marcar("P-101", "agente1", { aptoPyme: "si", ciclo: 2, ejecucionId: "run-2" });
    const remarcadoP101A3 = await gestorCorrida2.marcar("P-101", "agente3", { ciclo: 2, ejecucionId: "run-2" });
    const remarcadoP102A1 = await gestorCorrida2.marcar("P-102", "agente1", { aptoPyme: "no", ciclo: 2, ejecucionId: "run-2" });
    const remarcadoP103A1 = await gestorCorrida2.marcar("P-103", "agente1", { aptoPyme: "si", ciclo: 2, ejecucionId: "run-2" });

    assert.equal(remarcadoP101A1, false);
    assert.equal(remarcadoP101A3, false);
    assert.equal(remarcadoP102A1, false);
    assert.equal(remarcadoP103A1, false);

    // Completar las etapas pendientes de P-103 y agregar un proceso nuevo P-104
    assert.equal(await gestorCorrida2.marcar("P-103", "agente2", { ciclo: 2, ejecucionId: "run-2" }), true);
    assert.equal(await gestorCorrida2.marcar("P-103", "agente3", { ciclo: 2, ejecucionId: "run-2" }), true);
    assert.equal(await gestorCorrida2.marcar("P-103", "finalizado", { exito: true, ciclo: 2, ejecucionId: "run-2" }), true);

    assert.equal(await gestorCorrida2.marcar("P-104", "agente1", { aptoPyme: "no", ciclo: 2, ejecucionId: "run-2" }), true);
    assert.equal(await gestorCorrida2.marcar("P-104", "finalizado", { exito: true, ciclo: 2, ejecucionId: "run-2" }), true);

    const estadoFinCorrida2 = gestorCorrida2.obtenerEstado();
    assert.equal(estadoFinCorrida2.unidadPorDefecto, UNIDAD_TRABAJO_POR_DEFECTO);
    assert.equal(
      estadoFinCorrida2.contadoresUnidades.evaluadosAgente1,
      4,
      "Deben contarse exactamente 4 procesos únicos en Agente 1 (sin duplicar P-101, P-102 ni P-103)",
    );
    assert.equal(
      estadoFinCorrida2.contadoresUnidades.clasificadosSi,
      2,
      "Deben contarse exactamente 2 procesos clasificados 'si' (P-101 y P-103)",
    );
    assert.equal(
      estadoFinCorrida2.contadoresUnidades.completadosAgentes2y3,
      2,
      "Deben contarse exactamente 2 procesos completados en Agentes 2 y 3 (P-101 y P-103)",
    );
    assert.equal(
      estadoFinCorrida2.contadoresUnidades.oficialFinAFin,
      4,
      "Deben contarse exactamente 4 procesos finalizados de principio a fin",
    );
    assert.deepEqual(estadoFinCorrida2.ejecucionesInvolucradas, ["run-1", "run-2"]);
    assert.equal(estadoFinCorrida2.ultimoCiclo, 2);

    console.log(
      `  ✔ Constante por defecto: UNIDAD_TRABAJO_POR_DEFECTO = "${UNIDAD_TRABAJO_POR_DEFECTO}" (${DESCRIPCIONES_UNIDADES_TRABAJO[UNIDAD_TRABAJO_POR_DEFECTO]})`,
    );
    console.log(
      `  ✔ Contadores paralelos tras reinicio e intentos duplicados: ` +
        `evaluadosAgente1=${estadoFinCorrida2.contadoresUnidades.evaluadosAgente1}, ` +
        `clasificadosSi=${estadoFinCorrida2.contadoresUnidades.clasificadosSi}, ` +
        `completadosAgentes2y3=${estadoFinCorrida2.contadoresUnidades.completadosAgentes2y3}, ` +
        `oficialFinAFin=${estadoFinCorrida2.contadoresUnidades.oficialFinAFin}.\n`,
    );

    // ========================================================================
    // PRUEBA 5: Estimador en modo precios=null proyecta únicamente tokens
    // ========================================================================
    console.log("▶ [Prueba 5] Estimador de carga cuando precios son null proyecta solo tokens...");
    const rutaPreciosNull = path.join(dirTmpBase, "precios-null.json");
    await writeFile(
      rutaPreciosNull,
      JSON.stringify({
        moneda: "USD",
        actualizado: null,
        fuente: "sin configurar",
        modelos: { "grok-4.6": { porMillonEntrada: null, porMillonSalida: null } },
      }),
      "utf8",
    );

    const estimacionSinPrecios = await ejecutarEstimacionCarga({
      unidades: 1000,
      margenPorcentaje: 25,
      rutaConfigPrecios: rutaPreciosNull,
      dirSalida: path.join(dirTmpBase, "estimacion-null"),
      silencioso: true,
    });

    assert.equal(estimacionSinPrecios.preciosConfigurados, false);
    for (const proy of estimacionSinPrecios.proyecciones) {
      assert.equal(proy.media.costoConservadorUSD, null);
      assert.equal(proy.media.presupuestoUSDConMargen, null);
      assert.equal(proy.media.banderaRecomendadaUSD, null);
      assert.ok(proy.media.tokensEstimados > 0);
      assert.ok(proy.media.banderaRecomendadaTokens.startsWith("--presupuesto-tokens="));
    }
    console.log("  ✔ Con precios=null, el estimador proyecta exclusivamente tokens y sugiere --presupuesto-tokens=<n>.\n");

    console.log("========================================================================");
    console.log("✅ TODAS LAS PRUEBAS DE S4-1 PASARON EXITOSAMENTE (0 llamadas al modelo)");
    console.log("========================================================================");
  } finally {
    await rm(dirTmpBase, { recursive: true, force: true });
  }
}

ejecutarPruebasS4_1().catch((err) => {
  console.error("❌ Fallo en pruebas S4-1:", err);
  process.exit(1);
});
