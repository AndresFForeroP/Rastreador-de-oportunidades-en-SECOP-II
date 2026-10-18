/**
 * Generador de reportes consolidados (JSON y Markdown) para la entrega diaria.
 *
 * Estructura estricta:
 * 1. Título con fecha y modo (aviso prominente si es prueba).
 * 2. Estadísticas de ejecución (descarga, descartes, clasificación, errores, tokens).
 * 3. Sección por proceso ordenado por días restantes ascendente con ficha verificada,
 *    enlaces a anexos (sin descargar), resumen, alertas, puntos a verificar y documentos.
 * 4. Pie de página con limitaciones honestas y aviso fijo obligatorio.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResultadoProcesoApto } from "../pipeline/filtrar-pymes.js";
import type { ItemResumenEntrega } from "../pipeline/resumir-procesos.js";
import type { ProcesoConDocumentos } from "../pipeline/armar-documentos.js";

export interface DatosReporte {
  fecha: string;
  modo: "hoy" | "prueba";
  fechaReferencia: string;
  totalDescargados: number;
  descartadosPorRegla: Record<string, number>;
  totalCandidatos: number;
  conteoClasificacion: {
    si: number;
    no: number;
    dudoso: number;
  };
  totalProcesados: number;
  errores: string[];
  tokensTotales: {
    entrada: number;
    salida: number;
    total: number;
  };
  procesos: Array<{
    id: string;
    diasRestantes: number | null;
    ficha: {
      nombre: string;
      entidad: string;
      departamento: string;
      ciudad: string;
      modalidad: string;
      tipoDeContrato: string;
      valorCOP: number | null;
      fechaLimiteOfertas: string | null;
      duracion: { cantidad: number | null; unidad: string | null };
      lotes: number | null;
      urlProceso: string | null;
    };
    anexosUrls: Array<{ nombre: string; urlDescarga: string }>;
    resumen: string;
    alertasParaPyme: Array<{ alerta: string; basadoEn: string }>;
    verificarEnElPliego: string[];
    documentos: ProcesoConDocumentos["items"];
    observacionGeneralDoc: string | null;
    advertenciasDoc: string[];
  }>;
}

export function formatearMonedaCOP(valor: number | null): string {
  if (valor === null || valor === undefined || Number.isNaN(valor)) {
    return "No definido / Desconocido";
  }
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(valor);
}

export function construirMarkdownReporte(datos: DatosReporte): string {
  const lineas: string[] = [];

  // 1. Título y encabezado
  lineas.push(`# Reporte Diario de Oportunidades SECOP II — ${datos.fecha}\n`);

  if (datos.modo === "prueba") {
    lineas.push(
      `> ⚠️ **MODO PRUEBA (HISTÓRICO)**: Ejecución sobre la fecha de prueba \`${datos.fecha}\`. Instante de referencia temporal: \`${datos.fechaReferencia}\` (inicio del día a las 00:00:00 UTC-5). Los datos provienen de la caché local para no consumir créditos de descarga.\n`,
    );
  } else {
    lineas.push(
      `> ℹ️ **EJECUCIÓN EN PRODUCCIÓN**: Procesos competitivos publicados **HOY** en SECOP II. Instante de referencia: \`${datos.fechaReferencia}\`.\n`,
    );
  }

  // 2. Estadísticas de ejecución
  lineas.push(`## 1. Estadísticas de la Jornada\n`);
  lineas.push(`| Métrica | Cantidad |`);
  lineas.push(`|---|:---:|`);
  lineas.push(`| **Total procesos publicados descargados** | ${datos.totalDescargados.toLocaleString("es-CO")} |`);
  lineas.push(`| **Candidatos pre-filtrados viables** | ${datos.totalCandidatos.toLocaleString("es-CO")} |`);
  lineas.push(`| **Clasificados APTO PYME (SÍ)** | ${datos.conteoClasificacion.si} |`);
  lineas.push(`| **Clasificados DUDOSO** | ${datos.conteoClasificacion.dudoso} |`);
  lineas.push(`| **Clasificados NO APTOS** | ${datos.conteoClasificacion.no} |`);
  lineas.push(`| **Procesos estructurados con ficha y documentos** | ${datos.totalProcesados} |`);
  lineas.push(`| **Errores aislados registrados** | ${datos.errores.length} |`);
  lineas.push(`| **Tokens consumidos (Entrada)** | ${datos.tokensTotales.entrada.toLocaleString("es-CO")} |`);
  lineas.push(`| **Tokens consumidos (Salida visible)** | ${datos.tokensTotales.salida.toLocaleString("es-CO")} |`);
  lineas.push(`| **Tokens totales facturados (incluye razonamiento)** | **${datos.tokensTotales.total.toLocaleString("es-CO")}** |\n`);

  lineas.push(`### Desglose de Descarte del Pre-filtro (Código)`);
  lineas.push(`| Regla de Descarte | Procesos Excluidos |`);
  lineas.push(`|---|:---:|`);
  for (const [regla, cant] of Object.entries(datos.descartadosPorRegla)) {
    lineas.push(`| \`${regla}\` | ${cant.toLocaleString("es-CO")} |`);
  }
  lineas.push(`\n---\n`);

  // Caso sin procesos
  if (datos.procesos.length === 0) {
    lineas.push(`## 2. Oportunidades Identificadas\n`);
    lineas.push(`No se encontraron procesos competitivos aptos para pymes en la fecha consultada (${datos.fecha}).\n`);
  } else {
    // 3. Procesos ordenados por diasRestantes ascendente
    lineas.push(`## 2. Oportunidades Estructuradas para Pymes (${datos.procesos.length} procesos)\n`);
    lineas.push(`*Ordenados por urgencia de presentación de ofertas (días restantes ascendente).*\n`);

    for (let i = 0; i < datos.procesos.length; i++) {
      const p = datos.procesos[i];
      const diasTexto =
        p.diasRestantes !== null
          ? p.diasRestantes <= 0
            ? "⚠️ **HOY / VENCE INMEDIATAMENTE**"
            : `⏳ **${p.diasRestantes} día(s)**`
          : "No especificado";

      const duracionTexto =
        p.ficha.duracion.cantidad !== null
          ? `${p.ficha.duracion.cantidad} ${p.ficha.duracion.unidad ?? ""}`.trim()
          : "No definida";

      const lotesTexto =
        p.ficha.lotes !== null && p.ficha.lotes > 0 ? `${p.ficha.lotes} lote(s)` : "Sin lotes (oferta global)";

      lineas.push(`### ${i + 1}. [${p.id}] ${p.ficha.nombre}\n`);
      lineas.push(`- **Entidad Compradora**: ${p.ficha.entidad}`);
      lineas.push(`- **Ubicación**: ${p.ficha.ciudad}, ${p.ficha.departamento}`);
      lineas.push(`- **Modalidad**: ${p.ficha.modalidad}`);
      lineas.push(`- **Tipo de Contrato**: ${p.ficha.tipoDeContrato}`);
      lineas.push(`- **Presupuesto Oficial**: **${formatearMonedaCOP(p.ficha.valorCOP)}**`);
      lineas.push(`- **Plazo de Ofertas**: ${p.ficha.fechaLimiteOfertas ?? "No indicado"} (${diasTexto})`);
      lineas.push(`- **Duración Estimada**: ${duracionTexto}`);
      lineas.push(`- **Estructura de Lotes**: ${lotesTexto}`);
      lineas.push(
        `- **Enlace Oficial en SECOP II**: [Ver proceso en SECOP II](${p.ficha.urlProceso ?? "#"})\n`,
      );

      // Anexos con enlaces de descarga
      lineas.push(`#### Archivos Anexos Indexados en SECOP II`);
      if (p.anexosUrls.length === 0) {
        lineas.push(`*Sin archivos anexos indexados aún en el dataset \`dmgg-8hin\` de SECOP II.*\n`);
      } else {
        lineas.push(`*(Enlaces directos a datos abiertos de SECOP II; ningún archivo fue descargado por el bot):*`);
        for (const anx of p.anexosUrls) {
          lineas.push(`- 📄 [${anx.nombre}](${anx.urlDescarga})`);
        }
        lineas.push(``);
      }

      // Resumen del objeto contractual (Agente 2)
      lineas.push(`#### Resumen del Objeto (Agente 2 — Datos Abiertos)`);
      lineas.push(`${p.resumen}\n`);

      // Alertas
      lineas.push(`#### Alertas Técnicas para la Pyme`);
      if (p.alertasParaPyme.length === 0) {
        lineas.push(`*No se detectaron alertas críticas en los metadatos.*\n`);
      } else {
        for (const al of p.alertasParaPyme) {
          lineas.push(`- ⚠️ **${al.alerta}** *(Basado en campo: \`${al.basadoEn}\`)*`);
        }
        lineas.push(``);
      }

      // Puntos a verificar
      lineas.push(`#### Puntos Clave a Verificar en el Pliego Oficial`);
      for (const ver of p.verificarEnElPliego) {
        lineas.push(`- 🔍 ${ver}`);
      }
      lineas.push(``);

      // Documentos (Agente 3)
      lineas.push(`#### Lista Orientativa de Documentos Habilitantes`);
      lineas.push(`> ℹ️ *Aviso obligatorio: Lista orientativa: confirme siempre en el pliego oficial.*\n`);

      for (const doc of p.documentos) {
        const badge =
          doc.base === "catalogo_con_emisor"
            ? "🏛️ `[Catálogo con Emisor]`"
            : doc.base === "catalogo_sin_emisor"
              ? "📋 `[Catálogo sin Emisor]`"
              : "📎 `[Anexo SECOP II]`";

        const tagCat = doc.catalogoId ? ` *(ID: \`${doc.catalogoId}\`)*` : "";
        lineas.push(`- ${badge} **${doc.nombre}**${tagCat}`);
        lineas.push(`  - **Fundamento / Emisor**: ${doc.fundamento}`);
        if (doc.condicion) lineas.push(`  - **Condición**: ${doc.condicion}`);
        if (doc.expide) lineas.push(`  - **Expide**: ${doc.expide}`);
        if (doc.observaciones) lineas.push(`  - **Observación**: ${doc.observaciones}`);
      }
      lineas.push(``);

      if (p.observacionGeneralDoc) {
        lineas.push(`> 💬 **Recomendación orientativa**: ${p.observacionGeneralDoc}\n`);
      }

      if (p.advertenciasDoc.length > 0) {
        lineas.push(`**Advertencias del proceso**:`);
        for (const adv of p.advertenciasDoc) {
          lineas.push(`- ⚠️ ${adv}`);
        }
        lineas.push(``);
      }

      lineas.push(`---\n`);
    }
  }

  // 4. Footer con limitaciones honestas
  lineas.push(`## 3. Limitaciones del Sistema y Marco Legal\n`);
  lineas.push(
    `1. **El pliego oficial NO fue leído**: Las páginas de detalle de proceso de SECOP II (\`community.secop.gov.co\`) se encuentran bajo protección de Google ReCaptcha. El sistema analiza metadatos oficiales y nombres de archivos indexados, jamás el contenido interno de pliegos.\n` +
      `2. **Desfase de anexos**: Los archivos se consultan desde el dataset abierto \`dmgg-8hin\` de datos.gov.co, el cual presenta un desfase habitual de indexación respecto al día de publicación.\n` +
      `3. **Carácter no vinculante**: Este reporte es una herramienta de orientación para pymes y **NO constituye asesoría legal ni garantiza la completitud de la oferta**. La pyme oferente tiene la carga exclusiva de consultar y verificar los pliegos oficiales y adendas en SECOP II.\n` +
      `4. **Aviso legal inmutable**: *Lista orientativa: confirme siempre en el pliego oficial.*`,
  );

  return lineas.join("\n");
}

export async function guardarReportes(datos: DatosReporte): Promise<{ rutaJson: string; rutaMd: string }> {
  const dirReportes = path.resolve(process.cwd(), "data", "reportes");
  await mkdir(dirReportes, { recursive: true });

  const rutaJson = path.join(dirReportes, `${datos.fecha}.json`);
  const rutaMd = path.join(dirReportes, `${datos.fecha}.md`);

  const contenidoMd = construirMarkdownReporte(datos);

  await writeFile(rutaJson, JSON.stringify(datos, null, 2), "utf8");
  await writeFile(rutaMd, contenidoMd, "utf8");

  console.log(`[reporte] Reporte JSON guardado en: ${rutaJson}`);
  console.log(`[reporte] Reporte Markdown guardado en: ${rutaMd}`);

  return { rutaJson, rutaMd };
}
