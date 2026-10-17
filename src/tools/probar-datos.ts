/**
 * Prueba de la capa de datos + pre-filtro (sin LLM, no consume créditos de Grok).
 *
 *   pnpm probar:datos
 *
 * Imprime fecha y modo, filas descargadas, descartes por regla, candidatos y
 * 10 candidatos de muestra. Todo queda trazado en LangSmith bajo "probar_datos".
 */
import "../config/entorno.js";
import { traceable } from "langsmith/traceable";
import { descargarHoy } from "../datos/socrata.js";
import { prefiltrar, REGLAS_DESCARTE } from "../filtro/prefiltro.js";
import { cerrarTrazas, iniciarTrazas, opcionesTraceable } from "../trazas.js";

const formatoCOP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

async function probarDatosInterno() {
  const descarga = await descargarHoy();
  console.log(`Fecha usada : ${descarga.fecha}`);
  console.log(`Modo        : ${descarga.modo}${descarga.desdeCache ? " (caché)" : ""}`);
  console.log(`Filas       : ${descarga.filas.length}`);
  console.log(descarga.mensaje);

  if (descarga.filas.length === 0) {
    console.log("\nSin filas que pre-filtrar. Fin de la prueba.");
    return { fecha: descarga.fecha, modo: descarga.modo, filas: 0, candidatos: 0 };
  }

  const resultado = await prefiltrar(descarga.filas);

  console.log("\n=== Descartes por regla ===");
  for (const regla of REGLAS_DESCARTE) {
    console.log(`  ${regla.padEnd(26)} ${String(resultado.descartadosPorRegla[regla]).padStart(5)}`);
  }
  const descartados = resultado.total - resultado.candidatos.length;
  console.log(`  ${"TOTAL descartados".padEnd(26)} ${String(descartados).padStart(5)}`);
  console.log(`\nCandidatos: ${resultado.candidatos.length} de ${resultado.total}`);

  console.log("\n=== 10 candidatos de muestra ===");
  for (const c of resultado.candidatos.slice(0, 10)) {
    const valor = c.valor === null ? "valor desconocido" : formatoCOP.format(c.valor);
    console.log(`- ${c.id} | ${c.modalidad} | ${c.tipoDeContrato} | ${valor}`);
    console.log(`  ${c.entidad} (${c.ciudad}, ${c.departamento})`);
    console.log(`  ${c.nombre.slice(0, 100)} — ${c.descripcion.slice(0, 140)}`);
  }

  return {
    fecha: descarga.fecha,
    modo: descarga.modo,
    filas: resultado.total,
    candidatos: resultado.candidatos.length,
  };
}

const probarDatos = traceable(
  probarDatosInterno,
  opcionesTraceable<typeof probarDatosInterno>({ runName: "probar_datos", tags: ["etapa1"] }),
);

try {
  const trazas = await iniciarTrazas();
  console.log(`Trazas LangSmith: ${trazas ? `activas (proyecto ${process.env.LANGSMITH_PROJECT})` : "inactivas"}`);
  await probarDatos();
} catch (err) {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await cerrarTrazas();
}
