/**
 * CLI para ejecutar el pipeline de filtrado de oportunidades para pymes (Agente 1).
 *
 * Uso:
 *   pnpm exec tsx src/tools/correr-filtrador.ts              # Por defecto: 25 procesos (1 página)
 *   pnpm exec tsx src/tools/correr-filtrador.ts --max=50    # Hasta 50 procesos (2 páginas)
 *   pnpm exec tsx src/tools/correr-filtrador.ts --completo  # Todos los procesos del día
 */
import "../config/entorno.js";
import { filtrarPymes, type ResultadoProcesoApto } from "../pipeline/filtrar-pymes.js";
import { cerrarTrazas, iniciarTrazas } from "../trazas.js";
import { TAMANO_PAGINA_FILTRO } from "../herramientas/filtro-basico.js";

const formatoCOP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function parsearArgumentos(): { maxPaginas: number; maxProcesos: number; completo: boolean } {
  const args = process.argv.slice(2);
  let maxProcesos = TAMANO_PAGINA_FILTRO; // Default: 25 (1 página)
  let completo = false;

  for (const arg of args) {
    if (arg === "--completo") {
      completo = true;
    } else if (arg.startsWith("--max=")) {
      const val = Number.parseInt(arg.slice(6), 10);
      if (!Number.isNaN(val) && val > 0) {
        maxProcesos = val;
      }
    } else if (arg === "-h" || arg === "--help") {
      console.log(`
Uso: pnpm exec tsx src/tools/correr-filtrador.ts [opciones]

Opciones:
  --max=N       Número máximo de candidatos a procesar (por defecto: 25, equivale a 1 página).
  --completo    Procesa todas las páginas disponibles del día (sin límite).
  -h, --help    Muestra esta ayuda.
      `);
      process.exit(0);
    }
  }

  const maxPaginas = completo ? Number.POSITIVE_INFINITY : Math.ceil(maxProcesos / TAMANO_PAGINA_FILTRO);
  return { maxPaginas, maxProcesos, completo };
}

function imprimirMuestras(titulo: string, lista: ResultadoProcesoApto[], cantidad = 5): void {
  console.log(`\n=== Muestra de ${Math.min(cantidad, lista.length)} procesos "${titulo}" ===`);
  if (lista.length === 0) {
    console.log("  (Ninguno en esta categoría)");
    return;
  }

  for (const item of lista.slice(0, cantidad)) {
    const valor =
      item.proceso?.valor !== undefined && item.proceso?.valor !== null
        ? formatoCOP.format(item.proceso.valor)
        : "Valor no especificado";
    const entidad = item.proceso?.entidad ?? "Entidad no disponible";
    const modalidad = item.proceso?.modalidad ?? "";
    const objeto = item.proceso?.nombre ?? "";

    console.log(`- [${item.id}] [${item.aptoPyme.toUpperCase()}] ${item.categoriaObjeto} | ${valor} | ${modalidad}`);
    console.log(`  Entidad : ${entidad}`);
    console.log(`  Objeto  : ${objeto.slice(0, 110)}`);
    console.log(`  Razón   : ${item.razon}`);
    if (item.senales && item.senales.length > 0) {
      console.log(`  Señales : ${item.senales.join(" • ")}`);
    }
  }
}

async function main() {
  const { maxPaginas, maxProcesos, completo } = parsearArgumentos();

  try {
    const trazasActivas = await iniciarTrazas();
    console.log(`Trazas LangSmith : ${trazasActivas ? `activas (proyecto ${process.env.LANGSMITH_PROJECT})` : "inactivas"}`);
    console.log(`Configuración    : ${completo ? "DÍA COMPLETO" : `Tope de ${maxProcesos} procesos (${maxPaginas} página/s)`}`);

    const resumen = await filtrarPymes({ maxPaginas });

    console.log("\n========================================================");
    console.log("             RESUMEN DE CLASIFICACIÓN                  ");
    console.log("========================================================");
    console.log(`Fecha consultada   : ${resumen.fecha} (${resumen.modo})`);
    console.log(`Páginas procesadas : ${resumen.paginasProcesadas} de ${resumen.totalPaginasDisponibles}`);
    console.log(`Total candidatos   : ${resumen.resultados.length} evaluados de ${resumen.totalCandidatos}`);
    console.log("\nConteo por decisión:");
    console.log(`  [SI]     : ${String(resumen.estadisticasClasificacion.si).padStart(4)}`);
    console.log(`  [NO]     : ${String(resumen.estadisticasClasificacion.no).padStart(4)}`);
    console.log(`  [DUDOSO] : ${String(resumen.estadisticasClasificacion.dudoso).padStart(4)}`);
    console.log(`  TOTAL    : ${String(resumen.estadisticasClasificacion.total).padStart(4)}`);

    console.log("\nTokens consumidos:");
    console.log(`  Entrada : ${resumen.tokens.entrada.toLocaleString("es-CO")}`);
    console.log(`  Salida  : ${resumen.tokens.salida.toLocaleString("es-CO")}`);
    console.log(`  Total   : ${resumen.tokens.total.toLocaleString("es-CO")}`);

    const aptosSi = resumen.resultados.filter((r) => r.aptoPyme === "si");
    const aptosNo = resumen.resultados.filter((r) => r.aptoPyme === "no");
    const aptosDudosos = resumen.resultados.filter((r) => r.aptoPyme === "dudoso");

    imprimirMuestras("SI (Apto Pyme)", aptosSi, 5);
    imprimirMuestras("NO (No Apto Pyme)", aptosNo, 5);
    if (aptosDudosos.length > 0) {
      imprimirMuestras("DUDOSO", aptosDudosos, 3);
    }

    console.log("\n========================================================");
    console.log(`Archivo de entrega generado en data/entregas/${resumen.fecha}/aptos.json`);
    console.log("========================================================\n");
  } catch (error) {
    console.error("\n[ERROR FATAL]:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await cerrarTrazas();
  }
}

await main();
