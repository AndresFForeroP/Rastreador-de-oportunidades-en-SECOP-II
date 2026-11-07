/**
 * Verificación con 1 llamada real al modelo (Part 0d):
 * Verifica que cada llamada al modelo se contabilice exactamente una vez y que
 * el consumo de tokens en la guarda de presupuesto sea idéntico al del módulo de costos.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { llm, MODEL_NAME } from "../llm.js";
import { leerRegistrosTokens, registrarCosto } from "../cost.js";
import {
  ejecutarConGuardaPresupuesto,
  GuardaPresupuesto,
} from "../carga/presupuesto.js";
import { GestorEstadoCarga } from "../carga/estado.js";
import { AIMessage } from "@langchain/core/messages";

async function main(): Promise<void> {
  console.log("========================================================================");
  console.log("VERIFICACIÓN PART 0d: 1 LLAMADA REAL AL MODELO (GUARDA VS MÓDULO DE COSTOS)");
  console.log("========================================================================\n");

  const dirTmp = await mkdtemp(path.join(os.tmpdir(), "secop-guard-cost-verify-"));

  try {
    const gestorEstado = new GestorEstadoCarga({ dirCarga: dirTmp });
    await gestorEstado.inicializar();

    // Presupuesto seguro en tokens para 1 llamada mínima
    const guarda = new GuardaPresupuesto({
      presupuestoTokens: 10_000,
      gestorEstado,
      silencioso: false,
    });
    await guarda.inicializar({ exigirParaCorridaLarga: false });

    const totalRegistrosAntes = (await leerRegistrosTokens()).length;

    console.log("▶ Ejecutando 1 llamada real mínima al gateway oficial...");
    const prompt = "Responde únicamente la palabra 'LISTO' sin puntuación ni texto adicional.";

    let res: AIMessage | undefined;
    await ejecutarConGuardaPresupuesto(guarda, async () => {
      res = (await llm.invoke(prompt)) as AIMessage;
    });

    assert.ok(res, "Debe recibirse respuesta del modelo");
    console.log(`  Respuesta recibida: "${String(res.content).trim()}"`);

    // Registrar en el módulo de costos igual que hace el pipeline
    const registroCosto = await registrarCosto("verificacion-guard-cost", MODEL_NAME, res);
    const todosTokensDespues = await leerRegistrosTokens();
    assert.equal(
      todosTokensDespues.length,
      totalRegistrosAntes + 1,
      "El módulo de costos debe registrar exactamente 1 línea",
    );

    const resumenGuarda = guarda.obtenerResumen();

    console.log("\n--- RESULTADOS DE CONTABILIDAD ---");
    console.log(`• Llamadas registradas por la Guarda de Presupuesto: ${resumenGuarda.llamadasContabilizadas}`);
    console.log(`• Llamadas registradas por el Módulo de Costos:      1`);
    console.log(`• Tokens totales en Guarda de Presupuesto:          ${resumenGuarda.gastadoTokens} tokens`);
    console.log(`• Tokens totales en Módulo de Costos:              ${registroCosto.tokens_total} tokens`);
    console.log(`  (Desglose real: entrada=${registroCosto.tokens_entrada}, salida=${registroCosto.tokens_salida}, razonamiento=${registroCosto.detalles_salida?.razonamiento ?? 0})`);

    assert.equal(
      resumenGuarda.llamadasContabilizadas,
      1,
      "La guarda debe haber contabilizado exactamente 1 llamada (sin duplicados)",
    );
    assert.equal(
      resumenGuarda.gastadoTokens,
      registroCosto.tokens_total,
      "Los tokens en la guarda deben coincidir exactamente con los tokens_total del módulo de costos",
    );

    console.log("\n========================================================================");
    console.log("✅ VERIFICACIÓN EXITOSA: EXACTAMENTE 1 LLAMADA Y TOKENS COINCIDEN 100%");
    console.log("========================================================================");
  } finally {
    await rm(dirTmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ Fallo en verificación:", err);
  process.exit(1);
});

