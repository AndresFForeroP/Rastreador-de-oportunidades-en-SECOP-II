/**
 * Libro mayor de ejecuciones (Execution Ledger) para el Reto Agente 2026.
 *
 * Registra cada corrida en data/pruebas-reto/ejecuciones/registro.jsonl,
 * genera la tabla de resumen en ejecuciones/RESUMEN.md, y almacena los artefactos
 * (reporte.json, reporte.md, tokens.jsonl, trazas.json) en ejecuciones/<ejecucionId>/.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { leerRegistrosTokens, type RegistroTokens } from "../cost.js";
import {
  asegurarCarpetaEjecucion,
  asegurarEstructuraPruebas,
  dirEjecucionIndividual,
  rutaRegistroEjecuciones,
  rutaResumenEjecuciones,
  verificarTamanoArchivo,
} from "./rutas.js";

export type TipoEjecucion = "normal" | "evaluacion" | "carga" | "daemon";
export type EstadoEjecucion = "ok" | "parcial" | "error";

export interface MetaInicioEjecucion {
  tipo?: TipoEjecucion;
  modo?: string;
  fechaDatos?: string;
  parametros?: Record<string, unknown>;
}

export interface ResumenFinalEjecucion {
  tipo?: TipoEjecucion;
  modo?: string;
  fechaDatos?: string;
  parametros?: Record<string, unknown>;
  etapas?: {
    candidatos: number;
    aptos: number;
    resumidos: number;
    documentados: number;
  };
  errores?: string[];
  tokens?: {
    entrada: number;
    salida: number;
    razonamiento: number | null;
    total: number;
  };
  costoUSD?: number | null;
  langsmith?: {
    proyecto: string;
    runId: string | null;
    url: string | null;
  };
  estado?: EstadoEjecucion;
  reporteRutas?: {
    rutaJson: string;
    rutaMd: string;
  } | null;
  trazasCompactas?: unknown;
}

export interface RegistroEjecucion {
  ejecucionId: string;
  inicio: string;
  fin: string;
  duracionSeg: number;
  tipo: TipoEjecucion;
  modo: string;
  fechaDatos: string;
  parametros: Record<string, unknown>;
  etapas: {
    candidatos: number;
    aptos: number;
    resumidos: number;
    documentados: number;
  };
  errores: string[];
  tokens: {
    entrada: number;
    salida: number;
    razonamiento: number | null;
    total: number;
  };
  costoUSD: number | null;
  langsmith: {
    proyecto: string;
    runId: string | null;
    url: string | null;
  };
  commit: string | null;
  estado: EstadoEjecucion;
}

/** Mapa en memoria de ejecuciones iniciadas en el proceso actual */
const mapaEjecucionesEnVuelo = new Map<
  string,
  {
    inicio: string;
    meta: MetaInicioEjecucion;
  }
>();

