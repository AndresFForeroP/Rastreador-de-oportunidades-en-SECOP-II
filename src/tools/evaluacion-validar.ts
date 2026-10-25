/**
 * Herramienta CLI: Validación del dataset de evaluación humana (S3-3).
 *
 * Verifica que todos los casos hayan sido etiquetados en {si, no, dudoso},
 * computa conteos por etiqueta y por bloque, y verifica guardas estadísticas mínimas
 * para asegurar que las métricas posteriores de precisión/recall sean confiables.
 *
 * Uso:
 *   pnpm exec tsx src/tools/evaluacion-validar.ts
 */
import { readFile } from "node:fs/promises";
import {
  rutaCasosSinEtiquetar,
  rutaClavesPrivadas,
} from "../pruebas/rutas.js";
import type { CasoSinEtiquetar, ClavePrivadaCaso } from "./evaluacion-preparar.js";

const ETIQUETAS_VALIDAS = new Set(["si", "no", "dudoso"]);

export async function validarEvaluacion(): Promise<void> {
  const rutaCasos = rutaCasosSinEtiquetar();
  const rutaClaves = rutaClavesPrivadas();

  console.log("================================================================================");
  console.log("🔍 VALIDACIÓN DEL SET DE EVALUACIÓN HUMANA (S3-3)");
  console.log("================================================================================\n");

  let casos: CasoSinEtiquetar[];
  let claves: Record<string, ClavePrivadaCaso>;

  try {
    const rawCasos = await readFile(rutaCasos, "utf8");
    casos = JSON.parse(rawCasos) as CasoSinEtiquetar[];
  } catch (err) {
    console.error(`❌ Error al leer ${rutaCasos}:`, err instanceof Error ? err.message : String(err));
    console.error("Asegúrate de haber ejecutado 'pnpm evaluar:preparar' primero.");
    process.exit(1);
  }

  try {
    const rawClaves = await readFile(rutaClaves, "utf8");
    claves = JSON.parse(rawClaves) as Record<string, ClavePrivadaCaso>;
  } catch (err) {
    console.error(`❌ Error al leer ${rutaClaves}:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const errores: string[] = [];
  const advertencias: string[] = [];

  const conteoGlobal: Record<string, number> = { si: 0, no: 0, dudoso: 0 };
  const conteoBloqueA: Record<string, number> = { si: 0, no: 0, dudoso: 0 };
  const conteoBloqueB: Record<string, number> = { si: 0, no: 0, dudoso: 0 };

  let totalEtiquetados = 0;
  let totalBloqueA = 0;
  let totalBloqueB = 0;

  for (const c of casos) {
    const etiqueta = (c.etiqueta || "").trim().toLowerCase();
    const clave = claves[String(c.caso)];

    if (!etiqueta) {
      errores.push(`Caso ${c.caso}: falta etiqueta (está vacía "").`);
      continue;
    }

    if (!ETIQUETAS_VALIDAS.has(etiqueta)) {
      errores.push(`Caso ${c.caso}: etiqueta inválida "${c.etiqueta}". Debe ser "si", "no" o "dudoso".`);
      continue;
    }

    totalEtiquetados++;
    conteoGlobal[etiqueta]++;

    const bloque = clave?.bloque;
    if (bloque === "A") {
      totalBloqueA++;
      conteoBloqueA[etiqueta]++;
    } else if (bloque === "B") {
      totalBloqueB++;
      conteoBloqueB[etiqueta]++;
    } else {
      advertencias.push(`Caso ${c.caso}: no tiene bloque asociado en claves-privadas.json.`);
    }
  }

  // 1. Mostrar estado de completitud
  console.log(`📋 Total de casos en plantilla: ${casos.length}`);
  console.log(`✍️ Casos etiquetados:           ${totalEtiquetados} / ${casos.length}`);

  if (errores.length > 0) {
    console.log(`\n❌ Se encontraron ${errores.length} inconsistencias o casos sin etiquetar:`);
    for (const err of errores.slice(0, 15)) {
      console.log(`  • ${err}`);
    }
    if (errores.length > 15) {
      console.log(`  ... y ${errores.length - 15} casos más.`);
    }
  }

  // 2. Comprobar guardas estadísticas en el Bloque A
  if (totalBloqueA < 30) {
    advertencias.push(
      `El Bloque A tiene solo ${totalBloqueA} casos etiquetados (< 30 requeridos). Las métricas estadísticas no serían confiables.`,
    );
  }

  if (conteoBloqueA.si < 8) {
    advertencias.push(
      `El Bloque A tiene solo ${conteoBloqueA.si} casos etiquetados como "si" (< 8 requeridos). Se requiere al menos 8 para medir recall confiablemente.`,
    );
  }

  if (conteoBloqueA.no < 8) {
    advertencias.push(
      `El Bloque A tiene solo ${conteoBloqueA.no} casos etiquetados como "no" (< 8 requeridos). Se requiere al menos 8 para medir especificidad confiablemente.`,
    );
  }

  // 3. Mostrar desglose si hay casos etiquetados
  console.log("\n================================================================================");
  console.log("📊 DISTRIBUCIÓN DE ETIQUETAS");
  console.log("================================================================================");
  console.log(`Global:   SI: ${conteoGlobal.si.toString().padEnd(4)} | NO: ${conteoGlobal.no.toString().padEnd(4)} | DUDOSO: ${conteoGlobal.dudoso.toString().padEnd(4)} | Total: ${totalEtiquetados}`);
  console.log(`Bloque A: SI: ${conteoBloqueA.si.toString().padEnd(4)} | NO: ${conteoBloqueA.no.toString().padEnd(4)} | DUDOSO: ${conteoBloqueA.dudoso.toString().padEnd(4)} | Total: ${totalBloqueA}`);
  console.log(`Bloque B: SI: ${conteoBloqueB.si.toString().padEnd(4)} | NO: ${conteoBloqueB.no.toString().padEnd(4)} | DUDOSO: ${conteoBloqueB.dudoso.toString().padEnd(4)} | Total: ${totalBloqueB}`);

  if (advertencias.length > 0) {
    console.log("\n⚠️ ADVERTENCIAS DE CONFIABILIDAD:");
    for (const adv of advertencias) {
      console.log(`  • ${adv}`);
    }
  }

  // 4. Veredicto final
  console.log("\n================================================================================");
  if (errores.length > 0 || advertencias.length > 0) {
    console.log("❌ EVALUACIÓN NO LISTA:");
    if (errores.length > 0) {
      console.log(`   Quedan ${errores.length} casos por etiquetar o con valor no permitido.`);
    }
    if (advertencias.length > 0) {
      console.log(`   No se cumplen las condiciones mínimas de balance de muestra para el Bloque A.`);
    }
    console.log("   Por favor edita 'data/pruebas-reto/evaluacion/casos-sin-etiquetar.json' y vuelve a validar.");
    console.log("================================================================================\n");
    process.exit(1);
  }

  console.log("✅ SET DE EVALUACIÓN LISTO Y VALIDADO");
  console.log("   Todos los 55 casos están debidamente etiquetados y cumplen las guardas estadísticas.");
  console.log("================================================================================\n");
}

if (process.argv[1]?.endsWith("evaluacion-validar.ts")) {
  validarEvaluacion().catch((err) => {
    console.error("❌ Error inesperado durante la validación:", err);
    process.exit(1);
  });
}
