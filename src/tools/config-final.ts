/**
 * Herramienta para cálculo y generación de la configuración final del daemon (S4-FINAL C.6).
 *
 * Ejecutable vía:
 *   pnpm config:final --saldo-usd=<n>
 *
 * Calcula el tope duro de tokens con reserva de seguridad del 10% sobre el saldo del panel,
 * valida que el tope sea al menos 10% superior al consumo esperado para 1.050 unidades,
 * y emite el bloque DAEMON_* oficial para la corrida de 12 horas.
 */
import "../config/entorno.js";
import { cargarTarifasModeloPresupuesto } from "../carga/presupuesto.js";
import { MODEL_NAME } from "../llm.js";

export interface CalculoConfigFinal {
  saldoUSD: number;
  reservaPorcentaje: number;
  saldoDisponibleUSD: number;
  precioPorMillonUSD: number;
  precioPorTokenUSD: number;
  topeTokensExacto: number;
  topeTokensRedondeado: number;
  costoTopeUSD: number;
  unidadesMeta: number;
  tokensEsperados: number;
  costoEsperadoUSD: number;
  multiploSobreEsperado: number;
  cumpleMargenMinimo: boolean;
  bloqueEnv: string;
}

export async function calcularConfigFinal(saldoUSD: number): Promise<CalculoConfigFinal> {
  const tarifas = await cargarTarifasModeloPresupuesto(MODEL_NAME);
  const precioPorMillonUSD = tarifas?.porMillonEntrada ?? 3.5070;
  const precioPorTokenUSD = precioPorMillonUSD / 1_000_000;

  // 1. Reserva del 10%
  const reservaPorcentaje = 10;
  const saldoDisponibleUSD = Number((saldoUSD * (1 - reservaPorcentaje / 100)).toFixed(4));

  // 2. Tope de tokens = floor((saldo - 10%) / precioPorToken), redondeado hacia abajo a 100.000
  const topeTokensExacto = Math.floor(saldoDisponibleUSD / precioPorTokenUSD);
  const topeTokensRedondeado = Math.floor(topeTokensExacto / 100_000) * 100_000;
  const costoTopeUSD = Number(((topeTokensRedondeado * precioPorMillonUSD) / 1_000_000).toFixed(4));

  // 3. Consumo esperado para 1.050 unidades (base empírica conservadora ~6.800 tokens/unidad con margen P90 ~7.674.239 tokens)
  const unidadesMeta = 1050;
  // Promedio ponderado de tokens por unidad (8% "si" a 16.500 tok + 92% "no" a 6.000 tok/página de 6 = 1.000 tok -> ~2.240 tok blend, conservador P90 con reintentos: 7.308 tok/unidad)
  const tokensEsperados = 7_674_239; // P90 con 25% de contingencia para 1.050 unidades
  const costoEsperadoUSD = Number(((tokensEsperados * precioPorMillonUSD) / 1_000_000).toFixed(2));

  const multiploSobreEsperado = Number((topeTokensRedondeado / tokensEsperados).toFixed(2));
  const cumpleMargenMinimo = topeTokensRedondeado >= Math.ceil(1.10 * tokensEsperados);

  const bloqueEnv = [
    `# ==============================================================================`,
    `# CONFIGURACION OFICIAL DAEMON (S4-FINAL - CORRIDA DE 12 HORAS)`,
    `# Saldo Panel: $${saldoUSD.toFixed(2)} USD | Reserva 10%: $${(saldoUSD * 0.1).toFixed(2)} USD | Presupuesto Disponible: $${saldoDisponibleUSD.toFixed(2)} USD`,
    `# Tarifa efectiva: $${precioPorMillonUSD.toFixed(4)} USD / 1M tokens | Tope: ${topeTokensRedondeado.toLocaleString("es-CO")} tokens ($${costoTopeUSD.toFixed(2)} USD)`,
    `# ==============================================================================`,
    `DAEMON_FUENTE=historico`,
    `DAEMON_UNIDADES=1050`,
    `DAEMON_HORAS=12.5`,
    `DAEMON_HORAS_MINIMAS=12.2`,
    `DAEMON_LOTE=6`,
    `DAEMON_CONCURRENCIA=3`,
    `DAEMON_PRESUPUESTO_TOKENS=${topeTokensRedondeado}`,
    `DAEMON_DRY_RUN=false`,
  ].join("\n");

  return {
    saldoUSD,
    reservaPorcentaje,
    saldoDisponibleUSD,
    precioPorMillonUSD,
    precioPorTokenUSD,
    topeTokensExacto,
    topeTokensRedondeado,
    costoTopeUSD,
    unidadesMeta,
    tokensEsperados,
    costoEsperadoUSD,
    multiploSobreEsperado,
    cumpleMargenMinimo,
    bloqueEnv,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let saldoUSD = 67.0;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--saldo-usd=")) {
      const v = Number.parseFloat(a.slice("--saldo-usd=".length).trim());
      if (Number.isFinite(v) && v > 0) saldoUSD = v;
    } else if (a === "--saldo-usd" && args[i + 1]) {
      const v = Number.parseFloat(args[++i]!.trim());
      if (Number.isFinite(v) && v > 0) saldoUSD = v;
    } else if (a === "--help" || a === "-h") {
      console.log(`
Uso: pnpm config:final --saldo-usd=<n>

Calcula el tope de tokens y genera el bloque de configuración DAEMON_* para la corrida real de 12h.

Opciones:
  --saldo-usd=<n>   Saldo actual en el panel en USD (por defecto: 67)
  --help, -h        Muestra esta ayuda
`);
      process.exit(0);
    }
  }

  const res = await calcularConfigFinal(saldoUSD);

  console.log("================================================================================");
  console.log("💰 PLANIFICADOR DE PRESUPUESTO Y CONFIGURACIÓN FINAL (S4-FINAL C.6)");
  console.log("================================================================================\n");

  console.log("📐 FÓRMULAS APLICADAS:");
  console.log(`   1. Saldo disponible  = Saldo ($${res.saldoUSD.toFixed(2)}) × (1 - 0.10) = $${res.saldoDisponibleUSD.toFixed(2)} USD (reserva 10%)`);
  console.log(`   2. Tarifa efectiva   = $${res.precioPorMillonUSD.toFixed(4)} USD / 1.000.000 tokens ($${res.precioPorTokenUSD.toFixed(8)} USD/token)`);
  console.log(`   3. Tope exacto       = floor($${res.saldoDisponibleUSD.toFixed(2)} / $${res.precioPorTokenUSD.toFixed(8)}) = ${res.topeTokensExacto.toLocaleString("es-CO")} tokens`);
  console.log(`   4. Tope redondeado   = floor(${res.topeTokensExacto.toLocaleString("es-CO")} / 100.000) × 100.000 = ${res.topeTokensRedondeado.toLocaleString("es-CO")} tokens ($${res.costoTopeUSD.toFixed(2)} USD)`);
  console.log(`   5. Consumo esperado  = ${res.tokensEsperados.toLocaleString("es-CO")} tokens para ${res.unidadesMeta} unidades (~$${res.costoEsperadoUSD.toFixed(2)} USD)\n`);

  console.log("🛡️ VERIFICACIÓN DE HOLGURA DE PRESUPUESTO:");
  console.log(`   • Tope configurado:       ${res.topeTokensRedondeado.toLocaleString("es-CO")} tokens ($${res.costoTopeUSD.toFixed(2)} USD)`);
  console.log(`   • Necesidad esperada:     ${res.tokensEsperados.toLocaleString("es-CO")} tokens ($${res.costoEsperadoUSD.toFixed(2)} USD)`);
  console.log(`   • Mínimo requerido (+10%): ${Math.ceil(1.10 * res.tokensEsperados).toLocaleString("es-CO")} tokens`);
  console.log(`   • Cobertura del tope:     ${res.multiploSobreEsperado}x (${(res.multiploSobreEsperado * 100).toFixed(0)}% de la necesidad)`);
  console.log(`   • Dictamen de holgura:    ${res.cumpleMargenMinimo ? "✅ CUMPLE (Tope >= 1.10 × Necesidad esperada)" : "❌ NO CUMPLE (Saldo insuficiente)"}\n`);

  console.log("================================================================================");
  console.log("📋 BLOQUE DE VARIABLES DE ENTORNO PARA .env / .env.carga:");
  console.log("================================================================================");
  console.log(res.bloqueEnv);
  console.log("================================================================================\n");
}

import { fileURLToPath } from "node:url";
import path from "node:path";

const esModuloPrincipal =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esModuloPrincipal) {
  main().catch((err) => {
    console.error("❌ Error en config:final:", err);
    process.exit(1);
  });
}

