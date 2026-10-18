/**
 * Herramienta de consolidación y métricas de tokens (src/tools/resumen-tokens.ts).
 *
 * Lee logs/tokens.jsonl y genera:
 * 1. Totales acumulados por Agente (filtrador, resumidor, documentos...).
 * 2. Totales acumulados por Día.
 * 3. Promedio de tokens facturados por proceso procesado.
 *
 * Uso:
 *   pnpm exec tsx src/tools/resumen-tokens.ts
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { leerRegistrosTokens, type RegistroTokens } from "../cost.js";
import type { EntregaDocumentos } from "../pipeline/armar-documentos.js";

interface MetricasAgente {
  llamadas: number;
  entrada: number;
  salida: number;
  total: number;
}

interface MetricasDia {
  llamadas: number;
  entrada: number;
  salida: number;
  total: number;
}

async function contarProcesosProcesados(): Promise<number> {
  const dirEntregas = path.resolve(process.cwd(), "data", "entregas");
  let totalProcesados = 0;
  const idsVistos = new Set<string>();

  try {
    const subcarpetas = await readdir(dirEntregas);
    for (const sub of subcarpetas) {
      const rutaDoc = path.join(dirEntregas, sub, "documentos.json");
      try {
        const raw = await readFile(rutaDoc, "utf8");
        const entrega: EntregaDocumentos = JSON.parse(raw);
        for (const item of entrega.documentosPorProceso ?? []) {
          idsVistos.add(item.id);
        }
      } catch {
        // Puede no tener documentos.json aún
      }
    }
    totalProcesados = idsVistos.size;
  } catch {
    totalProcesados = 0;
  }

  return totalProcesados;
}

function formatearNumero(n: number): string {
  return n.toLocaleString("es-CO");
}

async function main(): Promise<void> {
  const registros = await leerRegistrosTokens();

  console.log("================================================================================");
  console.log(`📊 REPORTE CONSOLIDADO DE CONSUMO DE TOKENS`);
  console.log(`📄 Registros analizados en logs/tokens.jsonl: ${registros.length}`);
  console.log("================================================================================\n");

  if (registros.length === 0) {
    console.log("No se encontraron registros de tokens en logs/tokens.jsonl.");
    return;
  }

  // 1. Agrupación por Agente / Tarea
  const porAgente = new Map<string, MetricasAgente>();
  for (const r of registros) {
    const clave = r.tarea || "desconocido";
    const actual = porAgente.get(clave) ?? { llamadas: 0, entrada: 0, salida: 0, total: 0 };
    actual.llamadas++;
    actual.entrada += r.tokens_entrada || 0;
    actual.salida += r.tokens_salida || 0;
    actual.total += r.tokens_total || 0;
    porAgente.set(clave, actual);
  }

  console.log("--- 1. CONSUMO POR AGENTE / TAREA ---");
  console.log(
    "| Agente / Tarea".padEnd(25) +
      "| Llamadas".padStart(10) +
      "| Entrada".padStart(14) +
      "| Salida".padStart(14) +
      "| Total Facturado".padStart(18) +
      " |",
  );
  console.log("|" + "-".repeat(24) + "|" + "-".repeat(10) + "|" + "-".repeat(14) + "|" + "-".repeat(14) + "|" + "-".repeat(18) + "|");

  let sumaLlamadas = 0;
  let sumaEntrada = 0;
  let sumaSalida = 0;
  let sumaTotal = 0;

  for (const [agente, m] of porAgente.entries()) {
    sumaLlamadas += m.llamadas;
    sumaEntrada += m.entrada;
    sumaSalida += m.salida;
    sumaTotal += m.total;
    console.log(
      `| ${agente.padEnd(23)} | ${formatearNumero(m.llamadas).padStart(8)} | ${formatearNumero(m.entrada).padStart(12)} | ${formatearNumero(m.salida).padStart(12)} | ${formatearNumero(m.total).padStart(16)} |`,
    );
  }

  console.log("|" + "-".repeat(24) + "|" + "-".repeat(10) + "|" + "-".repeat(14) + "|" + "-".repeat(14) + "|" + "-".repeat(18) + "|");
  console.log(
    `| ${"TOTALES GLOBALES".padEnd(23)} | ${formatearNumero(sumaLlamadas).padStart(8)} | ${formatearNumero(sumaEntrada).padStart(12)} | ${formatearNumero(sumaSalida).padStart(12)} | ${formatearNumero(sumaTotal).padStart(16)} |`,
  );
  console.log("");

  // 2. Agrupación por Día
  const porDia = new Map<string, MetricasDia>();
  for (const r of registros) {
    const dia = r.fecha ? r.fecha.slice(0, 10) : "desconocido";
    const actual = porDia.get(dia) ?? { llamadas: 0, entrada: 0, salida: 0, total: 0 };
    actual.llamadas++;
    actual.entrada += r.tokens_entrada || 0;
    actual.salida += r.tokens_salida || 0;
    actual.total += r.tokens_total || 0;
    porDia.set(dia, actual);
  }

  console.log("--- 2. CONSUMO POR DÍA ---");
  console.log(
    "| Fecha (YYYY-MM-DD)".padEnd(22) +
      "| Llamadas".padStart(10) +
      "| Entrada".padStart(14) +
      "| Salida".padStart(14) +
      "| Total Facturado".padStart(18) +
      " |",
  );
  console.log("|" + "-".repeat(21) + "|" + "-".repeat(10) + "|" + "-".repeat(14) + "|" + "-".repeat(14) + "|" + "-".repeat(18) + "|");

  const diasOrdenados = Array.from(porDia.keys()).sort();
  for (const dia of diasOrdenados) {
    const m = porDia.get(dia)!;
    console.log(
      `| ${dia.padEnd(20)} | ${formatearNumero(m.llamadas).padStart(8)} | ${formatearNumero(m.entrada).padStart(12)} | ${formatearNumero(m.salida).padStart(12)} | ${formatearNumero(m.total).padStart(16)} |`,
    );
  }
  console.log("");

  // 3. Promedio por proceso procesado
  const totalProcesosUnicos = await contarProcesosProcesados();
  console.log("--- 3. PROMEDIOS DE CONSUMO ---");
  console.log(`• Procesos únicos estructurados (con ficha y documentos): ${totalProcesosUnicos}`);

  if (totalProcesosUnicos > 0) {
    // Tokens de etapas profundas (resumidor + documentos)
    const tokensResumidor = porAgente.get("agente_resumidor")?.total ?? 0;
    const tokensDocumentos = porAgente.get("agente_documentos")?.total ?? 0;
    const tokensEtapasProfundas = tokensResumidor + tokensDocumentos;

    const promedioPorProceso = Math.round(tokensEtapasProfundas / totalProcesosUnicos);
    const promedioGlobalPorProceso = Math.round(sumaTotal / totalProcesosUnicos);

    console.log(
      `• Promedio tokens por proceso (Agente 2 + Agente 3): **${formatearNumero(promedioPorProceso)} tokens/proceso**`,
    );
    console.log(
      `• Promedio global por proceso (incluye filtrado Agente 1): **${formatearNumero(promedioGlobalPorProceso)} tokens/proceso**`,
    );
  } else {
    console.log("• No se registraron procesos en data/entregas/ para calcular el promedio.");
  }

  console.log(
    `\n💡 Nota: Los tokens facturados incluyen tokens de razonamiento interno ('output_token_details.reasoning'). ` +
      `Multiplique estas cantidades por las tarifas oficiales de su dashboard de Grok (xAI).\n`,
  );
}

main().catch((err) => {
  console.error("Error al generar resumen de tokens:", err);
  process.exit(1);
});
