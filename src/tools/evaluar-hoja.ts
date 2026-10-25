/**
 * Herramienta CLI: Agregador de calificaciones humanas de fidelidad (S3-5).
 *
 * Lee la hoja de revisión humana más reciente (o la ruta provista en --archivo),
 * extrae las calificaciones de 1 a 3 y comentarios, y calcula el promedio
 * de fidelidad y porcentaje de casos completados.
 *
 * Uso:
 *   pnpm evaluar:hoja [--archivo=ruta/a/hoja-revision-humana.md]
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { dirResultadosEvaluacion } from "../pruebas/rutas.js";

interface CalificacionCaso {
  numeroCaso: number;
  procesoId: string;
  calificacion: number | null;
  comentario: string;
}

function parsearArgumentos(): { rutaArchivo?: string } {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith("--archivo=")) {
      return { rutaArchivo: path.resolve(process.cwd(), arg.slice(10)) };
    }
  }
  return {};
}

async function encontrarUltimaHojaRevision(): Promise<string | null> {
  const baseDir = dirResultadosEvaluacion();
  let entradas: string[];
  try {
    entradas = await readdir(baseDir);
  } catch {
    return null;
  }

  const candidatosConMtime: Array<{ ruta: string; mtime: number }> = [];

  for (const carpeta of entradas) {
    if (carpeta.endsWith("-agentes")) {
      const rutaCandidata = path.join(baseDir, carpeta, "hoja-revision-humana.md");
      try {
        const s = await stat(rutaCandidata);
        candidatosConMtime.push({ ruta: rutaCandidata, mtime: s.mtimeMs });
      } catch {
        // Ignorar
      }
    }
  }

  candidatosConMtime.sort((a, b) => b.mtime - a.mtime);
  return candidatosConMtime[0]?.ruta ?? null;
}

export async function evaluarHoja(): Promise<void> {
  const args = parsearArgumentos();
  let rutaHoja = args.rutaArchivo;

  if (!rutaHoja) {
    const encontrada = await encontrarUltimaHojaRevision();
    if (!encontrada) {
      console.error(
        "❌ No se encontró ninguna hoja de revisión humana en data/pruebas-reto/evaluacion/resultados/*-agentes/hoja-revision-humana.md.\n" +
          "Ejecuta primero 'pnpm evaluar:agentes' para generar los casos a revisar.",
      );
      process.exit(1);
    }
    rutaHoja = encontrada;
  }

  console.log("================================================================================");
  console.log("📝 CONSOLIDACIÓN DE REVISIÓN HUMANA DE FIDELIDAD (AGENTE 2 — S3-5)");
  console.log(`Archivo: ${path.relative(process.cwd(), rutaHoja)}`);
  console.log("================================================================================\n");

  const contenido = await readFile(rutaHoja, "utf8");

  // Regex para bloques de caso
  const regexBloque = /### Caso\s+\[(\d+)\]\s+([\w\.-]+)[\s\S]*?- Calificación:\s*\[\s*([123]?)\s*\][\s\S]*?- Comentarios:\s*([^\r\n]*)/g;

  const casos: CalificacionCaso[] = [];
  let match: RegExpExecArray | null;

  while ((match = regexBloque.exec(contenido)) !== null) {
    const numeroCaso = Number.parseInt(match[1], 10);
    const procesoId = match[2].trim();
    const calStr = match[3]?.trim();
    const calificacion = calStr === "1" || calStr === "2" || calStr === "3" ? Number.parseInt(calStr, 10) : null;
    const comentario = (match[4] || "").replace(/^---.*$/, "").trim();

    casos.push({
      numeroCaso,
      procesoId,
      calificacion,
      comentario,
    });
  }

  if (casos.length === 0) {
    console.warn("⚠️ No se encontraron bloques de casos evaluables en el formato esperado.");
    return;
  }

  const calificados = casos.filter((c) => c.calificacion !== null);
  const pendientes = casos.filter((c) => c.calificacion === null);

  console.log(`Total de casos en la muestra: ${casos.length}`);
  console.log(`Casos calificados:            ${calificados.length} (${((calificados.length / casos.length) * 100).toFixed(1)}%)`);
  console.log(`Casos pendientes de revisión: ${pendientes.length}\n`);

  console.log("Detalle por caso:");
  console.log("--------------------------------------------------------------------------------");
  for (const c of casos) {
    const estado =
      c.calificacion !== null
        ? `⭐ [${c.calificacion}/3]`
        : "⏳ [PENDIENTE]";
    const comentarioStr = c.comentario ? ` | Comentario: "${c.comentario}"` : "";
    console.log(`• Caso #${c.numeroCaso} (${c.procesoId}): ${estado}${comentarioStr}`);
  }
  console.log("--------------------------------------------------------------------------------\n");

  if (calificados.length > 0) {
    const suma = calificados.reduce((acc, curr) => acc + (curr.calificacion ?? 0), 0);
    const promedio = suma / calificados.length;
    console.log(`🎯 Calificación Promedio de Fidelidad: ${promedio.toFixed(2)} / 3.00`);
    const nivel =
      promedio >= 2.5
        ? "ALTA FIDELIDAD (Resúmenes rigurosos y respetuosos de los datos abiertos)"
        : promedio >= 1.8
          ? "FIDELIDAD MEDIA (Generalmente fiel con imprecisiones menores)"
          : "BAJA FIDELIDAD (Se detectan discrepancias u omisiones sustanciales)";
    console.log(`   Interpretación cualitativa: ${nivel}\n`);
  } else {
    console.log("ℹ️ Aún no has ingresado calificaciones en la hoja.");
    console.log(`Abre "${rutaHoja}", rellena los campos 'Calificación: [1|2|3]' y vuelve a ejecutar:`);
    console.log("   pnpm evaluar:hoja\n");
  }
}

if (process.argv[1]?.endsWith("evaluar-hoja.ts")) {
  evaluarHoja().catch((err) => {
    console.error("Error al consolidar la hoja:", err);
    process.exit(1);
  });
}
