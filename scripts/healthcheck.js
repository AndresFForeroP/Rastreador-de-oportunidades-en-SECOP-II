#!/usr/bin/env node
/**
 * Healthcheck para el daemon desatendido de carga (scripts/healthcheck.js).
 *
 * Cumple los criterios de S4-4:
 * 1. Lee data/pruebas-reto/carga/heartbeat.json.
 * 2. Falla (código de salida 1 -> unhealthy) si:
 *    - El archivo no existe o está corrupto.
 *    - El estado es "error" o "error_ciclo".
 *    - La antigüedad del heartbeat supera 3 veces el intervalo del ciclo (3 * intervaloCicloSeg).
 * 3. Tiene éxito (código de salida 0 -> healthy) cuando el heartbeat está dentro del rango esperado.
 */
import fs from "node:fs";
import path from "node:path";

const rutaHeartbeat =
  process.env.HEALTHCHECK_HEARTBEAT_PATH ||
  path.resolve(process.cwd(), "data", "pruebas-reto", "carga", "heartbeat.json");

function fallar(mensaje) {
  process.stderr.write(`[healthcheck] ❌ UNHEALTHY: ${mensaje}\n`);
  process.exit(1);
}

function exito(mensaje) {
  process.stdout.write(`[healthcheck] ✅ HEALTHY: ${mensaje}\n`);
  process.exit(0);
}

try {
  if (!fs.existsSync(rutaHeartbeat)) {
    fallar(`No se encontró el archivo de heartbeat en: ${rutaHeartbeat}`);
  }

  const raw = fs.readFileSync(rutaHeartbeat, "utf8");
  if (!raw.trim()) {
    fallar("El archivo heartbeat.json está vacío.");
  }

  let datos;
  try {
    datos = JSON.parse(raw);
  } catch (err) {
    fallar(`heartbeat.json contiene JSON inválido: ${err.message}`);
  }

  // 1. Verificación de estado de error
  const status = String(datos.status || "").toLowerCase();
  if (status === "error" || status === "error_ciclo") {
    fallar(`El daemon reporta estado de error: "${datos.status}" en ciclo ${datos.cycle ?? datos.ciclo}`);
  }

  // 2. Verificación de timestamp y cálculo de antigüedad
  if (!datos.timestamp) {
    fallar("El heartbeat no contiene campo timestamp.");
  }

  const timestampMs = Date.parse(datos.timestamp);
  if (Number.isNaN(timestampMs)) {
    fallar(`Timestamp inválido en heartbeat: "${datos.timestamp}"`);
  }

  const ahoraMs = Date.now();
  const edadSeg = Math.max(0, (ahoraMs - timestampMs) / 1000);

  // 3. Determinar intervalo de ciclo esperado (por defecto 300s si no está configurado)
  const intervaloCicloSeg = Number(datos.intervaloCicloSeg) || Number(datos.intervaloObjetivoSeg) || 300;
  const maxEdadPermitidaSeg = 3 * intervaloCicloSeg;

  if (edadSeg > maxEdadPermitidaSeg) {
    fallar(
      `Heartbeat expirado. Antigüedad: ${edadSeg.toFixed(1)}s, superior a 3x el intervalo de ciclo (${maxEdadPermitidaSeg}s, base ciclo: ${intervaloCicloSeg}s).`,
    );
  }

  exito(
    `Daemon activo (ciclo ${datos.cycle ?? datos.ciclo}, status: "${datos.status}", antigüedad: ${edadSeg.toFixed(1)}s <= ${maxEdadPermitidaSeg}s).`,
  );
} catch (err) {
  fallar(`Fallo inesperado al evaluar healthcheck: ${err.message}`);
}
