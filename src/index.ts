/**
 * CLI Principal: Rastreador diario de oportunidades de contratación pública en SECOP II.
 *
 * Uso:
 *   pnpm exec tsx src/index.ts [--max=N] [--max-aptos=N] [--incluir-dudosos] [--completo] [--reanudar] [--siempre-agente]
 *
 * Banderas:
 *   --max=N           Límite de candidatos pre-filtrados enviados al Agente 1 (por defecto 25 = 1 página).
 *   --max-aptos=N     Límite de procesos aptos enviados a los Agentes 2 y 3 (por defecto 5).
 *   --incluir-dudosos Incluye procesos clasificados como "dudoso" para los Agentes 2 y 3.
 *   --completo        Elimina ambos topes (procesa todos los candidatos y todos los aptos de la jornada).
 *   --reanudar        Reutiliza entregas existentes en data/entregas/<fecha>/ para no gastar créditos.
 *   --siempre-agente  Fuerza llamada al modelo en Agente 3 incluso para procesos sin anexos indexados.
 */
import "./config/entorno.js";
import { leerFechaPrueba } from "./config/entorno.js";
import { fechaHoy } from "./datos/socrata.js";
import { obtenerInstanteReferencia } from "./filtro/prefiltro.js";
import { graph } from "./graph/graph.js";
import type { CapsEjecucion, EstadoGrafo } from "./graph/state.js";
import { cerrarTrazas, configEjecucion, iniciarTrazas } from "./trazas.js";

function parsearArgumentos(): CapsEjecucion {
  const args = process.argv.slice(2);
  let max = 25;
  let maxAptos = 5;
  let incluirDudosos = false;
  let completo = false;
  let reanudar = false;
  let siempreAgente = false;

  for (const arg of args) {
    if (arg.startsWith("--max=")) {
      const val = Number.parseInt(arg.slice(6), 10);
      if (!Number.isNaN(val) && val > 0) max = val;
    } else if (arg.startsWith("--max-aptos=")) {
      const val = Number.parseInt(arg.slice(12), 10);
      if (!Number.isNaN(val) && val > 0) maxAptos = val;
    } else if (arg === "--incluir-dudosos") {
      incluirDudosos = true;
    } else if (arg === "--completo") {
      completo = true;
    } else if (arg === "--reanudar") {
      reanudar = true;
    } else if (arg === "--siempre-agente") {
      siempreAgente = true;
    }
  }

  return {
    max,
    maxAptos,
    incluirDudosos,
    completo,
    reanudar,
    siempreAgente,
  };
}

async function main(): Promise<void> {
  const caps = parsearArgumentos();
  const fechaPrueba = leerFechaPrueba();
  const fecha = fechaPrueba ?? fechaHoy();
  const modo: "hoy" | "prueba" = fechaPrueba ? "prueba" : "hoy";
  const fechaReferencia = obtenerInstanteReferencia().toISOString();

  console.log("================================================================================");
  console.log(`🤖 SECOP II — Rastreador Multi-Agente de Oportunidades para Pymes`);
  console.log(`📅 Fecha objetivo: ${fecha} | Modo: ${modo.toUpperCase()}`);
  console.log(`⏱️ Instante de referencia: ${fechaReferencia}`);
  console.log(
    `⚙️ Configuración: maxCandidatos=${caps.completo ? "TODOS" : caps.max} | ` +
      `maxAptos=${caps.completo ? "TODOS" : caps.maxAptos} | ` +
      `incluirDudosos=${caps.incluirDudosos} | reanudar=${caps.reanudar ?? false}`,
  );
  console.log("================================================================================\n");

  // Validación de LangSmith (emite una sola advertencia si falta clave o es inválida)
  await iniciarTrazas();

  // Configuración de ejecución del grafo completo
  const config = configEjecucion({
    runName: "secop-diario",
    tags: ["secop", "diario"],
    metadata: {
      fecha,
      modo,
      fechaReferencia,
      caps: {
        max: caps.max,
        maxAptos: caps.maxAptos,
        incluirDudosos: caps.incluirDudosos,
        completo: caps.completo,
        reanudar: caps.reanudar ?? false,
      },
    },
  });

  const estadoInicial: EstadoGrafo = {
    fecha,
    modo,
    fechaReferencia,
    caps,
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

  try {
    const estadoFinal = (await graph.invoke(estadoInicial, config)) as EstadoGrafo;

    console.log("\n================================================================================");
    console.log(`✅ EJECUCIÓN COMPLETADA EXITOSAMENTE`);
    console.log("================================================================================");
    console.log(`📊 Total publicados descargados:    ${estadoFinal.totalDescargados}`);
    console.log(`🔍 Total candidatos pre-filtrados:  ${estadoFinal.totalCandidatos}`);
    console.log(
      `🏷️ Clasificación Agente 1:          ` +
        `SÍ: ${estadoFinal.conteoClasificacion.si} | ` +
        `DUDOSO: ${estadoFinal.conteoClasificacion.dudoso} | ` +
        `NO: ${estadoFinal.conteoClasificacion.no}`,
    );
    console.log(`📄 Resúmenes elaborados (Agente 2): ${estadoFinal.resumenes.length}`);
    console.log(`📋 Documentos armados (Agente 3):   ${estadoFinal.documentos.length}`);
    console.log(
      `🪙 Tokens facturados en la jornada:  ${estadoFinal.tokensTotales.total.toLocaleString("es-CO")} ` +
        `(Entrada: ${estadoFinal.tokensTotales.entrada.toLocaleString("es-CO")}, Salida: ${estadoFinal.tokensTotales.salida.toLocaleString("es-CO")})`,
    );

    if (estadoFinal.errores.length > 0) {
      console.warn(`\n⚠️ Errores aislados durante la ejecución (${estadoFinal.errores.length}):`);
      for (const err of estadoFinal.errores) {
        console.warn(`  - ${err}`);
      }
    }

    if (estadoFinal.reporteRutas) {
      console.log(`\n📑 Reportes generados:`);
      console.log(`  - JSON:     ${estadoFinal.reporteRutas.rutaJson}`);
      console.log(`  - Markdown: ${estadoFinal.reporteRutas.rutaMd}`);
    }
    console.log("================================================================================\n");
  } catch (err) {
    console.error("\n❌ Error crítico durante la ejecución del grafo:", err);
    process.exitCode = 1;
  } finally {
    // Espera el envío de todas las trazas pendientes antes de terminar
    await cerrarTrazas();
  }
}

main().catch((err) => {
  console.error("Fallo inesperado en main:", err);
  process.exit(1);
});