/** Genera un identificador legible y ordenable: timestamp ISO compacto + 4 caracteres aleatorios */
function generarIdEjecucion(): string {
  const ahora = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${ahora.getFullYear()}${pad(ahora.getMonth() + 1)}${pad(ahora.getDate())}-${pad(ahora.getHours())}${pad(ahora.getMinutes())}${pad(ahora.getSeconds())}`;
  const random4 = randomBytes(2).toString("hex");
  return `${ts}_${random4}`;
}

/** Obtiene el commit git abreviado actual si está disponible */
export function obtenerCommitActual(): string | null {
  try {
    const out = execSync("git rev-parse --short HEAD", {
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Limpia parámetros para garantizar que nunca se registren secretos */
function sanitizarParametros(params?: Record<string, unknown>): Record<string, unknown> {
  if (!params) return {};
  const limpio: Record<string, unknown> = {};
  const regexSecreto = /(key|secret|token|password|auth|credential)/i;
  for (const [k, v] of Object.entries(params)) {
    if (regexSecreto.test(k)) {
      limpio[k] = "[OCULTO]";
    } else {
      limpio[k] = v;
    }
  }
  return limpio;
}

/**
 * Consulta el costo financiero en USD si config/precios.json existe.
 * Si no está configurado, retorna null conforme a la regla inmutable.
 */
export async function calcularCostoEstimado(
  modelo: string,
  tokensEntrada: number,
  tokensSalida: number,
): Promise<number | null> {
  const rutaPrecios = path.resolve(process.cwd(), "config", "precios.json");
  try {
    const raw = await readFile(rutaPrecios, "utf8");
    const config = JSON.parse(raw);
    const precioModelo =
      config.modelos?.[modelo] ??
      config.modelos?.["default"] ??
      config[modelo] ??
      config["default"];
    const pEntrada = precioModelo?.porMillonEntrada ?? precioModelo?.inputPorMillon;
    const pSalida = precioModelo?.porMillonSalida ?? precioModelo?.outputPorMillon;

    if (typeof pEntrada !== "number" || typeof pSalida !== "number") {
      return null;
    }
    const costo =
      (tokensEntrada / 1_000_000) * pEntrada +
      (tokensSalida / 1_000_000) * pSalida;
    return Number(costo.toFixed(6));
  } catch {
    return null;
  }
}

/**
 * Registra el inicio de una ejecución y prepara su carpeta individual.
 * Devuelve el `ejecucionId` único generado.
 */
export async function iniciarEjecucion(meta: MetaInicioEjecucion = {}): Promise<string> {
  await asegurarEstructuraPruebas();
  const ejecucionId = generarIdEjecucion();
  const inicio = new Date().toISOString();

  mapaEjecucionesEnVuelo.set(ejecucionId, {
    inicio,
    meta: {
      ...meta,
      parametros: sanitizarParametros(meta.parametros),
    },
  });

  await asegurarCarpetaEjecucion(ejecucionId);
  return ejecucionId;
}

/**
 * Lee todos los registros históricos de ejecuciones desde registro.jsonl.
 */
export async function leerRegistrosEjecuciones(): Promise<RegistroEjecucion[]> {
  try {
    const ruta = rutaRegistroEjecuciones();
    const raw = await readFile(ruta, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as RegistroEjecucion);
  } catch {
    return [];
  }
}

/**
 * Regenera data/pruebas-reto/ejecuciones/RESUMEN.md con la tabla de las últimas 20
 * corridas y acumulados globales en español.
 */
export async function regenerarResumenEjecuciones(): Promise<void> {
  const registros = await leerRegistrosEjecuciones();
  const rutaResumen = rutaResumenEjecuciones();

  if (registros.length === 0) {
    const mdVacio = `# Resumen de Ejecuciones — Reto Agente 2026\n\n*No hay ejecuciones registradas en el libro mayor aún.*\n`;
    await writeFile(rutaResumen, mdVacio, "utf8");
    return;
  }

  // Orden cronológico descendente (más recientes primero)
  const ordenados = [...registros].reverse();
  const ultimas20 = ordenados.slice(0, 20);

  // Totales acumulados
  let totalEntrada = 0;
  let totalSalida = 0;
  let totalTokens = 0;
  let sumaCostoUSD = 0;
  let hayCostos = false;
  let totalCandidatos = 0;
  let totalAptos = 0;
  let totalResumidos = 0;
  let totalDocumentados = 0;
  let exitosas = 0;
  let parciales = 0;
  let errores = 0;

  for (const r of registros) {
    totalEntrada += r.tokens.entrada;
    totalSalida += r.tokens.salida;
    totalTokens += r.tokens.total;
    if (typeof r.costoUSD === "number") {
      sumaCostoUSD += r.costoUSD;
      hayCostos = true;
    }
    totalCandidatos += r.etapas.candidatos;
    totalAptos += r.etapas.aptos;
    totalResumidos += r.etapas.resumidos;
    totalDocumentados += r.etapas.documentados;

    if (r.estado === "ok") exitosas++;
    else if (r.estado === "parcial") parciales++;
    else errores++;
  }

  const formatoNum = (n: number) => n.toLocaleString("es-CO");
  const ahora = new Date().toISOString();

  let contenido = `# Resumen de Ejecuciones — Reto Agente 2026\n\n`;
  contenido += `> **Libro Mayor de Corridas**: Registro histórico committeable generado a partir de \`registro.jsonl\`.\n`;
  contenido += `> **Última actualización**: ${ahora} | **Total registradas**: ${registros.length}\n\n`;

  contenido += `## 1. Totales Acumulados\n\n`;
  contenido += `| Métrica | Valor Acumulado |\n`;
  contenido += `|---|---:|\n`;
  contenido += `| **Corridas Totales** | ${registros.length} (✅ ${exitosas} ok, ⚠️ ${parciales} parcial, ❌ ${errores} error) |\n`;
  contenido += `| **Candidatos Pre-filtrados** | ${formatoNum(totalCandidatos)} |\n`;
  contenido += `| **Clasificados Aptos (Agente 1)** | ${formatoNum(totalAptos)} |\n`;
  contenido += `| **Fichas y Resúmenes (Agente 2)** | ${formatoNum(totalResumidos)} |\n`;
  contenido += `| **Documentos Estructurados (Agente 3)** | ${formatoNum(totalDocumentados)} |\n`;
  contenido += `| **Tokens de Entrada** | ${formatoNum(totalEntrada)} |\n`;
  contenido += `| **Tokens de Salida** | ${formatoNum(totalSalida)} |\n`;
  contenido += `| **Tokens Facturados (Total)** | **${formatoNum(totalTokens)}** |\n`;
  contenido += `| **Costo Total Estimado (USD)** | ${hayCostos ? `$ ${sumaCostoUSD.toFixed(4)}` : "*precio no configurado*"} |\n\n`;

  contenido += `## 2. Últimas ${ultimas20.length} Ejecuciones\n\n`;
  contenido += `| ID Ejecución | Inicio | Tipo | Modo | Fecha Datos | Dur. | Cand. | Aptos | Res. | Docs | Tokens Total | Costo USD | Estado | Commit |\n`;
  contenido += `|---|---|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|:---:|:---:|:---:|\n`;

  for (const r of ultimas20) {
    const inicioCorto = r.inicio.replace("T", " ").slice(0, 19);
    const duracion = `${r.duracionSeg}s`;
    const costoTexto = typeof r.costoUSD === "number" ? `$${r.costoUSD.toFixed(4)}` : "n/c";
    const estadoIcono = r.estado === "ok" ? "✅ ok" : r.estado === "parcial" ? "⚠️ parc" : "❌ err";
    const commitTexto = r.commit ?? "n/a";

    contenido +=
      `| [\`${r.ejecucionId}\`](./${r.ejecucionId}) | ${inicioCorto} | ${r.tipo} | ${r.modo} | ` +
      `${r.fechaDatos} | ${duracion} | ${r.etapas.candidatos} | ${r.etapas.aptos} | ${r.etapas.resumidos} | ` +
      `${r.etapas.documentados} | ${formatoNum(r.tokens.total)} | ${costoTexto} | ${estadoIcono} | \`${commitTexto}\` |\n`;
  }

  contenido += `\n*Nota: "n/c" indica precio no configurado en config/precios.json.*\n`;

  await writeFile(rutaResumen, contenido, "utf8");
}

