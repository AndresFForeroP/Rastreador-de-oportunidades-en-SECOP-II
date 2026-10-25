/**
 * Herramienta CLI: Evaluación automática de invariantes para Agentes 2 y 3 (S3-5).
 *
 * Evalúa invariantes que deben cumplirse siempre en las salidas de Agente 2 (resumidor)
 * y Agente 3 (documentos), sin ground truth de pliegos, más generación de la hoja
 * de revisión humana de fidelidad.
 *
 * Reglas de negocio:
 * - Selección determinista de N casos mediante semilla (prioriza "si", luego "dudoso").
 * - Ejecución por el camino de producción (resumirProcesosAptos y armarDocumentosParaProcesos).
 * - Registro en el libro mayor como tipo "evaluacion", modo "evaluacion", con tokens y USD.
 * - Prueba de 3 casos forzando la ruta del agente (--siempre-agente).
 * - No modifica prompts ni código para hacer pasar los chequeos; reporta fallos reales.
 *
 * Uso:
 *   pnpm evaluar:agentes [--n=10] [--semilla=42]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODEL_NAME } from "../llm.js";
import {
  calcularCostoEstimado,
  finalizarEjecucion,
  iniciarEjecucion,
} from "../pruebas/registro-ejecuciones.js";
import {
  dirResultadoEvaluacionAgentes,
  rutaCasosSinEtiquetar,
  rutaClavesPrivadas,
} from "../pruebas/rutas.js";
import {
  resumirProcesosAptos,
  type EntregaResumenes,
  type ItemResumenEntrega,
} from "../pipeline/resumir-procesos.js";
import {
  armarDocumentosParaProcesos,
  type EntregaDocumentos,
  type ProcesoConDocumentos,
} from "../pipeline/armar-documentos.js";
import {
  registrarCandidatosEnFicha,
  type FichaProceso,
} from "../herramientas/obtener-ficha-proceso.js";
import {
  cargarCatalogoDocumentos,
  type ItemCatalogoDocumento,
} from "../herramientas/armar-lista-documentos.js";
import {
  AVISO_FIJO_ORIENTATIVO,
  type ItemDocumento,
} from "../agentes/documentos.js";
import {
  aCandidato,
  parsearNumero,
  parsearValor,
  type Candidato,
} from "../filtro/prefiltro.js";
import type { FilaSecop } from "../datos/socrata.js";
import type { CasoSinEtiquetar, ClavePrivadaCaso } from "./evaluacion-preparar.js";

// ============================================================================
// CONSTANTES Y PATRONES DE REVISIÓN
// ============================================================================

/** Patrones documentados de frases que afirman requisitos habilitantes como hechos */
export const PATRONES_REQUISITOS_HABILITANTES = [
  { nombre: "experiencia_minima", regex: /experiencia\s+m[ií]nima/i },
  { nombre: "indicadores_financieros", regex: /indicador(?:es)?(?:\s+(?:financiero|de\s+capacidad|de\s+liquidez|de\s+endeudamiento))?/i },
  { nombre: "se_exige", regex: /se\s+exige/i },
  { nombre: "debe_acreditar", regex: /debe\s+acreditar/i },
  { nombre: "debe_cumplir", regex: /debe\s+cumplir/i },
  { nombre: "requisitos_habilitantes", regex: /requisito(?:s)?\s+habilitante(?:s)?/i },
  { nombre: "capacidad_financiera_residual", regex: /capacidad\s+(?:financiera|residual|organizacional)/i },
  { nombre: "k_contratacion", regex: /k\s+de\s+contrataci[oó]n/i },
  { nombre: "patrimonio_liquido", regex: /patrimonio\s+l[ií]quido/i },
  { nombre: "capital_de_trabajo", regex: /capital\s+de\s+trabajo/i },
  { nombre: "nivel_endeudamiento", regex: /nivel\s+de\s+endeudamiento/i },
  { nombre: "certificacion_iso", regex: /(?:certificaci[oó]n|certificado)\s+iso/i },
];

/** Patrones de frases que afirman haber leído el pliego oficial */
export const PATRONES_AFIRMA_LEER_PLIEGO = [
  /(?:he|hemos|se ha|se)\s+(?:le[ií]do|revisado)\s+el\s+pliego/i,
  /\b(?:le[ií]|le[ií]mos)\s+el\s+pliego/i,
  /\btras\s+(?:la\s+)?lectura\s+del\s+pliego/i,
  /\bde\s+la\s+lectura\s+del\s+pliego\s+se\s+(?:desprende|concluye|evidencia|observa)/i,
  /seg[uú]n\s+(?:el\s+)?pliego\s+de\s+condiciones\s+(?:le[ií]do|analizado|revisado)/i,
  /conforme\s+al\s+pliego\s+(?:de\s+condiciones\s+)?le[ií]do/i,
  /\bal\s+leer\s+el\s+pliego/i,
  /revisando\s+el\s+pliego\s+oficial\s+se\s+constata/i,
];

// ============================================================================
// GENERADOR PSEUDOALEATORIO DETERMINISTA (Mulberry32)
// ============================================================================

