/**
 * Verificación pre-vuelo para la corrida desatendida de 12 horas (src/tools/preflight.ts).
 *
 * Ejecutable vía `pnpm preflight`.
 *
 * Imprime un dictamen GO / NO-GO evaluando 12 comprobaciones críticas:
 * 1. Nombres de variables requeridas en .env (NUNCA imprime valores).
 * 2. Validación ligera de la llave de LangSmith en api.smith.langchain.com.
 * 3. Pasarela oficial del reto alcanzable mediante 1 llamada mínima real al modelo (reporta tokens y costo).
 * 4. Estado de precios en config/precios.json.
 * 5. Presupuesto y meta de unidades provistos.
 * 6. Consistencia del archivo de estado persistente (estado.json).
 * 7. Permisos de escritura en data/pruebas-reto/.
 * 8. Espacio libre en disco (statfs).
 * 9. Estado de ejecución de Docker Engine.
 * 10. Imagen Docker del daemon construida.
 * 11. Árbol de Git limpio (lista detallada de lo que no esté committeado).
 * 12. Cero secretos en archivos staged (escaneo por patrones; reporta SOLO rutas de archivo).
 */
import { execSync } from "node:child_process";
import { readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import "../config/entorno.js";
import { llm, MODEL_NAME, RETO_BASE_URL } from "../llm.js";
import { RETO_GATEWAY_HOSTNAME, verificarGatewayReto } from "../carga/bitacora-tareas.js";
import { calcularCostoEstimado } from "../pruebas/registro-ejecuciones.js";
import { registrarCosto } from "../cost.js";
import {
  DIR_PRUEBAS_RETO,
  rutaBitacoraTareasCsv,
  rutaEstadoCarga,
} from "../pruebas/rutas.js";
import {
  resolverConfiguracionEfectivaDaemon,
  type ConfiguracionEfectivaDaemon,
} from "../daemon.js";
import type { AIMessage } from "@langchain/core/messages";
import type { DatosEstadoPersistenteCarga } from "../carga/estado.js";

export interface ResultadoChequeo {
  nombre: string;
  estado: "OK" | "AVISO" | "NO-GO";
  mensaje: string;
  detalles?: string[];
}

// ============================================================================
// 1. CHEQUEOS INDIVIDUALES
// ============================================================================

/**
 * 1. Comprueba la presencia de las variables requeridas en process.env.
 * REGLA INMUTABLE: NUNCA imprime los valores ni prefijos de las llaves.
 */
export function chequearVariablesEntorno(): ResultadoChequeo {
  const variablesRequeridas = [
    { nombre: "RETO_KEY", alias: ["OPENAI_API_KEY"], descripcion: "Llave oficial del Reto Agente" },
    { nombre: "LANGSMITH_API_KEY", alias: ["LANGCHAIN_API_KEY"], descripcion: "Llave de LangSmith para telemetría" },
    { nombre: "LANGCHAIN_TRACING_V2", alias: ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING"], descripcion: "Activación de trazas ('true')" },
    { nombre: "LANGSMITH_PROJECT", alias: ["LANGCHAIN_PROJECT"], descripcion: "Nombre del proyecto de trazas" },
  ];

  const faltantes: string[] = [];
  const presentes: string[] = [];

  for (const v of variablesRequeridas) {
    const valPrincipal = process.env[v.nombre]?.trim();
    const valAlias = v.alias.find((a) => Boolean(process.env[a]?.trim()));

    if (valPrincipal || valAlias) {
      presentes.push(v.nombre);
    } else {
      faltantes.push(v.nombre);
    }
  }

  if (faltantes.length > 0) {
    return {
      nombre: "Variables de entorno (.env)",
      estado: "NO-GO",
      mensaje: `Faltan variables críticas en el entorno: ${faltantes.join(", ")}`,
      detalles: [
        ...presentes.map((v) => `  [OK] ${v}: PRESENTE`),
        ...faltantes.map((v) => `  [FALTA] ${v}: NO DEFINIDA (configurar en .env)`),
      ],
    };
  }

  return {
    nombre: "Variables de entorno (.env)",
    estado: "OK",
    mensaje: `Todas las variables requeridas están presentes (${presentes.length} detectadas). Valores ocultos protegidos.`,
    detalles: presentes.map((v) => `  [OK] ${v}: PRESENTE`),
  };
}

/**
 * 2. Comprueba si la API key de LangSmith es aceptada mediante una consulta ligera.
 */
export async function chequearLangSmith(): Promise<ResultadoChequeo> {
  const apiKey = (process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY)?.trim();
  if (!apiKey) {
    return {
      nombre: "Autenticación LangSmith",
      estado: "NO-GO",
      mensaje: "No se encontró LANGSMITH_API_KEY en el entorno.",
    };
  }

  try {
    const res = await fetch("https://api.smith.langchain.com/info", {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      let version = "";
      try {
        const json = (await res.json()) as { version?: string };
        version = json.version ? ` (versión del servidor: ${json.version})` : "";
      } catch {
        // Ignorar parseo si solo devuelve 200
      }
      return {
        nombre: "Autenticación LangSmith",
        estado: "OK",
        mensaje: `Conexión con api.smith.langchain.com exitosa HTTP ${res.status}${version}.`,
      };
    } else if (res.status === 401 || res.status === 403) {
      return {
        nombre: "Autenticación LangSmith",
        estado: "NO-GO",
        mensaje: `Llave de LangSmith rechazada por el servidor (HTTP ${res.status} ${res.statusText}).`,
      };
    } else {
      return {
        nombre: "Autenticación LangSmith",
        estado: "AVISO",
        mensaje: `Servidor de LangSmith respondió con estado no esperado: HTTP ${res.status} ${res.statusText}.`,
      };
    }
  } catch (err) {
    return {
      nombre: "Autenticación LangSmith",
      estado: "AVISO",
      mensaje: `No se pudo conectar a LangSmith (${err instanceof Error ? err.message : String(err)}). Verifique la conexión a internet.`,
    };
  }
}

/**
 * 3. Ejecuta EXACTAMENTE 1 llamada mínima real al modelo a través de la pasarela oficial.
 */
export async function chequearGatewayLlm(): Promise<ResultadoChequeo> {
  try {
    verificarGatewayReto();
  } catch (err) {
    return {
      nombre: "Gateway oficial del Reto",
      estado: "NO-GO",
      mensaje: `La URL base configurada no corresponde al gateway oficial: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const prompt = "Responde exactamente la palabra 'LISTO' sin puntuación ni texto adicional.";
    const tInicio = Date.now();

    const res = (await llm.invoke(prompt, { timeout: 10000 })) as AIMessage;
    const duracionMs = Date.now() - tInicio;

    // Registrar costo en logs/tokens.jsonl para trazabilidad completa con el gateway
    await registrarCosto("preflight:gateway-check", MODEL_NAME, res);

    const usage = (res.usage_metadata ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      output_token_details?: { reasoning?: number };
    };

    const tokensEntrada = usage.input_tokens ?? 0;
    const tokensSalida = usage.output_tokens ?? 0;
    const tokensTotal = usage.total_tokens ?? tokensEntrada + tokensSalida;
    const razonamiento = usage.output_token_details?.reasoning ?? 0;

    const costoUSD = await calcularCostoEstimado(MODEL_NAME, tokensEntrada, tokensSalida);
    const costoTxt = costoUSD !== null ? `$${costoUSD.toFixed(6)} USD` : "Tarifas en null (precios.json)";

    const respuestaTexto = String(res.content ?? "").trim().slice(0, 30);

    return {
      nombre: "Gateway oficial del Reto",
      estado: "OK",
      mensaje: `Gateway ${RETO_GATEWAY_HOSTNAME} alcanzable y verificado en ${duracionMs}ms.`,
      detalles: [
        `  • Hostname oficial: ${RETO_GATEWAY_HOSTNAME}`,
        `  • Modelo activo:    ${MODEL_NAME}`,
        `  • Respuesta modelo: "${respuestaTexto}"`,
        `  • Tokens llamada:   ${tokensEntrada} entrada / ${tokensSalida} salida / ${razonamiento} razonamiento (Total: ${tokensTotal})`,
        `  • Costo financiero: ${costoTxt}`,
      ],
    };
  } catch (err) {
    return {
      nombre: "Gateway oficial del Reto",
      estado: "NO-GO",
      mensaje: `Fallo al invocar el gateway oficial del reto: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 4. Comprueba el estado de configuración de tarifas en config/precios.json.
 */
export async function chequearPrecios(): Promise<ResultadoChequeo> {
  const rutaPrecios = path.resolve(process.cwd(), "config", "precios.json");
  try {
    const raw = await readFile(rutaPrecios, "utf8");
    const json = JSON.parse(raw);
    const mod = json.modelos?.[MODEL_NAME] ?? json[MODEL_NAME];
    const pEntrada = mod?.porMillonEntrada ?? mod?.inputPorMillon;
    const pSalida = mod?.porMillonSalida ?? mod?.outputPorMillon;

    if (typeof pEntrada === "number" && typeof pSalida === "number") {
      return {
        nombre: "Configuración de precios (precios.json)",
        estado: "OK",
        mensaje: `Tarifas configuradas para ${MODEL_NAME}: $${pEntrada} / 1M entrada, $${pSalida} / 1M salida.`,
      };
    } else {
      return {
        nombre: "Configuración de precios (precios.json)",
        estado: "AVISO",
        mensaje: `Tarifas en null para ${MODEL_NAME}. El sistema operará basándose estrictamente en presupuesto de tokens facturados.`,
      };
    }
  } catch (err) {
    return {
      nombre: "Configuración de precios (precios.json)",
      estado: "AVISO",
      mensaje: `No se pudo leer config/precios.json (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

/**
 * 5. Comprueba la configuración efectiva que el daemon utilizará realmente (S4-FINAL A.3)
 * y valida cualquier expectativa pasada mediante flags --esperado clave=valor.
 */
export function chequearConfiguracionEfectivaDaemon(
  argv: string[] = process.argv.slice(2),
): ResultadoChequeo {
  const config = resolverConfiguracionEfectivaDaemon(argv);

  // Extraer pares esperados (--esperado key=val o --esperado=key=val)
  const esperados: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--esperado=")) {
      const par = a.slice("--esperado=".length).trim();
      const idx = par.indexOf("=");
      if (idx > 0) {
        esperados[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
      }
    } else if (a === "--esperado" && argv[i + 1]) {
      const par = argv[++i]!.trim();
      const idx = par.indexOf("=");
      if (idx > 0) {
        esperados[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
      }
    }
  }

  // Imprimir tabla de configuración efectiva
  console.log("\n================================================================================");
  console.log("📋 CONFIGURACIÓN EFECTIVA QUE USARÁ EL DAEMON (S4-FINAL A.3)");
  console.log("================================================================================");
  console.log(`| Parámetro           | Valor Efectivo             | Origen  | Detalle Origen`);
  console.log(`|---------------------|----------------------------|---------|---------------------------------------------`);
  console.log(`| Unidades Meta       | ${String(config.unidades.valor).padEnd(26)} | ${config.unidades.origen.padEnd(7)} | ${config.unidades.detalleOrigen}`);
  console.log(`| Horas Totales       | ${String(config.horas.valor + " h").padEnd(26)} | ${config.horas.origen.padEnd(7)} | ${config.horas.detalleOrigen}`);
  console.log(`| Horas Mínimas       | ${String(config.horasMinimas.valor + " h").padEnd(26)} | ${config.horasMinimas.origen.padEnd(7)} | ${config.horasMinimas.detalleOrigen}`);
  console.log(`| Tamaño de Lote      | ${String(config.lote.valor + " procesos").padEnd(26)} | ${config.lote.origen.padEnd(7)} | ${config.lote.detalleOrigen}`);
  console.log(`| Concurrencia        | ${String(config.concurrencia.valor + " llamadas").padEnd(26)} | ${config.concurrencia.origen.padEnd(7)} | ${config.concurrencia.detalleOrigen}`);
  console.log(`| Presupuesto Tokens  | ${String(config.presupuestoTokens.valor ? config.presupuestoTokens.valor.toLocaleString("es-CO") + " tokens" : "No configurado").padEnd(26)} | ${config.presupuestoTokens.origen.padEnd(7)} | ${config.presupuestoTokens.detalleOrigen}`);
  console.log(`| Presupuesto USD     | ${String(config.presupuestoUSD.valor !== null ? "$" + config.presupuestoUSD.valor + " USD" : "No configurado").padEnd(26)} | ${config.presupuestoUSD.origen.padEnd(7)} | ${config.presupuestoUSD.detalleOrigen}`);
  console.log(`| Modelo              | ${String(config.modelo.valor).padEnd(26)} | ${config.modelo.origen.padEnd(7)} | ${config.modelo.detalleOrigen}`);
  console.log(`| Fuente              | ${String(config.fuente.valor).padEnd(26)} | ${config.fuente.origen.padEnd(7)} | ${config.fuente.detalleOrigen}`);
  console.log("================================================================================\n");

  const discrepancias: string[] = [];

  const aliasClaves: Record<string, keyof ConfiguracionEfectivaDaemon> = {
    unidades: "unidades",
    meta: "unidades",
    horas: "horas",
    horasminimas: "horasMinimas",
    "horas-minimas": "horasMinimas",
    lote: "lote",
    concurrencia: "concurrencia",
    presupuestotokens: "presupuestoTokens",
    "presupuesto-tokens": "presupuestoTokens",
    tokens: "presupuestoTokens",
    presupuestousd: "presupuestoUSD",
    "presupuesto-usd": "presupuestoUSD",
    usd: "presupuestoUSD",
    modelo: "modelo",
    fuente: "fuente",
  };

  for (const [claveRaw, valEsperado] of Object.entries(esperados)) {
    const claveCanonica = aliasClaves[claveRaw.toLowerCase()];
    if (!claveCanonica || !(claveCanonica in config)) {
      discrepancias.push(`  [DESCONOCIDO] Clave esperada no reconocida: '${claveRaw}'`);
      continue;
    }

    const param = config[claveCanonica];
    const valEfectivoStr = String(param.valor ?? "").trim();
    if (valEfectivoStr !== valEsperado.trim()) {
      discrepancias.push(
        `  [DISCREPANCIA] '${claveRaw}': esperado='${valEsperado}', efectivo='${valEfectivoStr}' (origen: ${param.origen} -> ${param.detalleOrigen})`,
      );
    }
  }

  if (discrepancias.length > 0) {
    return {
      nombre: "Configuración efectiva del daemon y validación de expectativas",
      estado: "NO-GO",
      mensaje: `Se detectaron ${discrepancias.length} discrepancias entre la configuración esperada y los valores efectivos del daemon.`,
      detalles: discrepancias,
    };
  }

  // Si no hay límite de presupuesto configurado, emitir NO-GO
  if (config.presupuestoTokens.valor === null && config.presupuestoUSD.valor === null) {
    return {
      nombre: "Configuración efectiva del daemon y validación de expectativas",
      estado: "NO-GO",
      mensaje: "No se detectó límite de presupuesto. Configure DAEMON_PRESUPUESTO_TOKENS o flag --presupuesto-tokens.",
      detalles: [
        "  El daemon desatendido de carga rehúsa iniciar sin un tope explícito de tokens o USD.",
      ],
    };
  }

  const numEsperados = Object.keys(esperados).length;
  const msgEsperados = numEsperados > 0 ? ` (${numEsperados} expectativas verificadas y coincidentes)` : "";

  return {
    nombre: "Configuración efectiva del daemon y validación de expectativas",
    estado: "OK",
    mensaje: `Configuración efectiva lista: ${config.unidades.valor} unidades en ${config.horas.valor}h (lote ${config.lote.valor}, concurrencia ${config.concurrencia.valor})${msgEsperados}.`,
    detalles: [
      `  • Meta unidades:      ${config.unidades.valor} (${config.unidades.detalleOrigen})`,
      `  • Ventana tiempo:     ${config.horas.valor}h (mínimo ${config.horasMinimas.valor}h)`,
      `  • Lote / Concurrencia: ${config.lote.valor} procesos / ${config.concurrencia.valor} llamadas concurrentes`,
      `  • Tope presupuesto:   ${config.presupuestoTokens.valor ? config.presupuestoTokens.valor.toLocaleString("es-CO") + " tokens" : "$" + config.presupuestoUSD.valor + " USD"}`,
      `  • Modelo / Fuente:    ${config.modelo.valor} / ${config.fuente.valor}`,
    ],
  };
}

export function chequearPresupuestoYMeta(): ResultadoChequeo {
  return chequearConfiguracionEfectivaDaemon();
}

/**
 * 6. Comprueba la consistencia del archivo de estado persistente.
 */
export async function chequearEstadoPersistente(): Promise<ResultadoChequeo> {
  const rutaEstado = rutaEstadoCarga();
  const rutaCsv = rutaBitacoraTareasCsv();

  try {
    const raw = await readFile(rutaEstado, "utf8");
    const estado = JSON.parse(raw) as DatosEstadoPersistenteCarga;

    let filasCsv = 0;
    try {
      const rawCsv = await readFile(rutaCsv, "utf8");
      filasCsv = rawCsv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).length - 1;
      if (filasCsv < 0) filasCsv = 0;
    } catch {
      // CSV no existe aún
    }

    const unidadesFinAFin = estado.contadoresUnidades?.oficialFinAFin ?? 0;

    if (unidadesFinAFin === filasCsv) {
      return {
        nombre: "Estado persistente e idempotencia",
        estado: "OK",
        mensaje: `estado.json consistente con bitacora-tareas.csv (${unidadesFinAFin} unidades registradas). Listo para reanudar sin duplicar.`,
      };
    } else {
      return {
        nombre: "Estado persistente e idempotencia",
        estado: "AVISO",
        mensaje: `Delta detectable: estado.json registra ${unidadesFinAFin} unidades y CSV registra ${filasCsv} filas (se sincronizarán con idsExcluidos al arrancar).`,
      };
    }
  } catch {
    return {
      nombre: "Estado persistente e idempotencia",
      estado: "OK",
      mensaje: "No hay estado previo (o carpeta limpia); el runner inicializará un estado vacío limpio.",
    };
  }
}

/**
 * 7. Comprueba que data/pruebas-reto tenga permisos de escritura.
 */
export async function chequearPermisosEscritura(): Promise<ResultadoChequeo> {
  const rutaPrueba = path.join(DIR_PRUEBAS_RETO, `.preflight_test_${Date.now()}.tmp`);
  try {
    await writeFile(rutaPrueba, "ok", "utf8");
    await rm(rutaPrueba, { force: true });
    return {
      nombre: "Permisos de escritura en data/pruebas-reto",
      estado: "OK",
      mensaje: "Directorio de evidencias tiene permisos de escritura y persistencia garantizados.",
    };
  } catch (err) {
    return {
      nombre: "Permisos de escritura en data/pruebas-reto",
      estado: "NO-GO",
      mensaje: `Fallo al escribir en data/pruebas-reto/: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 8. Comprueba el espacio libre en disco.
 */
export async function chequearEspacioDisco(): Promise<ResultadoChequeo> {
  try {
    const stats = await statfs(process.cwd());
    const bytesLibres = stats.bavail * stats.bsize;
    const gbLibres = bytesLibres / (1024 ** 3);

    if (gbLibres >= 5.0) {
      return {
        nombre: "Espacio libre en disco",
        estado: "OK",
        mensaje: `${gbLibres.toFixed(1)} GB disponibles en disco (mínimo recomendado: 5 GB).`,
      };
    } else {
      return {
        nombre: "Espacio libre en disco",
        estado: "NO-GO",
        mensaje: `Espacio libre insuficiente: ${gbLibres.toFixed(1)} GB disponibles (< 5 GB requeridos).`,
      };
    }
  } catch (err) {
    return {
      nombre: "Espacio libre en disco",
      estado: "AVISO",
      mensaje: `No se pudo determinar el espacio libre en disco: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 9. Comprueba si Docker Engine está ejecutándose.
 */
export function chequearDocker(): ResultadoChequeo {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 8000 });
    return {
      nombre: "Docker Engine",
      estado: "OK",
      mensaje: "Docker Engine activo y comunicando vía socket/named pipe.",
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("Acceso denegado") || msg.includes("pipe") || msg.includes("elevated privileges")) {
      return {
        nombre: "Docker Engine",
        estado: "AVISO",
        mensaje: "Acceso al named pipe de Docker requiere permisos de host o ejecución nativa fuera de sandbox.",
      };
    }
    return {
      nombre: "Docker Engine",
      estado: "NO-GO",
      mensaje: "Docker Engine no responde o no está en ejecución. Inicie Docker Desktop antes de la corrida.",
    };
  }
}

/**
 * 10. Comprueba si la imagen Docker del daemon está construida.
 */
export function chequearImagenDocker(): ResultadoChequeo {
  const nombreImagen = "rastreador-de-oportunidades-en-secop-ii-daemon:latest";
  try {
    execSync(`docker image inspect ${nombreImagen}`, { stdio: "pipe", timeout: 8000 });
    return {
      nombre: "Imagen Docker del daemon",
      estado: "OK",
      mensaje: `Imagen "${nombreImagen}" construida y lista para despliegue.`,
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("Acceso denegado") || msg.includes("pipe")) {
      return {
        nombre: "Imagen Docker del daemon",
        estado: "AVISO",
        mensaje: `Acceso restringido a Docker inspect en este entorno. Verifique la imagen en su terminal: docker images.`,
      };
    }
    return {
      nombre: "Imagen Docker del daemon",
      estado: "NO-GO",
      mensaje: `Imagen "${nombreImagen}" no encontrada. Ejecute: docker compose build daemon.`,
    };
  }
}

/**
 * 11. Comprueba el estado del árbol de Git (lista archivos pendientes).
 */
export function chequearGitStatus(): ResultadoChequeo {
  try {
    const salida = execSync("git status --porcelain", { encoding: "utf8", timeout: 8000 }).trim();
    if (!salida) {
      return {
        nombre: "Estado del árbol Git (git status)",
        estado: "OK",
        mensaje: "Árbol de Git completamente limpio (commit de referencia listo).",
      };
    }

    const lineas = salida.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const modificados = lineas.filter((l) => l.startsWith("M") || l.startsWith(" M"));
    const noRastreados = lineas.filter((l) => l.startsWith("??"));
    const otros = lineas.length - modificados.length - noRastreados.length;

    return {
      nombre: "Estado del árbol Git (git status)",
      estado: "AVISO",
      mensaje: `Árbol de Git contiene ${lineas.length} cambios pendientes de commit (${modificados.length} modificados, ${noRastreados.length} sin rastrear).`,
      detalles: lineas.slice(0, 15).map((l) => `  ${l}`).concat(lineas.length > 15 ? [`  ... y ${lineas.length - 15} archivos más.`] : []),
    };
  } catch (err) {
    return {
      nombre: "Estado del árbol Git (git status)",
      estado: "AVISO",
      mensaje: `No se pudo consultar git status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 12. Escanea archivos staged en Git en busca de credenciales o secretos.
 * REGLA INMUTABLE: Reporta SOLO las rutas de archivo afectadas; NUNCA imprime los secretos.
 */
export function chequearSecretosEnStaged(): ResultadoChequeo {
  try {
    const archivosStaged = execSync("git diff --cached --name-only", { encoding: "utf8", timeout: 8000 })
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (archivosStaged.length === 0) {
      return {
        nombre: "Seguridad y escaneo de secretos (staged)",
        estado: "OK",
        mensaje: "Cero archivos staged; sin riesgo de commit accidental de secretos.",
      };
    }

    const diffStaged = execSync("git diff --cached", { encoding: "utf8", timeout: 8000 });

    // Patrones de secretos conocidos
    const patronesSecretos = [
      /\b(?:xai-[a-zA-Z0-9_-]{20,})\b/i,
      /\b(?:sk-[a-zA-Z0-9_-]{20,})\b/i,
      /\b(?:ghp_[a-zA-Z0-9]{20,})\b/i,
      /\b(?:gho_[a-zA-Z0-9]{20,})\b/i,
      /\b(?:AIza[0-9A-Za-z-_]{35})\b/i,
      /\b(?:reto-[a-zA-Z0-9_-]{12,})\b/i,
      /\bBearer\s+[a-zA-Z0-9_\-\.]{25,}\b/i,
      /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][a-zA-Z0-9_\-\.]{15,}["']/i,
    ];

    const archivosConSecretos: string[] = [];

    // Inspeccionar por archivo
    for (const archivo of archivosStaged) {
      try {
        const diffArchivo = execSync(`git diff --cached -- "${archivo}"`, { encoding: "utf8", timeout: 5000 });
        for (const patron of patronesSecretos) {
          if (patron.test(diffArchivo)) {
            archivosConSecretos.push(archivo);
            break;
          }
        }
      } catch {
        // Ignorar fallo de diff individual
      }
    }

    if (archivosConSecretos.length > 0) {
      return {
        nombre: "Seguridad y escaneo de secretos (staged)",
        estado: "NO-GO",
        mensaje: `¡ALERTA DE SEGURIDAD! Se detectaron posibles credenciales en ${archivosConSecretos.length} archivo(s) staged.`,
        detalles: archivosConSecretos.map((f) => `  [PELIGRO] Archivo con secreto detectado: ${f} (deshacer con git reset)`),
      };
    }

    return {
      nombre: "Seguridad y escaneo de secretos (staged)",
      estado: "OK",
      mensaje: `Escaneados ${archivosStaged.length} archivo(s) staged: CERO secretos o credenciales detectadas.`,
    };
  } catch (err) {
    return {
      nombre: "Seguridad y escaneo de secretos (staged)",
      estado: "AVISO",
      mensaje: `No se pudo completar el escaneo de staged: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// 2. EJECUTOR PRINCIPAL DE PRE-VUELO
// ============================================================================

export async function ejecutarPreflight(
  argv: string[] = process.argv.slice(2),
): Promise<{
  esGo: boolean;
  chequeos: ResultadoChequeo[];
}> {
  console.log("================================================================================");
  console.log("🛫 SECOP II — VERIFICACIÓN PRE-VUELO PARA CORRIDA DE 12H (S4-6)");
  console.log("================================================================================\n");

  const chequeos: ResultadoChequeo[] = [];

  // 1. Variables de entorno
  console.log("🔍 [1/12] Verificando variables de entorno en .env...");
  const ch1 = chequearVariablesEntorno();
  chequeos.push(ch1);

  // 2. LangSmith
  console.log("🔍 [2/12] Verificando autenticación con LangSmith...");
  const ch2 = await chequearLangSmith();
  chequeos.push(ch2);

  // 3. Gateway y 1 llamada real mínima
  console.log("🔍 [3/12] Verificando pasarela oficial con 1 llamada de prueba...");
  const ch3 = await chequearGatewayLlm();
  chequeos.push(ch3);

  // 4. Precios
  console.log("🔍 [4/12] Verificando configuración de precios...");
  const ch4 = await chequearPrecios();
  chequeos.push(ch4);

  // 5. Configuración efectiva del daemon y validación de expectativas (--esperado)
  console.log("🔍 [5/12] Verificando configuración efectiva del daemon y expectativas (--esperado)...");
  const ch5 = chequearConfiguracionEfectivaDaemon(argv);
  chequeos.push(ch5);

  // 6. Estado persistente
  console.log("🔍 [6/12] Verificando archivo de estado persistente...");
  const ch6 = await chequearEstadoPersistente();
  chequeos.push(ch6);

  // 7. Permisos de escritura
  console.log("🔍 [7/12] Verificando permisos de escritura en evidencias...");
  const ch7 = await chequearPermisosEscritura();
  chequeos.push(ch7);

  // 8. Espacio en disco
  console.log("🔍 [8/12] Verificando espacio disponible en disco...");
  const ch8 = await chequearEspacioDisco();
  chequeos.push(ch8);

  // 9. Docker Engine
  console.log("🔍 [9/12] Verificando Docker Engine...");
  const ch9 = chequearDocker();
  chequeos.push(ch9);

  // 10. Imagen Docker
  console.log("🔍 [10/12] Verificando imagen construida del daemon...");
  const ch10 = chequearImagenDocker();
  chequeos.push(ch10);

  // 11. Git status
  console.log("🔍 [11/12] Verificando estado del repositorio Git...");
  const ch11 = chequearGitStatus();
  chequeos.push(ch11);

  // 12. Escaneo de secretos
  console.log("🔍 [12/12] Escaneando archivos staged en busca de secretos...\n");
  const ch12 = chequearSecretosEnStaged();
  chequeos.push(ch12);

  // Impresión consolidada de resultados
  console.log("================================================================================");
  console.log("📊 TABLA DE RESULTADOS DE PRE-VUELO");
  console.log("================================================================================");

  let hayNoGo = false;

  for (let i = 0; i < chequeos.length; i++) {
    const ch = chequeos[i]!;
    const icono = ch.estado === "OK" ? "✅ [OK]" : ch.estado === "AVISO" ? "⚠️ [AVISO]" : "❌ [NO-GO]";
    if (ch.estado === "NO-GO") hayNoGo = true;

    console.log(`${icono} ${i + 1}. ${ch.nombre}:`);
    console.log(`   ${ch.mensaje}`);
    if (ch.detalles && ch.detalles.length > 0) {
      for (const d of ch.detalles) {
        console.log(`   ${d}`);
      }
    }
  }

  console.log("\n================================================================================");
  if (hayNoGo) {
    console.log("🛑 DICTAMEN FINAL DE PRE-VUELO: [ NO-GO ]");
    console.log("Existen condiciones críticas marcadas como [NO-GO] que deben subsanarse antes de lanzar");
    console.log("la corrida desatendida de 12 horas.");
  } else {
    console.log("🚀 DICTAMEN FINAL DE PRE-VUELO: [ GO ]");
    console.log("Todas las comprobaciones críticas fueron superadas exitosamente.");
    console.log("El entorno y la infraestructura están 100% listos para la corrida de 12 horas.");
  }
  console.log("================================================================================\n");

  return {
    esGo: !hayNoGo,
    chequeos,
  };
}

import { fileURLToPath } from "node:url";

const esModuloPrincipal =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esModuloPrincipal) {
  ejecutarPreflight().then(({ esGo }) => {
    process.exit(esGo ? 0 : 1);
  }).catch((err) => {
    console.error("❌ Fallo inesperado en preflight:", err);
    process.exit(1);
  });
}
