/**
 * CLI para ejecutar el pipeline de generación de resúmenes honestos para pymes (Agente 2).
 *
 * Uso:
 *   pnpm exec tsx src/tools/correr-resumidor.ts                    # Por defecto: 5 procesos aptos
 *   pnpm exec tsx src/tools/correr-resumidor.ts --max=10          # Hasta 10 procesos
 *   pnpm exec tsx src/tools/correr-resumidor.ts --incluir-dudosos # Incluye clasificados como dudosos
 *   pnpm exec tsx src/tools/correr-resumidor.ts --completo        # Todos los aptos disponibles
 */
import "../config/entorno.js";
import { resumirProcesosAptos, type ItemResumenEntrega } from "../pipeline/resumir-procesos.js";
import { cerrarTrazas, iniciarTrazas } from "../trazas.js";

const formatoCOP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function parsearArgumentos(): {
  maxProcesos: number;
  completo: boolean;
  incluirDudosos: boolean;
} {
  const args = process.argv.slice(2);
  let maxProcesos = 5; // Guarda de créditos por defecto: 5 procesos
  let completo = false;
  let incluirDudosos = false;

  for (const arg of args) {
    if (arg === "--completo") {
      completo = true;
    } else if (arg === "--incluir-dudosos") {
      incluirDudosos = true;
    } else if (arg.startsWith("--max=")) {
      const val = Number.parseInt(arg.slice(6), 10);
      if (!Number.isNaN(val) && val > 0) {
        maxProcesos = val;
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(`
Uso: pnpm exec tsx src/tools/correr-resumidor.ts [opciones]

Opciones:
  --max=N             Número máximo de procesos a resumir (por defecto: 5).
  --completo          Procesa todos los procesos aptos disponibles.
  --incluir-dudosos   Incluye también los clasificados como 'dudoso' por el filtrador.
  -h, --help          Muestra esta ayuda.
      `);
      process.exit(0);
    }
  }

  return { maxProcesos, completo, incluirDudosos };
}

function imprimirDetalleProceso(item: ItemResumenEntrega, index: number, total: number): void {
  const f = item.ficha;
  const valor = f.valorCOP !== null ? formatoCOP.format(f.valorCOP) : "Presupuesto no especificado";
  const dias =
    f.diasRestantes !== null
      ? `${f.diasRestantes} día(s)${f.vencido ? " (¡VENCIDO!)" : ""}`
      : "Plazo no definido";
  const lotesTexto = f.lotes !== null ? (f.lotes === 0 ? "Sin lotes (único)" : `${f.lotes} lotes`) : "N/D";
  const duracionTexto =
    f.duracion.cantidad !== null ? `${f.duracion.cantidad} ${f.duracion.unidad ?? ""}` : "No definida";

  console.log(`\n================================================================================`);
  console.log(`[${index + 1}/${total}] PROCESO: ${item.id} | Días restantes: ${dias} | ${valor}`);
  console.log(`================================================================================`);
  console.log(`Entidad     : ${f.entidad}${f.unidadContratante ? ` (${f.unidadContratante})` : ""}`);
  console.log(`Ubicación   : ${f.ciudad}, ${f.departamento}`);
  console.log(`Modalidad   : ${f.modalidad}`);
  console.log(`Duración    : ${duracionTexto} | Lotes: ${lotesTexto}`);
  console.log(`Cierre oferta: ${f.fechaLimiteOfertas ?? "No registrada"}`);
  if (f.anexos.lista.length > 0) {
    console.log(`Anexos indexados (${f.anexos.total} en total):`);
    for (const a of f.anexos.lista.slice(0, 5)) {
      console.log(`  • ${a.nombre} (${a.tamanoKB} KB) [${a.extension}]`);
    }
    if (f.anexos.total > 5) {
      console.log(`    ... y ${f.anexos.total - 5} archivo(s) más`);
    }
  } else {
    console.log(`Anexos      : ${f.anexos.estado}`);
  }

  console.log(`\n--- RESUMEN EJECUTIVO (Máx 100 palabras) ---`);
  console.log(item.resumen);

  console.log(`\n--- ALERTAS PARA LA PYME ---`);
  if (item.alertasParaPyme.length === 0) {
    console.log("  (Sin alertas específicas registradas)");
  } else {
    for (const a of item.alertasParaPyme) {
      console.log(`  ⚠ ${a.alerta} [Basado en: ${a.basadoEn}]`);
    }
  }

  console.log(`\n--- VERIFICAR EN EL PLIEGO OFICIAL ---`);
  for (const v of item.verificarEnElPliego) {
    console.log(`  ✓ ${v}`);
  }

  console.log(`\n--- COMENTARIO DE ANEXOS ---`);
  console.log(`  ℹ ${item.comentarioAnexos ?? "Sin comentarios"}`);

  if (item.advertencias.length > 0) {
    console.log(`\n--- GUARDAS DE CÓDIGO (ADVERTENCIAS) ---`);
    for (const adv of item.advertencias) {
      console.log(`  ⛔ ADVERTENCIA: ${adv}`);
    }
  }
}

async function main() {
  const { maxProcesos, completo, incluirDudosos } = parsearArgumentos();

  try {
    const trazasActivas = await iniciarTrazas();
    console.log(`Trazas LangSmith : ${trazasActivas ? `activas (proyecto ${process.env.LANGSMITH_PROJECT})` : "inactivas"}`);
    console.log(
      `Configuración    : ${completo ? "TODOS LOS APTOS" : `Tope de ${maxProcesos} procesos`} (incluir dudosos: ${incluirDudosos ? "SÍ" : "NO"})`,
    );

    const entrega = await resumirProcesosAptos({
      maxProcesos,
      completo,
      incluirDudosos,
    });

    console.log("\n========================================================");
    console.log("             RESUMEN DE PROCESAMIENTO                   ");
    console.log("========================================================");
    console.log(`Fecha consultada   : ${entrega.fecha} (${entrega.modo})`);
    console.log(`Aptos disponibles  : ${entrega.totalAptosEncontrados}`);
    console.log(`Procesos resumidos : ${entrega.totalProcesados}`);
    console.log("\nTokens consumidos:");
    console.log(`  Entrada : ${entrega.tokens.entrada.toLocaleString("es-CO")}`);
    console.log(`  Salida  : ${entrega.tokens.salida.toLocaleString("es-CO")}`);
    console.log(`  Total   : ${entrega.tokens.total.toLocaleString("es-CO")}`);

    for (let i = 0; i < entrega.resumenes.length; i++) {
      imprimirDetalleProceso(entrega.resumenes[i], i, entrega.resumenes.length);
    }

    console.log("\n========================================================");
    console.log(`Archivo de entrega generado en data/entregas/${entrega.fecha}/resumenes.json`);
    console.log("========================================================\n");
  } catch (error) {
    console.error("\n[ERROR FATAL]:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await cerrarTrazas();
  }
}

await main();