function crearPrng(seed: number) {
  let s = seed >>> 0;
  return function () {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function barajarArray<T>(arr: T[], prng: () => number): T[] {
  const copia = arr.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

// ============================================================================
// TIPOS DE RESULTADOS DE INVARIANTES
// ============================================================================

export interface ResultadoInvariante {
  invariante: string;
  pasa: boolean;
  evidencia?: string;
  flagRevisionHumana?: boolean;
}

export interface InvariantesAgente2Caso {
  casoNumero: number;
  id: string;
  invariantes: {
    fichaVsDataset: ResultadoInvariante;
    cifras6Digitos: ResultadoInvariante;
    basadoEnClavesReales: ResultadoInvariante;
    sinAfirmarRequisitosHabilitantes: ResultadoInvariante;
    verificarEnPliegoNoVacio: ResultadoInvariante;
    nuncaAfirmaLeerPliego: ResultadoInvariante;
  };
}

export interface InvariantesAgente3Caso {
  casoNumero: number;
  id: string;
  invariantes: {
    itemsCatalogoOAnexos: ResultadoInvariante;
    sinDuplicados: ResultadoInvariante;
    nadaObligatorioSinNegacion: ResultadoInvariante;
    avisoFijoPresente: ResultadoInvariante;
    respaldoLegalSoloNoNull: ResultadoInvariante;
    sinAnexosFraseExacta: ResultadoInvariante;
  };
}

interface ArgumentosCLI {
  n: number;
  semilla: number;
}

function parsearArgumentos(): ArgumentosCLI {
  const args = process.argv.slice(2);
  let n = 10;
  let semilla = 42;

  for (const arg of args) {
    if (arg.startsWith("--n=")) {
      const v = Number.parseInt(arg.slice(4), 10);
      if (!Number.isNaN(v) && v > 0) n = v;
    } else if (arg.startsWith("--semilla=")) {
      const v = Number.parseInt(arg.slice(10), 10);
      if (!Number.isNaN(v)) semilla = v;
    }
  }

  return { n, semilla };
}

// ============================================================================
// CONVERSIÓN Y COMPARACIÓN DE CAMPOS
// ============================================================================

function normalizarTexto(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function convertirASnapshotCandidato(snapshot: any): Candidato {
  if (snapshot.id && typeof snapshot.id === "string") {
    return snapshot as Candidato;
  }
  return aCandidato(snapshot as FilaSecop);
}

// ============================================================================
// EVALUADORES DE INVARIANTES AGENTE 2
// ============================================================================

function evaluarInvariantesAgente2(
  casoNumero: number,
  candidato: Candidato,
  snapshotRaw: any,
  itemResumen: ItemResumenEntrega,
): InvariantesAgente2Caso {
  const ficha = itemResumen.ficha;
  const id = candidato.id;

  // 1. Campos numéricos y fechas iguales al dataset
  // Campos a comparar: valorCOP, fechaLimiteOfertas, duracion.cantidad, lotes, entidad
  const datasetValor =
    snapshotRaw.valor !== undefined
      ? snapshotRaw.valor
      : parsearValor(snapshotRaw.precio_base);

  const datasetDeadline =
    snapshotRaw.fechaLimiteOfertas !== undefined
      ? snapshotRaw.fechaLimiteOfertas
      : (typeof snapshotRaw.fecha_de_recepcion_de === "string" ? snapshotRaw.fecha_de_recepcion_de.trim() : null);

  const datasetDuracion =
    snapshotRaw.duracion !== undefined && typeof snapshotRaw.duracion === "number"
      ? snapshotRaw.duracion
      : parsearNumero(snapshotRaw.duracion);

  const datasetLotes =
    snapshotRaw.numeroLotes !== undefined && typeof snapshotRaw.numeroLotes === "number"
      ? snapshotRaw.numeroLotes
      : parsearNumero(snapshotRaw.numero_de_lotes);

  const datasetEntidad =
    typeof snapshotRaw.entidad === "string" ? snapshotRaw.entidad.trim() : "";

  const fallosFicha: string[] = [];

  if (ficha.valorCOP !== datasetValor) {
    fallosFicha.push(`valorCOP: ficha=${ficha.valorCOP} vs dataset=${datasetValor}`);
  }
  if (ficha.fechaLimiteOfertas !== datasetDeadline) {
    fallosFicha.push(`fechaLimiteOfertas: ficha="${ficha.fechaLimiteOfertas}" vs dataset="${datasetDeadline}"`);
  }
  if (ficha.duracion.cantidad !== datasetDuracion) {
    fallosFicha.push(`duracion: ficha=${ficha.duracion.cantidad} vs dataset=${datasetDuracion}`);
  }
  if (ficha.lotes !== datasetLotes) {
    fallosFicha.push(`lotes: ficha=${ficha.lotes} vs dataset=${datasetLotes}`);
  }
  if (ficha.entidad !== datasetEntidad) {
    fallosFicha.push(`entidad: ficha="${ficha.entidad}" vs dataset="${datasetEntidad}"`);
  }

  const fichaVsDataset: ResultadoInvariante = {
    invariante: "ficha_igual_al_dataset",
    pasa: fallosFicha.length === 0,
    evidencia: fallosFicha.length > 0 ? fallosFicha.join("; ") : undefined,
  };

  // 2. Cifras de 6+ dígitos respaldadas en ficha o descripción
  const textoGenerado = [
    itemResumen.resumen,
    ...itemResumen.alertasParaPyme.map((a) => a.alerta),
    ...itemResumen.verificarEnElPliego,
    itemResumen.comentarioAnexos ?? "",
  ].join(" ");

  const regexNumeros = /(?:\$?\s*)?(\b\d{1,3}(?:[.,']\d{3}){1,}\b|\b\d{6,}\b)/g;
  const textoFichaCompleto = JSON.stringify(ficha);
  const digitosFicha = textoFichaCompleto.replace(/\D/g, " ");
  const textoDescripcion = (candidato.descripcion || "") + " " + (candidato.nombre || "");
  const digitosDescripcion = textoDescripcion.replace(/\D/g, " ");

  const coincidencias = textoGenerado.match(regexNumeros) ?? [];
  const noRespaldadas: string[] = [];

  for (const match of coincidencias) {
    const soloDigitos = match.replace(/\D/g, "");
    if (soloDigitos.length >= 6) {
      const existeEnFicha =
        textoFichaCompleto.includes(match) ||
        textoFichaCompleto.includes(soloDigitos) ||
        digitosFicha.includes(soloDigitos);

      const existeEnDescripcion =
        textoDescripcion.includes(match) ||
        textoDescripcion.includes(soloDigitos) ||
        digitosDescripcion.includes(soloDigitos);

      if (!existeEnFicha && !existeEnDescripcion) {
        noRespaldadas.push(`${match} (${soloDigitos})`);
      }
    }
  }

  const cifras6Digitos: ResultadoInvariante = {
    invariante: "cifras_6_digitos_respaldadas",
    pasa: noRespaldadas.length === 0,
    evidencia: noRespaldadas.length > 0 ? `Cifras sin respaldo: ${noRespaldadas.join(", ")}` : undefined,
  };

  // 3. Cada basadoEn es una clave real de la ficha
  const clavesFicha = new Set(Object.keys(ficha));
  const basadoEnInvalidos: string[] = [];

  for (const alerta of itemResumen.alertasParaPyme) {
    if (!clavesFicha.has(alerta.basadoEn)) {
      basadoEnInvalidos.push(alerta.basadoEn);
    }
  }

  const basadoEnClavesReales: ResultadoInvariante = {
    invariante: "basado_en_claves_reales",
    pasa: basadoEnInvalidos.length === 0,
    evidencia:
      basadoEnInvalidos.length > 0
        ? `Campos basadoEn inválidos: ${basadoEnInvalidos.join(", ")}`
        : undefined,
  };

  // 4. Ninguna frase afirma requisito habilitante como hecho (señalados para revisión humana)
  // Se evalúa en resumen y alertasParaPyme (donde no debe haber afirmaciones de hecho)
  const frasesAAnalizar = [
    itemResumen.resumen,
    ...itemResumen.alertasParaPyme.map((a) => a.alerta),
  ].flatMap((texto) => texto.split(/[.?!]\s+/));

  const frasesFlagged: Array<{ frase: string; patron: string }> = [];

  for (const frase of frasesAAnalizar) {
    const fTrim = frase.trim();
    if (!fTrim) continue;
    for (const pat of PATRONES_REQUISITOS_HABILITANTES) {
      if (pat.regex.test(fTrim)) {
        frasesFlagged.push({ frase: fTrim, patron: pat.nombre });
      }
    }
  }

  const sinAfirmarRequisitosHabilitantes: ResultadoInvariante = {
    invariante: "sin_afirmar_requisitos_habilitantes",
    pasa: true, // No es falla automática, se señala para revisión humana
    flagRevisionHumana: frasesFlagged.length > 0,
    evidencia:
      frasesFlagged.length > 0
        ? `Señalado para revisión humana (${frasesFlagged.length} coincidencias): ` +
          frasesFlagged.map((f) => `[${f.patron}] "${f.frase}"`).join(" | ")
        : undefined,
  };

  // 5. verificarEnElPliego no está vacío
  const tieneVerificaciones =
    Array.isArray(itemResumen.verificarEnElPliego) && itemResumen.verificarEnElPliego.length > 0;

  const verificarEnPliegoNoVacio: ResultadoInvariante = {
    invariante: "verificar_en_pliego_no_vacio",
    pasa: tieneVerificaciones,
    evidencia: tieneVerificaciones
      ? undefined
      : "El arreglo verificarEnElPliego está vacío o no es un arreglo válido.",
  };

  // 6. El resumen nunca afirma haber leído el pliego
  const frasesPliego = [
    itemResumen.resumen,
    ...itemResumen.alertasParaPyme.map((a) => a.alerta),
    ...itemResumen.verificarEnElPliego,
    itemResumen.comentarioAnexos ?? "",
  ];

  const afirmaPliego: string[] = [];
  for (const texto of frasesPliego) {
    const oraciones = texto.split(/[.?!;]\s+/);
    for (const oracion of oraciones) {
      const oNorm = normalizarTexto(oracion);
      if (
        oNorm.includes("no sustituye la lectura del pliego") ||
        oNorm.includes("ni que sustituyan la lectura del pliego") ||
        oNorm.includes("no reemplaza la lectura del pliego") ||
        oNorm.includes("no se afirma haber leido")
      ) {
        continue;
      }
      for (const pat of PATRONES_AFIRMA_LEER_PLIEGO) {
        if (pat.test(oracion)) {
          afirmaPliego.push(`"${oracion.trim()}"`);
        }
      }
    }
  }

  const nuncaAfirmaLeerPliego: ResultadoInvariante = {
    invariante: "nunca_afirma_leer_pliego",
    pasa: afirmaPliego.length === 0,
    evidencia:
      afirmaPliego.length > 0
        ? `El texto parece sugerir lectura del pliego: ${afirmaPliego.join(" | ")}`
        : undefined,
  };

  return {
    casoNumero,
    id,
    invariantes: {
      fichaVsDataset,
      cifras6Digitos,
      basadoEnClavesReales,
      sinAfirmarRequisitosHabilitantes,
      verificarEnPliegoNoVacio,
      nuncaAfirmaLeerPliego,
    },
  };
}

// ============================================================================
// EVALUADORES DE INVARIANTES AGENTE 3
// ============================================================================

function evaluarInvariantesAgente3(
  casoNumero: number,
  procesoConDocs: ProcesoConDocumentos,
  ficha: FichaProceso,
  catalogoItems: ItemCatalogoDocumento[],
): InvariantesAgente3Caso {
  const id = procesoConDocs.id;
  const items = procesoConDocs.items;
  const catalogoIds = new Set(catalogoItems.map((c) => c.id));
  const anexosLista = ficha.anexos?.lista ?? [];
  const nombresAnexosNorm = new Set(anexosLista.map((a) => normalizarTexto(a.nombre)));
  const nombresAnexosSinExt = new Set(
    anexosLista.map((a) => normalizarTexto(a.nombre.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "))),
  );

  // 1. Ítems provienen únicamente del catálogo o de anexos reales de la ficha
  const itemsInvalidos: string[] = [];
  for (const item of items) {
    if (item.base === "nombre_de_anexo") {
      const fundNorm = normalizarTexto(item.fundamento);
      const nomNorm = normalizarTexto(item.nombre);
      const coincideAnexo =
        nombresAnexosNorm.has(fundNorm) ||
        nombresAnexosNorm.has(nomNorm) ||
        nombresAnexosSinExt.has(nomNorm) ||
        anexosLista.some((a) => normalizarTexto(a.nombre).includes(fundNorm));

      if (!coincideAnexo && item.catalogoId && !catalogoIds.has(item.catalogoId)) {
        itemsInvalidos.push(`[anexo no encontrado en ficha]: "${item.nombre}" (${item.fundamento})`);
      }
    } else if (item.base === "catalogo_con_emisor" || item.base === "catalogo_sin_emisor") {
      if (!item.catalogoId || !catalogoIds.has(item.catalogoId)) {
        itemsInvalidos.push(`[catalogoId desconocido]: "${item.nombre}" (id: ${item.catalogoId})`);
      }
    } else {
      itemsInvalidos.push(`[base desconocida]: "${item.nombre}" (${(item as any).base})`);
    }
  }

  const itemsCatalogoOAnexos: ResultadoInvariante = {
    invariante: "items_solo_catalogo_o_anexos",
    pasa: itemsInvalidos.length === 0,
    evidencia: itemsInvalidos.length > 0 ? itemsInvalidos.join("; ") : undefined,
  };

  // 2. Sin ítems duplicados
  const nombresVistos = new Set<string>();
  const catalogIdsVistos = new Set<string>();
  const duplicados: string[] = [];

  for (const item of items) {
    const nomNorm = normalizarTexto(item.nombre);
    if (nombresVistos.has(nomNorm)) {
      duplicados.push(`Nombre duplicado: "${item.nombre}"`);
    } else {
      nombresVistos.add(nomNorm);
    }

    if (item.catalogoId) {
      if (catalogIdsVistos.has(item.catalogoId)) {
        duplicados.push(`catalogoId duplicado: "${item.catalogoId}"`);
      } else {
        catalogIdsVistos.add(item.catalogoId);
      }
    }
  }

  const sinDuplicados: ResultadoInvariante = {
    invariante: "sin_duplicados",
    pasa: duplicados.length === 0,
    evidencia: duplicados.length > 0 ? duplicados.join("; ") : undefined,
  };

  // 3. Nada marcado obligatorio o requerido excepto dentro de negaciones
  const regexObligatorio = /\b(obligatori[oa]s?|requerid[oa]s?|mandatori[oa]s?)\b/gi;

  function esNegacion(oracion: string): boolean {
    const oNorm = normalizarTexto(oracion);
    return (
      oNorm.includes("no de por obligatori") ||
      oNorm.includes("no asuma") ||
      oNorm.includes("nada de lo anterior") ||
      oNorm.includes("nada es obligatori") ||
      oNorm.includes("no es asesoria legal") ||
      oNorm.includes("no es obligatori") ||
      oNorm.includes("no son obligatori") ||
      oNorm.includes("sin ser obligatori") ||
      oNorm.includes("no se marca") ||
      oNorm.includes("no constituye") ||
      oNorm.includes("puede exigirse segun el pliego; verificar") ||
      /\bno\b[\s\S]*?\b(obligatori|requerid)/i.test(oNorm) ||
      /\bnada\b[\s\S]*?\b(obligatori|requerid)/i.test(oNorm) ||
      /\bsin\b[\s\S]*?\b(obligatori|requerid)/i.test(oNorm) ||
      /\bni\b[\s\S]*?\b(obligatori|requerid)/i.test(oNorm)
    );
  }

  const afirmacionesObligatorias: string[] = [];

  // Excluir títulos de anexos provenientes de la entidad (donde la palabra puede ser el nombre del archivo)
  const textosAExaminar: string[] = [
    ...items.map((i) =>
      i.base === "nombre_de_anexo"
        ? `${i.condicion ?? ""} - ${i.observaciones ?? ""}`
        : `${i.nombre} - ${i.condicion ?? ""} - ${i.observaciones ?? ""}`,
    ),
    procesoConDocs.observacionGeneral ?? "",
  ];

  for (const texto of textosAExaminar) {
    const matches = texto.match(regexObligatorio);
    if (matches && matches.length > 0) {
      // Verificar si la oración en la que aparece está cubierta por negación
      const oraciones = texto.split(/[.?!;]\s+/);
      for (const oracion of oraciones) {
        if (regexObligatorio.test(oracion) && !esNegacion(oracion)) {
          afirmacionesObligatorias.push(`"${oracion.trim()}"`);
        }
      }
    }
  }

  const nadaObligatorioSinNegacion: ResultadoInvariante = {
    invariante: "nada_marcado_obligatorio_sin_negacion",
    pasa: afirmacionesObligatorias.length === 0,
    evidencia:
      afirmacionesObligatorias.length > 0
        ? `Se detectaron afirmaciones sin negación: ${afirmacionesObligatorias.join(" | ")}`
        : undefined,
  };

  // 4. Aviso fijo presente
  const avisoPresente =
    procesoConDocs.avisoOficial === AVISO_FIJO_ORIENTATIVO ||
    procesoConDocs.advertencias.includes(AVISO_FIJO_ORIENTATIVO);

  const avisoFijoPresente: ResultadoInvariante = {
    invariante: "aviso_fijo_presente",
    pasa: avisoPresente,
    evidencia: avisoPresente ? undefined : `Falta el aviso obligatorio: "${AVISO_FIJO_ORIENTATIVO}"`,
  };

  // 5. respaldoLegal se muestra solo cuando no es null
  const textoCompletoDocs = JSON.stringify(procesoConDocs);
  const muestraRespaldoNull =
    textoCompletoDocs.includes('"respaldoLegal":null') ||
    textoCompletoDocs.includes("respaldo legal: null") ||
    textoCompletoDocs.includes("Respaldo Legal: null");

  const respaldoLegalSoloNoNull: ResultadoInvariante = {
    invariante: "respaldo_legal_solo_cuando_no_es_null",
    pasa: !muestraRespaldoNull,
    evidencia: muestraRespaldoNull
      ? "Se encontró mención textual explícita de respaldoLegal como null."
      : undefined,
  };

  // 6. Cuando la ficha no tiene anexos, dice "sin anexos indexados aún" y nunca que "no hay anexos"
  let pasaSinAnexos = true;
  const fallosSinAnexos: string[] = [];

  if (anexosLista.length === 0) {
    const textoDocTotal = [
      procesoConDocs.observacionGeneral ?? "",
      ...procesoConDocs.advertencias,
    ].join(" ");

    const contieneFraseExacta = normalizarTexto(textoDocTotal).includes(
      normalizarTexto("sin anexos indexados aun"),
    );

    if (!contieneFraseExacta) {
      fallosSinAnexos.push('No contiene la frase requerida "sin anexos indexados aún".');
      pasaSinAnexos = false;
    }

    const regexNiegaAnexos = /\b(no\s+hay\s+anexos|no\s+tiene\s+anexos|no\s+cuenta\s+con\s+anexos|carece\s+de\s+anexos)\b/i;
    if (regexNiegaAnexos.test(textoDocTotal)) {
      fallosSinAnexos.push('Afirma falsamente que el proceso "no hay anexos" / "no tiene anexos".');
      pasaSinAnexos = false;
    }
  }

  const sinAnexosFraseExacta: ResultadoInvariante = {
    invariante: "sin_anexos_frase_exacta",
    pasa: pasaSinAnexos,
    evidencia: fallosSinAnexos.length > 0 ? fallosSinAnexos.join("; ") : undefined,
  };

  return {
    casoNumero,
    id,
    invariantes: {
      itemsCatalogoOAnexos,
      sinDuplicados,
      nadaObligatorioSinNegacion,
      avisoFijoPresente,
      respaldoLegalSoloNoNull,
      sinAnexosFraseExacta,
    },
  };
}

// ============================================================================
// CONSTRUCCIÓN DE HOJA DE REVISIÓN HUMANA (5 CASOS)
// ============================================================================

function construirHojaRevisionHumana(
  casosMuestra: Array<{
    casoNumero: number;
    candidato: Candidato;
    resumen: ItemResumenEntrega;
  }>,
): string {
  const lineas: string[] = [];

  lineas.push("# Hoja de Revisión Humana de Fidelidad — Agente 2 (Resumidor)\n");
  lineas.push("> **OBJETIVO**: Evaluar cualitativamente la fidelidad del resumen generado frente a los datos oficiales de la ficha técnica.");
  lineas.push(">\n> **Instrucciones para el evaluador humano**:");
  lineas.push("> Califica cada caso con una escala de **1 a 3**:");
  lineas.push("> - `[1]`: **Baja fidelidad** (inconsistencias con la ficha, distorsión del objeto o alucinación de cifras/hechos).");
  lineas.push("> - `[2]`: **Fidelidad media** (fiel en lo general, pero con omisiones o redacción ambigua).");
  lineas.push("> - `[3]`: **Alta fidelidad** (resumen riguroso, honesto, sintetiza el objeto y señala alertas legítimas basadas en los datos).");
  lineas.push(">\n> Completa el campo `- Calificación: [ ]` con `1`, `2` o `3`, y añade observaciones breves en `- Comentarios:`.");
  lineas.push("> Luego ejecuta `pnpm evaluar:hoja` para consolidar y ver el promedio final.\n");
  lineas.push("---\n");

  for (let i = 0; i < casosMuestra.length; i++) {
    const item = casosMuestra[i];
    const c = item.candidato;
    const r = item.resumen;
    const f = r.ficha;

    const valorFormateado =
      f.valorCOP !== null
        ? `$ ${f.valorCOP.toLocaleString("es-CO")} COP`
        : "No definido";

    const anexosTotal = f.anexos?.total ?? 0;
    const anexosTexto =
      anexosTotal > 0
        ? `${anexosTotal} archivo(s) (${f.anexos.lista.map((a) => a.nombre).slice(0, 3).join(", ")}${anexosTotal > 3 ? "..." : ""})`
        : "Sin anexos indexados aún";

    lineas.push(`### Caso [${item.casoNumero}] ${c.id}\n`);
    lineas.push(`#### Ficha Oficial del Proceso (Datos Abiertos)`);
    lineas.push(`- **Nombre / Objeto**: ${f.nombre}`);
    lineas.push(`- **Entidad Compradora**: ${f.entidad}`);
    lineas.push(`- **Ubicación**: ${f.ciudad}, ${f.departamento}`);
    lineas.push(`- **Modalidad**: ${f.modalidad}`);
    lineas.push(`- **Tipo de Contrato**: ${f.tipoDeContrato}`);
    lineas.push(`- **Presupuesto Oficial**: ${valorFormateado}`);
    lineas.push(`- **Plazo de Ofertas**: ${f.fechaLimiteOfertas ?? "No indicado"} (${f.diasRestantes ?? "N/A"} días restantes)`);
    lineas.push(`- **Duración Estimada**: ${f.duracion.cantidad ?? "N/A"} ${f.duracion.unidad ?? ""}`);
    lineas.push(`- **Lotes**: ${f.lotes !== null && f.lotes > 0 ? `${f.lotes} lote(s)` : "Sin lotes (oferta global)"}`);
    lineas.push(`- **Anexos Indexados**: ${anexosTexto}`);
    lineas.push(`- **Descripción Oficial**: ${f.descripcion.slice(0, 400)}${f.descripcion.length > 400 ? "..." : ""}\n`);

    lineas.push(`#### Salida Generada por el Agente 2`);
    lineas.push(`- **Resumen**:`);
    lineas.push(`  > ${r.resumen}\n`);

    lineas.push(`- **Alertas para la Pyme**:`);
    if (r.alertasParaPyme.length === 0) {
      lineas.push(`  *(Sin alertas generadas)*`);
    } else {
      for (const al of r.alertasParaPyme) {
        lineas.push(`  - ⚠️ ${al.alerta} *(Basado en: \`${al.basadoEn}\`)*`);
      }
    }
    lineas.push(``);

    lineas.push(`- **Puntos a Verificar en el Pliego**:`);
    for (const v of r.verificarEnElPliego) {
      lineas.push(`  - 🔍 ${v}`);
    }
    lineas.push(``);

    lineas.push(`- **Comentario sobre Anexos**: ${r.comentarioAnexos ?? "N/A"}\n`);

    lineas.push(`#### Evaluación Humana de Fidelidad`);
    lineas.push(`- Calificación: [ ]`);
    lineas.push(`- Comentarios: \n`);
    lineas.push(`---\n`);
  }

  return lineas.join("\n");
}

// ============================================================================
// FUNCIÓN PRINCIPAL DE EVALUACIÓN
// ============================================================================

export async function evaluarAgentes(): Promise<void> {
  const config = parsearArgumentos();

  console.log("================================================================================");
  console.log("🔬 EVALUACIÓN AUTOMÁTICA DE INVARIANTES PARA AGENTES 2 Y 3 (S3-5)");
  console.log(`Muestra: ${config.n} casos | Semilla: ${config.semilla}`);
  console.log("================================================================================\n");

  // 1. Cargar conjunto etiquetado y claves privadas
  const rawCasos = await readFile(rutaCasosSinEtiquetar(), "utf8");
  const casos: CasoSinEtiquetar[] = JSON.parse(rawCasos);

  const rawClaves = await readFile(rutaClavesPrivadas(), "utf8");
  const claves: Record<string, ClavePrivadaCaso> = JSON.parse(rawClaves);

  // 2. Filtrar casos etiquetados por el usuario: primero "si", luego "dudoso"
  const poolSi = casos.filter((c) => (c.etiqueta as string).trim().toLowerCase() === "si");
  const poolDudoso = casos.filter((c) => (c.etiqueta as string).trim().toLowerCase() === "dudoso");

  console.log(`📊 Universo de casos etiquetados por el usuario:`);
  console.log(`   • Etiquetados 'si':     ${poolSi.length}`);
  console.log(`   • Etiquetados 'dudoso': ${poolDudoso.length}`);

  const prng = crearPrng(config.semilla);

  // Orden inicial estable por número de caso
  poolSi.sort((a, b) => a.caso - b.caso);
  poolDudoso.sort((a, b) => a.caso - b.caso);

  const poolSiBarajado = barajarArray(poolSi, prng);
  const poolDudosoBarajado = barajarArray(poolDudoso, prng);

  const seleccionados: CasoSinEtiquetar[] = [];

  if (config.n <= poolSiBarajado.length) {
    seleccionados.push(...poolSiBarajado.slice(0, config.n));
  } else {
    seleccionados.push(...poolSiBarajado);
    const faltantes = config.n - poolSiBarajado.length;
    seleccionados.push(...poolDudosoBarajado.slice(0, faltantes));
  }

  console.log(`\n🎯 Casos seleccionados determinísticamente (${seleccionados.length}):`);
  console.log(
    `   Casos #${seleccionados.map((s) => s.caso).join(", #")}\n`,
  );

  // 3. Estructurar candidatos verificados
  const candidatosSeleccionados: Array<{
    caso: CasoSinEtiquetar;
    candidato: Candidato;
    snapshotRaw: any;
  }> = [];

  for (const s of seleccionados) {
    const clave = claves[String(s.caso)];
    if (!clave) {
      throw new Error(`No se encontró clave privada para el caso #${s.caso}`);
    }
    const cand = convertirASnapshotCandidato(clave.snapshotCompleto);
    candidatosSeleccionados.push({
      caso: s,
      candidato: cand,
      snapshotRaw: clave.snapshotCompleto,
    });
  }

  // 4. Iniciar ejecución en libro mayor
  const ejecucionId = await iniciarEjecucion({
    tipo: "evaluacion",
    modo: "evaluacion",
    fechaDatos: "benchmark-humano-s3-5",
    parametros: {
      n: config.n,
      semilla: config.semilla,
      casos: seleccionados.map((s) => s.caso),
    },
  });

  const now = new Date();
  const fechaIso = now.toISOString().slice(0, 10);
  const timestampStr = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const carpetaFechaEval = `${fechaIso}-eval-agentes`;
  const carpetaFechaSiempre = `${fechaIso}-eval-siempre`;

  // Registrar candidatos en memoria para que la tool obtener_ficha_proceso los resuelva al instante
  registrarCandidatosEnFicha(candidatosSeleccionados.map((c) => c.candidato));

  // 5. Preparar archivo de entrada para el pipeline de producción (data/entregas/<carpeta>/aptos.json)
  const dirEntregasEval = path.resolve(process.cwd(), "data", "entregas", carpetaFechaEval);
  await mkdir(dirEntregasEval, { recursive: true });

  const aptosSimulados = {
    fecha: carpetaFechaEval,
    modo: "evaluacion",
    totalCandidatos: candidatosSeleccionados.length,
    paginasProcesadas: 1,
    totalPaginasDisponibles: 1,
    estadisticasClasificacion: {
      si: candidatosSeleccionados.length,
      no: 0,
      dudoso: 0,
      total: candidatosSeleccionados.length,
    },
    tokens: { entrada: 0, salida: 0, total: 0 },
    resultados: candidatosSeleccionados.map((c) => ({
      id: c.candidato.id,
      aptoPyme: "si" as const,
      categoriaObjeto: "Evaluación S3-5",
      razon: "Caso benchmark humano",
      senales: [],
      proceso: c.candidato,
    })),
  };

  await writeFile(
    path.join(dirEntregasEval, "aptos.json"),
    JSON.stringify(aptosSimulados, null, 2),
    "utf8",
  );

  // 6. Ejecución de producción del Agente 2 (resumidor)
  console.log("🤖 [1/3] Ejecutando Agente 2 (resumidor) a través de la función de producción...");
  const entregaResumenes: EntregaResumenes = await resumirProcesosAptos({
    fecha: carpetaFechaEval,
    completo: true,
    concurrencia: 2,
  });

  // 7. Ejecución de producción del Agente 3 (documentos)
  console.log("\n📑 [2/3] Ejecutando Agente 3 (documentos) a través de la función de producción...");
  const entregaDocumentos: EntregaDocumentos = await armarDocumentosParaProcesos({
    fecha: carpetaFechaEval,
    completo: true,
    concurrencia: 2,
  });

  // 8. Ejecución adicional: 3 casos forzando el agente (--siempre-agente)
  console.log("\n⚡ [3/3] Ejecutando 3 casos con la ruta forzada del modelo (--siempre-agente)...");
  const tresPrimerosResumenes = entregaResumenes.resumenes.slice(0, 3);
  const dirEntregasSiempre = path.resolve(process.cwd(), "data", "entregas", carpetaFechaSiempre);
  await mkdir(dirEntregasSiempre, { recursive: true });

  const entregaResumenesSiempre: EntregaResumenes = {
    fecha: carpetaFechaSiempre,
    modo: "prueba",
    totalAptosEncontrados: tresPrimerosResumenes.length,
    totalProcesados: tresPrimerosResumenes.length,
    tokens: { entrada: 0, salida: 0, total: 0 },
    resumenes: tresPrimerosResumenes,
  };

  await writeFile(
    path.join(dirEntregasSiempre, "resumenes.json"),
    JSON.stringify(entregaResumenesSiempre, null, 2),
    "utf8",
  );

  const entregaDocSiempre: EntregaDocumentos = await armarDocumentosParaProcesos({
    fecha: carpetaFechaSiempre,
    completo: true,
    siempreAgente: true,
    concurrencia: 2,
  });

  // 9. Cargar catálogo oficial de documentos para validar Agente 3
  const catalogoOficial = cargarCatalogoDocumentos();

  // 10. Auditoría de invariantes por caso
  console.log("\n🔍 Verificando invariantes sobre los resultados obtenidos...");

  const resultadosAgente2: InvariantesAgente2Caso[] = [];
  const resultadosAgente3: InvariantesAgente3Caso[] = [];
  const mapaResumenesPorId = new Map<string, ItemResumenEntrega>(
    entregaResumenes.resumenes.map((r) => [r.id, r]),
  );
  const mapaDocsPorId = new Map<string, ProcesoConDocumentos>(
    entregaDocumentos.documentosPorProceso.map((d) => [d.id, d]),
  );

  for (const item of candidatosSeleccionados) {
    const resItem = mapaResumenesPorId.get(item.candidato.id);
    const docItem = mapaDocsPorId.get(item.candidato.id);

    if (resItem) {
      const invA2 = evaluarInvariantesAgente2(item.caso.caso, item.candidato, item.snapshotRaw, resItem);
      resultadosAgente2.push(invA2);
    }

    if (docItem && resItem) {
      const invA3 = evaluarInvariantesAgente3(item.caso.caso, docItem, resItem.ficha, catalogoOficial);
      resultadosAgente3.push(invA3);
    }
  }

  // Auditoría invariantes para los 3 casos de siempre-agente
  const resultadosAgente3Siempre: InvariantesAgente3Caso[] = [];
  for (const docSiempre of entregaDocSiempre.documentosPorProceso) {
    const resItem = mapaResumenesPorId.get(docSiempre.id);
    if (resItem) {
      const itemCand = candidatosSeleccionados.find((c) => c.candidato.id === docSiempre.id);
      const invA3 = evaluarInvariantesAgente3(
        itemCand?.caso.caso ?? 0,
        docSiempre,
        resItem.ficha,
        catalogoOficial,
      );
      resultadosAgente3Siempre.push(invA3);
    }
  }

  // 11. Contabilidad de tokens y costo acumulado
  const tokensTotalEntrada =
    entregaResumenes.tokens.entrada +
    entregaDocumentos.tokens.entrada +
    entregaDocSiempre.tokens.entrada;

  const tokensTotalSalida =
    entregaResumenes.tokens.salida +
    entregaDocumentos.tokens.salida +
    entregaDocSiempre.tokens.salida;

  const tokensTotalFacturados =
    entregaResumenes.tokens.total +
    entregaDocumentos.tokens.total +
    entregaDocSiempre.tokens.total;

  const costoUSD = await calcularCostoEstimado(MODEL_NAME, tokensTotalEntrada, tokensTotalSalida);
  const costoA2 = await calcularCostoEstimado(MODEL_NAME, entregaResumenes.tokens.entrada, entregaResumenes.tokens.salida);
  const costoA3 = await calcularCostoEstimado(MODEL_NAME, entregaDocumentos.tokens.entrada, entregaDocumentos.tokens.salida);
  const costoA3Siempre = await calcularCostoEstimado(MODEL_NAME, entregaDocSiempre.tokens.entrada, entregaDocSiempre.tokens.salida);

  await finalizarEjecucion(ejecucionId, {
    estado: "ok",
    tokens: {
      entrada: tokensTotalEntrada,
      salida: tokensTotalSalida,
      razonamiento: null,
      total: tokensTotalFacturados,
    },
    costoUSD,
  });

  // 12. Construcción de métricas agregadas por invariante
  function calcularTasa(
    items: Array<{ invariantes: Record<string, ResultadoInvariante> }>,
    clave: string,
  ): { total: number; pasan: number; tasa: number; fallos: Array<{ id: string; evidencia?: string }> } {
    let pasan = 0;
    const fallos: Array<{ id: string; evidencia?: string }> = [];

    for (const item of items) {
      const inv = (item.invariantes as any)[clave] as ResultadoInvariante;
      if (inv && inv.pasa) {
        pasan++;
      } else if (inv) {
        fallos.push({ id: (item as any).id, evidencia: inv.evidencia });
      }
    }

    return {
      total: items.length,
      pasan,
      tasa: items.length > 0 ? (pasan / items.length) * 100 : 0,
      fallos,
    };
  }

  const invA2Ficha = calcularTasa(resultadosAgente2, "fichaVsDataset");
  const invA2Cifras = calcularTasa(resultadosAgente2, "cifras6Digitos");
  const invA2BasadoEn = calcularTasa(resultadosAgente2, "basadoEnClavesReales");
  const invA2Verificar = calcularTasa(resultadosAgente2, "verificarEnPliegoNoVacio");
  const invA2NoPliego = calcularTasa(resultadosAgente2, "nuncaAfirmaLeerPliego");

  // Señalados para revisión humana (Agente 2)
  const senaladosRevisionHumana: Array<{ casoNumero: number; id: string; evidencia?: string }> = [];
  for (const r of resultadosAgente2) {
    if (r.invariantes.sinAfirmarRequisitosHabilitantes.flagRevisionHumana) {
      senaladosRevisionHumana.push({
        casoNumero: r.casoNumero,
        id: r.id,
        evidencia: r.invariantes.sinAfirmarRequisitosHabilitantes.evidencia,
      });
    }
  }

  // Agente 3 métricas
  const invA3Items = calcularTasa(resultadosAgente3, "itemsCatalogoOAnexos");
  const invA3Duplicados = calcularTasa(resultadosAgente3, "sinDuplicados");
  const invA3Obligatorio = calcularTasa(resultadosAgente3, "nadaObligatorioSinNegacion");
  const invA3Aviso = calcularTasa(resultadosAgente3, "avisoFijoPresente");
  const invA3Respaldo = calcularTasa(resultadosAgente3, "respaldoLegalSoloNoNull");
  const invA3SinAnexos = calcularTasa(resultadosAgente3, "sinAnexosFraseExacta");

  // Siempre agente (3 casos)
  const invA3SiempreItems = calcularTasa(resultadosAgente3Siempre, "itemsCatalogoOAnexos");
  const invA3SiempreDuplicados = calcularTasa(resultadosAgente3Siempre, "sinDuplicados");
  const invA3SiempreObligatorio = calcularTasa(resultadosAgente3Siempre, "nadaObligatorioSinNegacion");

  // 13. Persistencia de reportes en data/pruebas-reto/evaluacion/resultados/<timestamp>-agentes/
  const dirResultados = dirResultadoEvaluacionAgentes(timestampStr);
  await mkdir(dirResultados, { recursive: true });

  // A. Generar hoja-revision-humana.md (muestra de 5 casos)
  const muestra5 = candidatosSeleccionados.slice(0, 5).map((c) => ({
    casoNumero: c.caso.caso,
    candidato: c.candidato,
    resumen: mapaResumenesPorId.get(c.candidato.id)!,
  }));

  const contenidoHoja = construirHojaRevisionHumana(muestra5);
  const rutaHoja = path.join(dirResultados, "hoja-revision-humana.md");
  await writeFile(rutaHoja, contenidoHoja, "utf8");

  // B. Generar resultados.json
  const resultadosJson = {
    ejecucionId,
    timestamp: now.toISOString(),
    parametros: {
      n: config.n,
      semilla: config.semilla,
      casosSeleccionados: seleccionados.map((s) => s.caso),
    },
    costos: {
      tokensEntrada: tokensTotalEntrada,
      tokensSalida: tokensTotalSalida,
      tokensTotal: tokensTotalFacturados,
      costoUSD,
      costoFormateado:
        costoUSD !== null ? `$ ${costoUSD.toFixed(4)} USD` : "precio no configurado",
    },
    agente2: {
      resumenEjecucion: {
        totalProcesados: entregaResumenes.totalProcesados,
        tokens: entregaResumenes.tokens,
      },
      invariantes: {
        fichaVsDataset: invA2Ficha,
        cifras6Digitos: invA2Cifras,
        basadoEnClavesReales: invA2BasadoEn,
        verificarEnPliegoNoVacio: invA2Verificar,
        nuncaAfirmaLeerPliego: invA2NoPliego,
        senaladosRevisionHumana: {
          total: senaladosRevisionHumana.length,
          casos: senaladosRevisionHumana,
        },
      },
      casos: resultadosAgente2,
    },
    agente3: {
      resumenEjecucion: {
        totalProcesados: entregaDocumentos.totalProcesados,
        tokens: entregaDocumentos.tokens,
      },
      invariantes: {
        itemsCatalogoOAnexos: invA3Items,
        sinDuplicados: invA3Duplicados,
        nadaObligatorioSinNegacion: invA3Obligatorio,
        avisoFijoPresente: invA3Aviso,
        respaldoLegalSoloNoNull: invA3Respaldo,
        sinAnexosFraseExacta: invA3SinAnexos,
      },
      casos: resultadosAgente3,
      siempreAgente3Casos: {
        tokens: entregaDocSiempre.tokens,
        invariantes: {
          itemsCatalogoOAnexos: invA3SiempreItems,
          sinDuplicados: invA3SiempreDuplicados,
          nadaObligatorioSinNegacion: invA3SiempreObligatorio,
        },
        casos: resultadosAgente3Siempre,
      },
    },
  };

  const rutaJson = path.join(dirResultados, "resultados.json");
  await writeFile(rutaJson, JSON.stringify(resultadosJson, null, 2), "utf8");

  // C. Generar resumen.md
  let md = `# Resumen de Evaluación de Invariantes: Agente 2 y Agente 3 (S3-5)\n\n`;
  md += `> **Ejecución**: \`${ejecucionId}\` | **Fecha**: \`${now.toISOString()}\`\n`;
  md += `> **Muestra**: ${config.n} casos reales | **Semilla determinista**: \`${config.semilla}\`\n`;
  md += `> **Costo estimado**: **${costoUSD !== null ? `$ ${costoUSD.toFixed(4)} USD` : "precio no configurado"}** (${tokensTotalFacturados.toLocaleString("es-CO")} tokens facturados)\n\n`;

  md += `## 1. Invariantes del Agente 2 ("resumidor")\n\n`;
  md += `| Invariante | Descripción | Total | Pasan | Tasa Éxito | Estado |\n`;
  md += `|---|---|:---:|:---:|:---:|:---:|\n`;
  md += `| **Ficha vs Dataset** | Campos numéricos y fechas iguales al dataset (\`valorCOP\`, \`deadline\`, \`duracion\`, \`lotes\`, \`entidad\`) | ${invA2Ficha.total} | ${invA2Ficha.pasan} | **${invA2Ficha.tasa.toFixed(1)}%** | ${invA2Ficha.pasan === invA2Ficha.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Cifras de 6+ Dígitos** | Cifras en texto del modelo existen en ficha o descripción | ${invA2Cifras.total} | ${invA2Cifras.pasan} | **${invA2Cifras.tasa.toFixed(1)}%** | ${invA2Cifras.pasan === invA2Cifras.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Claves de basadoEn** | Todo \`basadoEn\` es una clave real de \`FichaProceso\` | ${invA2BasadoEn.total} | ${invA2BasadoEn.pasan} | **${invA2BasadoEn.tasa.toFixed(1)}%** | ${invA2BasadoEn.pasan === invA2BasadoEn.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Verificaciones en Pliego** | El arreglo \`verificarEnElPliego\` nunca está vacío | ${invA2Verificar.total} | ${invA2Verificar.pasan} | **${invA2Verificar.tasa.toFixed(1)}%** | ${invA2Verificar.pasan === invA2Verificar.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **No Afirma Leer Pliego** | El resumen jamás declara haber leído el pliego de condiciones | ${invA2NoPliego.total} | ${invA2NoPliego.pasan} | **${invA2NoPliego.tasa.toFixed(1)}%** | ${invA2NoPliego.pasan === invA2NoPliego.total ? "✅ PASS" : "❌ FAIL"} |\n\n`;

  md += `### Casos Señalados para Revisión Humana (Patrones de Requisitos Habilitantes)\n`;
  md += `> Regla S3-5: La detección de patrones de requisitos habilitantes en frases no constituye falla automática, sino que se remite a revisión humana.\n\n`;
  if (senaladosRevisionHumana.length === 0) {
    md += `*Ninguna frase del Agente 2 activó los patrones de requisitos habilitantes.*\n\n`;
  } else {
    md += `| Caso # | Proceso ID | Evidencia Detectada |\n`;
    md += `|:---:|---|---|\n`;
    for (const s of senaladosRevisionHumana) {
      md += `| ${s.casoNumero} | \`${s.id}\` | ${s.evidencia ?? "Patrón detectado"} |\n`;
    }
    md += `\n`;
  }

  md += `## 2. Invariantes del Agente 3 ("documentos")\n\n`;
  md += `| Invariante | Descripción | Total | Pasan | Tasa Éxito | Estado |\n`;
  md += `|---|---|:---:|:---:|:---:|:---:|\n`;
  md += `| **Origen de Ítems** | Provienen únicamente del catálogo o de anexos reales indexados | ${invA3Items.total} | ${invA3Items.pasan} | **${invA3Items.tasa.toFixed(1)}%** | ${invA3Items.pasan === invA3Items.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Sin Duplicados** | No existen ítems duplicados por nombre ni por ID de catálogo | ${invA3Duplicados.total} | ${invA3Duplicados.pasan} | **${invA3Duplicados.tasa.toFixed(1)}%** | ${invA3Duplicados.pasan === invA3Duplicados.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Nada Obligatorio sin Negación** | Ningún requisito marcado obligatorio salvo dentro de negación explícita | ${invA3Obligatorio.total} | ${invA3Obligatorio.pasan} | **${invA3Obligatorio.tasa.toFixed(1)}%** | ${invA3Obligatorio.pasan === invA3Obligatorio.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Aviso Fijo Orientativo** | Presencia obligatoria del aviso oficial \`"${AVISO_FIJO_ORIENTATIVO}"\` | ${invA3Aviso.total} | ${invA3Aviso.pasan} | **${invA3Aviso.tasa.toFixed(1)}%** | ${invA3Aviso.pasan === invA3Aviso.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Respaldo Legal No Null** | \`respaldoLegal\` solo se muestra si no es null (jamás imprime null) | ${invA3Respaldo.total} | ${invA3Respaldo.pasan} | **${invA3Respaldo.tasa.toFixed(1)}%** | ${invA3Respaldo.pasan === invA3Respaldo.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Sin Anexos: Frase Exacta** | Si no hay anexos, dice *"sin anexos indexados aún"* y jamás niega existencia | ${invA3SinAnexos.total} | ${invA3SinAnexos.pasan} | **${invA3SinAnexos.tasa.toFixed(1)}%** | ${invA3SinAnexos.pasan === invA3SinAnexos.total ? "✅ PASS" : "❌ FAIL"} |\n\n`;

  md += `### Prueba Forzando el Agente (--siempre-agente, 3 casos)\n`;
  md += `| Invariante | Total | Pasan | Tasa Éxito | Estado |\n`;
  md += `|---|:---:|:---:|:---:|:---:|\n`;
  md += `| **Origen de Ítems (con LLM)** | ${invA3SiempreItems.total} | ${invA3SiempreItems.pasan} | **${invA3SiempreItems.tasa.toFixed(1)}%** | ${invA3SiempreItems.pasan === invA3SiempreItems.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Sin Duplicados (con LLM)** | ${invA3SiempreDuplicados.total} | ${invA3SiempreDuplicados.pasan} | **${invA3SiempreDuplicados.tasa.toFixed(1)}%** | ${invA3SiempreDuplicados.pasan === invA3SiempreDuplicados.total ? "✅ PASS" : "❌ FAIL"} |\n`;
  md += `| **Nada Obligatorio sin Negación (con LLM)** | ${invA3SiempreObligatorio.total} | ${invA3SiempreObligatorio.pasan} | **${invA3SiempreObligatorio.tasa.toFixed(1)}%** | ${invA3SiempreObligatorio.pasan === invA3SiempreObligatorio.total ? "✅ PASS" : "❌ FAIL"} |\n\n`;

  // Detalle de fallos si hubo alguno
  const todosLosFallos: Array<{ agente: string; invariante: string; id: string; evidencia?: string }> = [];
  for (const f of invA2Ficha.fallos) todosLosFallos.push({ agente: "Agente 2", invariante: "Ficha vs Dataset", ...f });
  for (const f of invA2Cifras.fallos) todosLosFallos.push({ agente: "Agente 2", invariante: "Cifras 6+ dígitos", ...f });
  for (const f of invA2BasadoEn.fallos) todosLosFallos.push({ agente: "Agente 2", invariante: "basadoEn claves", ...f });
  for (const f of invA2Verificar.fallos) todosLosFallos.push({ agente: "Agente 2", invariante: "Verificar en pliego no vacío", ...f });
  for (const f of invA2NoPliego.fallos) todosLosFallos.push({ agente: "Agente 2", invariante: "No afirma leer pliego", ...f });
  for (const f of invA3Items.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Origen de ítems", ...f });
  for (const f of invA3Duplicados.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Sin duplicados", ...f });
  for (const f of invA3Obligatorio.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Nada obligatorio sin negación", ...f });
  for (const f of invA3Aviso.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Aviso fijo presente", ...f });
  for (const f of invA3Respaldo.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Respaldo legal no null", ...f });
  for (const f of invA3SinAnexos.fallos) todosLosFallos.push({ agente: "Agente 3", invariante: "Sin anexos frase exacta", ...f });

  md += `## 3. Detalle de Fallos e Inconsistencias Registradas\n\n`;
  if (todosLosFallos.length === 0) {
    md += `✅ **CERO FALLOS**: El 100% de los invariantes automatizados se cumplieron estrictamente en todos los casos evaluados.\n\n`;
  } else {
    md += `| Agente | Invariante | Proceso ID | Evidencia del Fallo |\n`;
    md += `|---|---|---|---|\n`;
    for (const f of todosLosFallos) {
      md += `| ${f.agente} | ${f.invariante} | \`${f.id}\` | ${f.evidencia ?? "Discrepancia detectada"} |\n`;
    }
    md += `\n`;
  }

  md += `## 4. Desglose de Consumo de Tokens y Costos\n\n`;
  md += `| Tarea / Fase | Tokens Entrada | Tokens Salida Visible | Tokens Facturados (Total) | Costo Estimado |\n`;
  md += `|---|:---:|:---:|:---:|:---:|\n`;
  md += `| **Agente 2 (resumidor)** | ${entregaResumenes.tokens.entrada.toLocaleString("es-CO")} | ${entregaResumenes.tokens.salida.toLocaleString("es-CO")} | ${entregaResumenes.tokens.total.toLocaleString("es-CO")} | ${costoA2 !== null ? `$ ${costoA2.toFixed(4)} USD` : "precio no configurado"} |\n`;
  md += `| **Agente 3 (documentos - estándar)** | ${entregaDocumentos.tokens.entrada.toLocaleString("es-CO")} | ${entregaDocumentos.tokens.salida.toLocaleString("es-CO")} | ${entregaDocumentos.tokens.total.toLocaleString("es-CO")} | ${costoA3 !== null ? `$ ${costoA3.toFixed(4)} USD` : "precio no configurado"} |\n`;
  md += `| **Agente 3 (--siempre-agente, 3 casos)** | ${entregaDocSiempre.tokens.entrada.toLocaleString("es-CO")} | ${entregaDocSiempre.tokens.salida.toLocaleString("es-CO")} | ${entregaDocSiempre.tokens.total.toLocaleString("es-CO")} | ${costoA3Siempre !== null ? `$ ${costoA3Siempre.toFixed(4)} USD` : "precio no configurado"} |\n`;
  md += `| **TOTAL CONSOLIDADO** | **${tokensTotalEntrada.toLocaleString("es-CO")}** | **${tokensTotalSalida.toLocaleString("es-CO")}** | **${tokensTotalFacturados.toLocaleString("es-CO")}** | **${costoUSD !== null ? `$ ${costoUSD.toFixed(4)} USD` : "precio no configurado"}** |\n\n`;

  md += `## 5. Lo que NO se pudo verificar (Limitaciones Objetivas)\n\n`;
  md += `1. **Contenido interno del pliego oficial de condiciones**: El portal transaccional de SECOP II (\`community.secop.gov.co\`) se encuentra tras Google ReCaptcha y no es accesible por scraping automatizado. No es posible contrastar si los requisitos exigidos en el pliego real difieren de lo indexado en datos abiertos.\n`;
  md += `2. **Validez jurídica en tiempo real de los anexos indexados**: El dataset abierto \`dmgg-8hin\` refleja nombres de archivos con posible desfase de indexación de hasta 24-48 horas respecto al momento de publicación del proceso.\n`;
  md += `3. **Completitud exhaustiva de la lista de documentos**: La lista orientativa se deriva del catálogo general de referencia y de los nombres de anexos conocidos; los pliegos particulares pueden contener exigencias adicionales no determinables sin lectura humana directa.\n`;

  const rutaResumen = path.join(dirResultados, "resumen.md");
  await writeFile(rutaResumen, md, "utf8");

  console.log("\n================================================================================");
  console.log("✅ EVALUACIÓN DE AGENTES 2 Y 3 COMPLETADA EXITOSAMENTE");
  console.log("================================================================================");
  console.log(`📁 Evidencias guardadas en: ${path.relative(process.cwd(), dirResultados)}`);
  console.log(`   • ${path.relative(process.cwd(), rutaResumen)}`);
  console.log(`   • ${path.relative(process.cwd(), rutaJson)}`);
  console.log(`   • ${path.relative(process.cwd(), rutaHoja)}`);
  console.log(`\n💰 Costo Total de la Evaluación: ${costoUSD !== null ? `$ ${costoUSD.toFixed(4)} USD` : "precio no configurado"}`);
  console.log(`📊 Tokens Facturados:            ${tokensTotalFacturados.toLocaleString("es-CO")} tokens\n`);

  // Imprimir resumen en consola
  console.log(md);
}

if (process.argv[1]?.endsWith("evaluar-agentes.ts")) {
  evaluarAgentes().catch((err) => {
    console.error("Error en evaluar-agentes:", err);
    process.exit(1);
  });
}
