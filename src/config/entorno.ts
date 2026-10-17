import { config } from "dotenv";

// Carga .env en local. En Docker las variables llegan por `env_file` y no hay
// .env dentro de la imagen, así que esto no hace nada (silencioso).
// Este módulo debe importarse ANTES que cualquier otro que lea process.env.
config({ quiet: true });

/** Modo de ejecución: "produccion" (solo HOY) o "prueba" (SECOP_FECHA_PRUEBA activa). */
export type ModoEjecucion = "produccion" | "prueba";

const PATRON_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lee SECOP_FECHA_PRUEBA (YYYY-MM-DD). Apagada por defecto.
 * Es la ÚNICA excepción de desarrollo a la regla "solo procesos de hoy".
 * Si el valor existe pero es inválido, se lanza error (nunca se adivina una fecha).
 */
export function leerFechaPrueba(): string | null {
  const valor = process.env.SECOP_FECHA_PRUEBA?.trim();
  if (!valor) return null;

  const [anio, mes, dia] = valor.split("-").map(Number);
  const fecha = new Date(Date.UTC(anio ?? NaN, (mes ?? NaN) - 1, dia ?? NaN));
  const valida =
    PATRON_FECHA.test(valor) &&
    !Number.isNaN(fecha.getTime()) &&
    fecha.toISOString().slice(0, 10) === valor;

  if (!valida) {
    throw new Error(
      `SECOP_FECHA_PRUEBA="${valor}" no es una fecha válida con formato YYYY-MM-DD. ` +
        "Corrígela o elimínala para trabajar con la fecha de hoy.",
    );
  }
  return valor;
}

/** Modo actual, derivado de SECOP_FECHA_PRUEBA. */
export function modoEjecucion(): ModoEjecucion {
  return leerFechaPrueba() ? "prueba" : "produccion";
}