/**
 * Finaliza la ejecución, almacena las evidencias en su subcarpeta y actualiza el libro mayor.
 */
export async function finalizarEjecucion(
  ejecucionId: string,
  resumen: ResumenFinalEjecucion,
): Promise<RegistroEjecucion> {
  const enVuelo = mapaEjecucionesEnVuelo.get(ejecucionId);
  const inicio = enVuelo?.inicio ?? new Date().toISOString();
  const fin = new Date().toISOString();
  const duracionSeg = Math.max(0, Math.round((Date.now() - Date.parse(inicio)) / 1000));
  const dirEjecucion = dirEjecucionIndividual(ejecucionId);
  await asegurarCarpetaEjecucion(ejecucionId);

  // 1. Copiar reportes generados a la carpeta de la ejecución
  if (resumen.reporteRutas) {
    try {
      const destJson = path.join(dirEjecucion, "reporte.json");
      const destMd = path.join(dirEjecucion, "reporte.md");
      await copyFile(resumen.reporteRutas.rutaJson, destJson);
      await copyFile(resumen.reporteRutas.rutaMd, destMd);
      await verificarTamanoArchivo(destJson);
      await verificarTamanoArchivo(destMd);
    } catch (err) {
      console.warn(`[ledger] No se pudieron copiar todos los reportes a ${ejecucionId}:`, err);
    }
  }

  // 2. Extraer y guardar los registros de tokens específicos de esta ejecución
  const todosLosTokens = await leerRegistrosTokens();
  const tokensEjecucion = todosLosTokens.filter((r) => r.ejecucionId === ejecucionId);

  // Si no se proveyeron tokens explícitos en resumen, se acumulan desde los registros de esta corrida
  let entradaTokens = resumen.tokens?.entrada ?? 0;
  let salidaTokens = resumen.tokens?.salida ?? 0;
  let totalTokens = resumen.tokens?.total ?? 0;
  let razonamientoTokens = resumen.tokens?.razonamiento ?? null;

  if (tokensEjecucion.length > 0) {
    const destTokens = path.join(dirEjecucion, "tokens.jsonl");
    const lineasTokens = tokensEjecucion.map((t) => JSON.stringify(t)).join("\n") + "\n";
    await writeFile(destTokens, lineasTokens, "utf8");
    await verificarTamanoArchivo(destTokens);

    if (totalTokens === 0) {
      entradaTokens = tokensEjecucion.reduce((acc, t) => acc + (t.tokens_entrada || 0), 0);
      salidaTokens = tokensEjecucion.reduce((acc, t) => acc + (t.tokens_salida || 0), 0);
      totalTokens = tokensEjecucion.reduce((acc, t) => acc + (t.tokens_total || 0), 0);
      const sumaRaz = tokensEjecucion.reduce((acc, t) => acc + (t.tokens_razonamiento || 0), 0);
      razonamientoTokens = sumaRaz > 0 ? sumaRaz : null;
    }
  }

  // 3. Guardar trazas compactas si están disponibles
  if (resumen.trazasCompactas !== undefined && resumen.trazasCompactas !== null) {
    const destTrazas = path.join(dirEjecucion, "trazas.json");
    await writeFile(destTrazas, JSON.stringify(resumen.trazasCompactas, null, 2), "utf8");
    await verificarTamanoArchivo(destTrazas);
  }

  // 4. Determinar estado
  let estado: EstadoEjecucion = resumen.estado ?? "ok";
  if (!resumen.estado) {
    if (resumen.errores && resumen.errores.length > 0) {
      estado = (resumen.etapas?.resumidos ?? 0) > 0 ? "parcial" : "error";
    }
  }

  // 5. Construir registro para el ledger
  const registro: RegistroEjecucion = {
    ejecucionId,
    inicio,
    fin,
    duracionSeg,
    tipo: resumen.tipo ?? enVuelo?.meta.tipo ?? "normal",
    modo: resumen.modo ?? enVuelo?.meta.modo ?? "hoy",
    fechaDatos: resumen.fechaDatos ?? enVuelo?.meta.fechaDatos ?? "desconocida",
    parametros: sanitizarParametros(resumen.parametros ?? enVuelo?.meta.parametros),
    etapas: resumen.etapas ?? {
      candidatos: 0,
      aptos: 0,
      resumidos: 0,
      documentados: 0,
    },
    errores: resumen.errores ?? [],
    tokens: {
      entrada: entradaTokens,
      salida: salidaTokens,
      razonamiento: razonamientoTokens,
      total: totalTokens,
    },
    costoUSD: resumen.costoUSD ?? null,
    langsmith: resumen.langsmith ?? {
      proyecto: process.env.LANGSMITH_PROJECT || "secop-rastreador",
      runId: null,
      url: null,
    },
    commit: obtenerCommitActual(),
    estado,
  };

  // 6. Escribir al libro mayor registro.jsonl
  const rutaLedger = rutaRegistroEjecuciones();
  await appendFile(rutaLedger, JSON.stringify(registro) + "\n", "utf8");
  await verificarTamanoArchivo(rutaLedger);

  // 7. Regenerar RESUMEN.md
  await regenerarResumenEjecuciones();

  mapaEjecucionesEnVuelo.delete(ejecucionId);
  return registro;
}
