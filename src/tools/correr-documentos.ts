/**
 * CLI para ejecutar el pipeline de estructuración de listas de documentos habilitantes (Agente 3).
 *
 * Uso:
 *   pnpm exec tsx src/tools/correr-documentos.ts                    # Por defecto: 5 procesos
 *   pnpm exec tsx src/tools/correr-documentos.ts --max=10          # Hasta 10 procesos
 *   pnpm exec tsx src/tools/correr-documentos.ts --completo        # Todos los disponibles
 *   pnpm exec tsx src/tools/correr-documentos.ts --siempre-agente  # Invoca modelo incluso sin anexos
 */
import "../config/entorno.js";
import {
  armarDocumentosParaProcesos,
  type ProcesoConDocumentos,
} from "../pipeline/armar-documentos.js";
import { cerrarTrazas, iniciarTrazas } from "../trazas.js";

function parsearArgumentos(): { maxProcesos: number; completo: boolean; siempreAgente: boolean } {
  const args = process.argv.slice(2);
  let maxProcesos = 5; // Guarda de créditos por defecto: 5 procesos
  let completo = false;
  let siempreAgente = false;

  for (const arg of args) {
    if (arg === "--completo") {
      completo = true;
    } else if (arg === "--siempre-agente") {
      siempreAgente = true;
    } else if (arg.startsWith("--max=")) {
      const val = Number.parseInt(arg.slice(6), 10);
      if (!Number.isNaN(val) && val > 0) {
        maxProcesos = val;
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(`
Uso: pnpm exec tsx src/tools/correr-documentos.ts [opciones]

Opciones:
  --max=N             Número máximo de procesos a estructurar (por defecto: 5).
  --completo          Procesa todos los resúmenes disponibles de la fecha.
  --siempre-agente    Invoca al LLM incluso en procesos sin anexos indexados.
  -h, --help          Muestra esta ayuda.
      `);
      process.exit(0);
    }
  }

  return { maxProcesos, completo, siempreAgente };
}

function imprimirDetalleDocumentos(item: ProcesoConDocumentos, index: number, total: number): void {
  console.log(`\n================================================================================`);
  console.log(
    `[${index + 1}/${total}] DOCUMENTOS PARA PROCESO: ${item.id} (${item.procesoInfo.modalidad})`,
  );
  console.log(`================================================================================`);
  console.log(`Tipo contrato: ${item.procesoInfo.tipoDeContrato}`);
  console.log(`Aviso legal  : ℹ ${item.avisoOficial}`);
  if (item.observacionGeneral) {
    console.log(`Nota modelo  : 💬 ${item.observacionGeneral}`);
  }

  console.log(`\n--- LISTA ORIENTATIVA DE DOCUMENTOS (${item.items.length} ítems) ---`);
  for (const doc of item.items) {
    const badgeBase =
      doc.base === "catalogo_con_emisor"
        ? "[CATÁLOGO CON EMISOR]"
        : doc.base === "catalogo_sin_emisor"
          ? "[CATÁLOGO SIN EMISOR]"
          : "[ANEXO SECOP II]";

    const tagCatalogo = doc.catalogoId ? ` (ID catálogo: ${doc.catalogoId})` : "";
    console.log(`\n• ${badgeBase} ${doc.nombre}${tagCatalogo}`);
    console.log(`  Fundamento   : ${doc.fundamento}`);
    if (doc.condicion) {
      console.log(`  Condición    : ${doc.condicion}`);
    }
    if (doc.expide) {
      console.log(`  Expide       : ${doc.expide}`);
    }
    if (doc.observaciones) {
      console.log(`  Observación  : ${doc.observaciones}`);
    }
  }

  if (item.advertencias.length > 0) {
    console.log(`\n--- ADVERTENCIAS ---`);
    for (const adv of item.advertencias) {
      console.log(`  ⚠ ${adv}`);
    }
  }
}

async function main() {
  const { maxProcesos, completo, siempreAgente } = parsearArgumentos();

  try {
    const trazasActivas = await iniciarTrazas();
    console.log(
      `Trazas LangSmith : ${trazasActivas ? `activas (proyecto ${process.env.LANGSMITH_PROJECT})` : "inactivas"}`,
    );
    console.log(`Configuración    : ${completo ? "TODOS LOS RESÚMENES" : `Tope de ${maxProcesos} procesos`}`);
    console.log(`Modo LLM         : ${siempreAgente ? "Siempre agente (--siempre-agente)" : "Optimizado (LLM solo para procesos con anexos)"}`);

    const entrega = await armarDocumentosParaProcesos({
      maxProcesos,
      completo,
      siempreAgente,
    });

    console.log("\n========================================================");
    console.log("             RESUMEN DE DOCUMENTOS                      ");
    console.log("========================================================");
    console.log(`Fecha consultada     : ${entrega.fecha} (${entrega.modo})`);
    console.log(`Resúmenes disponibles: ${entrega.totalResumenesDisponibles}`);
    console.log(`Procesos con lista   : ${entrega.totalProcesados}`);
    console.log("\nTokens consumidos (según tokens_total acumulado):");
    console.log(`  Entrada : ${entrega.tokens.entrada.toLocaleString("es-CO")}`);
    console.log(`  Salida  : ${entrega.tokens.salida.toLocaleString("es-CO")}`);
    console.log(`  Total   : ${entrega.tokens.total.toLocaleString("es-CO")}`);

    for (let i = 0; i < entrega.documentosPorProceso.length; i++) {
      imprimirDetalleDocumentos(entrega.documentosPorProceso[i], i, entrega.documentosPorProceso.length);
    }

    console.log("\n========================================================");
    console.log(`Archivo de entrega generado en data/entregas/${entrega.fecha}/documentos.json`);
    console.log("========================================================\n");
  } catch (error) {
    console.error("\n[ERROR FATAL]:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await cerrarTrazas();
  }
}

await main();
