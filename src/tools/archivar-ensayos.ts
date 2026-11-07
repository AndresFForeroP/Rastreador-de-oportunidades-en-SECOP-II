/**
 * Herramienta de archivado seguro de ensayos y pruebas previas (S4-7).
 *
 * Comando CLI: `pnpm carga:archivar-ensayos`
 *
 * Cumple estrictamente la regla de "Clean start":
 * 1. MUEVE (nunca elimina) todos los archivos generados durante los ensayos
 *    (estado.json, eventos.jsonl, progreso.jsonl, heartbeat.json, bitacora-tareas.csv/.jsonl,
 *    recursos.csv, bitacora-carga.md, REPORTE-FINAL.md y variantes con costo)
 *    a `data/pruebas-reto/carga/ensayos/<timestamp>/`.
 * 2. Muestra explícitamente en consola cada archivo movido con su tamaño.
 * 3. Deja el directorio `data/pruebas-reto/carga/` limpio, listo e idóneo para la corrida real de 12 horas.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { DIR_CARGA } from "../pruebas/rutas.js";

export const ARCHIVOS_OBJETIVO_ENSAYO = [
  "estado.json",
  "eventos.jsonl",
  "progreso.jsonl",
  "heartbeat.json",
  "bitacora-tareas.csv",
  "bitacora-tareas.jsonl",
  "recursos.csv",
  "bitacora-carga.md",
  "REPORTE-FINAL.md",
  "bitacora-tareas-con-costo.csv",
  "bitacora-tareas-con-costo.jsonl",
] as const;

export function generarSufijoTimestamp(): string {
  const d = new Date();
  const pad = (n: number, z = 2) => String(n).padStart(z, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}Z`;
}

export async function archivarEnsayosPrevios(opciones?: {
  dirCarga?: string;
  timestamp?: string;
  silencioso?: boolean;
}): Promise<{
  carpetaDestino: string;
  archivosMovidos: Array<{ nombre: string; bytes: number }>;
}> {
  const dirCarga = opciones?.dirCarga ?? DIR_CARGA;
  const ts = opciones?.timestamp ?? generarSufijoTimestamp();
  const dirEnsayos = path.join(dirCarga, "ensayos", ts);

  const archivosMovidos: Array<{ nombre: string; bytes: number }> = [];

  // Verificar cuáles archivos existen antes de crear el directorio destino
  const existentes: string[] = [];
  for (const nombre of ARCHIVOS_OBJETIVO_ENSAYO) {
    const rutaOrigen = path.join(dirCarga, nombre);
    if (existsSync(rutaOrigen)) {
      existentes.push(nombre);
    }
  }

  if (existentes.length === 0) {
    if (!opciones?.silencioso) {
      console.log("================================================================================");
      console.log("🧹 LIMPIEZA DE ENSAYOS PREVIOS (pnpm carga:archivar-ensayos)");
      console.log("================================================================================");
      console.log(`ℹ️ El directorio ${dirCarga} ya se encuentra limpio.`);
      console.log("   No hay archivos de ensayo que requieran ser archivados.");
      console.log("================================================================================\n");
    }
    return { carpetaDestino: dirEnsayos, archivosMovidos: [] };
  }

  // Crear la carpeta de destino segura
  await mkdir(dirEnsayos, { recursive: true });

  if (!opciones?.silencioso) {
    console.log("================================================================================");
    console.log("📦 ARCHIVANDO ENSAYOS PREVIOS PARA ARRANQUE LIMPIO (S4-7)");
    console.log(`📂 Carpeta destino: ${dirEnsayos}`);
    console.log("--------------------------------------------------------------------------------");
  }

  for (const nombre of existentes) {
    const rutaOrigen = path.join(dirCarga, nombre);
    const rutaDestino = path.join(dirEnsayos, nombre);
    try {
      const st = await stat(rutaOrigen);
      const bytes = st.size;
      await rename(rutaOrigen, rutaDestino);
      archivosMovidos.push({ nombre, bytes });

      if (!opciones?.silencioso) {
        console.log(`   ✔ Movido: ${nombre.padEnd(32)} (${bytes.toLocaleString("es-CO")} bytes)`);
      }
    } catch (err) {
      console.error(`   ❌ Error al mover ${nombre}:`, err);
    }
  }

  if (!opciones?.silencioso) {
    console.log("--------------------------------------------------------------------------------");
    console.log(`✅ Total de archivos archivados: ${archivosMovidos.length}`);
    console.log(`✨ El directorio ${dirCarga} ha quedado completamente limpio y listo para la corrida real.`);
    console.log("================================================================================\n");
  }

  return { carpetaDestino: dirEnsayos, archivosMovidos };
}

// Ejecución directa si se invoca por CLI
if (process.argv[1] && process.argv[1].endsWith("archivar-ensayos.ts")) {
  archivarEnsayosPrevios().catch((err) => {
    console.error("❌ Fallo en archivar-ensayos:", err);
    process.exit(1);
  });
}

