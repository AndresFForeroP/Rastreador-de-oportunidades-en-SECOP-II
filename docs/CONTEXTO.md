# CONTEXTO — Rastreador de oportunidades en SECOP II

> **DOCUMENTO CENTRAL DE CONTEXTO**: Cualquier agente de programación que trabaje en este repositorio **DEBE leer este archivo primero** antes de realizar análisis, planear o modificar código.
>
> - **Proyecto**: "Reto Agente 2026"
> - **Objetivo**: Rastrear oportunidades de contratación pública en SECOP II viables para pymes colombianas.
> - **Stack**: TypeScript (strict, ESM con `.js`), LangChain / LangGraph, Grok (gateway OpenAI-compatible), LangSmith (trazabilidad).

---

## 1. Arquitectura General del Sistema

El sistema opera bajo un flujo diario multi-agente en 5 etapas secuenciales:

```text
[Descarga SECOP II (Hoy)]  -->  [Pre-filtro básico (Código)]  -->  [Agente 1 "filtrador"]
                                                                         │
                                                                   (aptos.json)
                                                                         │
[Reporte Final (Código)]  <--  [Agente 3 "documentos"]  <--  [Agente 2 "resumidor"]
```

1. **Código (descarga)**: Descarga exclusivamente los procesos competitivos de SECOP II publicados **HOY** (hora Colombia, UTC-5).
2. **Código (pre-filtro básico)**: Descarta por reglas deterministas (modalidad no competitiva, estado cerrado, tipos excluidos como seguros/concesiones, valor > $5.000M COP, fecha límite de ofertas vencida, duplicados).
3. **Agente 1 "filtrador" (`agente_filtrador`)**: Evalúa candidatos pre-filtrados en páginas de 25 mediante la tool `filtro_basico` y clasifica `aptoPyme: "si" | "no" | "dudoso"`. Genera `data/entregas/<fecha>/aptos.json`.
4. **Agente 2 "resumidor" (`agente_resumidor` - Etapa 3)**: Recibe los procesos `aptoPyme: "si"` (y opcionalmente `"dudoso"`), consulta la ficha técnica enriquecida mediante la tool `obtener_ficha_proceso` (reemplaza a la hipotética `leer_pliego`) y genera un resumen honesto, alertas fundamentadas y puntos a verificar en el pliego para la pyme.
5. **Agente 3 "documentos" (Etapa 4 - Pendiente)**: Identifica requisitos habilitantes y arma la lista de documentos exigidos mediante la tool `armar_lista_documentos`.
6. **Código (reporte final - Etapa 5 - Pendiente)**: Consolida la entrega diaria lista para consumo.

---

## 2. Reglas Globales Inmutables

1. **Seguridad y Secretos**: NUNCA leer, imprimir, modificar ni commitear `.env`. Los secretos jamás se hardcodean.
2. **Docs-First**: No confiar en memoria para APIs de LangChain / LangGraph / LangSmith. Revisar la documentación oficial (https://docs.langchain.com/oss/javascript/) y los archivos de tipos instalados (`.d.ts`).
3. **TypeScript Estricto & ESM**: Imports relativos con sufijo obligatorio `.js`. Comentarios explicativos en español. Cero errores en `pnpm typecheck`.
4. **Trazabilidad & Contabilidad de Tokens**:
   - Toda llamada a modelo o pipeline debe quedar registrada en LangSmith (proyecto `secop-rastreador`) y registrar tokens en `logs/tokens.jsonl` a través de `src/cost.ts`.
   - **Discrepancia entre `input + output` y `tokens_total`**: En modelos como Grok (`grok-4.6`), la API genera tokens internos de razonamiento (*reasoning tokens* / cadena de pensamiento interna). `tokens_salida` refleja únicamente los tokens visibles en la respuesta, mientras que `tokens_total` incluye los tokens de entrada + salida visible + tokens de razonamiento (`output_token_details.reasoning`).
   - **Regla estricta de presupuesto**: El presupuesto de créditos y la estimación de costos **DEBEN guiarse siempre por la cifra de `tokens_total`**, pues es la que factura la plataforma.
5. **GUARDA DE CRÉDITOS (Estricta)**: Los créditos de Grok son limitados.
   - Cualquier comando que invoque LLM **debe operar por defecto en un lote pequeño** (Agente 1: máx 1 página / 25 procesos; Agente 2: máx 5 procesos; Agente 3: omite llamada a LLM en procesos sin anexos indexados).
   - Solo procesa el lote completo si se especifica explícitamente la bandera `--completo`.
   - Prohibido realizar bucles sin tope duro.
6. **Regla de Fecha (Solo HOY) e Instante de Referencia**:
   - Producción procesa **ÚNICAMENTE** procesos con `fecha_de_publicacion_del` del día de hoy en hora Colombia (UTC-5).
   - `descargarHoy()` no recibe parámetro de fecha. Si hoy hay 0 procesos, devuelve lista vacía y mensaje claro; **NUNCA recurre a otra fecha**.
   - **Única excepción de desarrollo**: La variable de entorno `SECOP_FECHA_PRUEBA=YYYY-MM-DD` (apagada por defecto). Si está activa, emite una advertencia ruidosa en consola, marca `modo: "prueba"` en las trazas y utiliza la caché local en `data/dias/<fecha>.json`.
   - **Instante de Referencia (`obtenerInstanteReferencia()`)**: Implementado de forma única y centralizada en `src/filtro/prefiltro.ts`.
     - En producción: hora real actual en Colombia (UTC-5).
     - En modo prueba (`SECOP_FECHA_PRUEBA`): inicio del día de prueba a las 00:00:00.000 UTC-5 (`YYYY-MM-DDT00:00:00.000-05:00`). Así, una fecha histórica se evalúa exactamente como si se corriera al inicio de ese día.
     - Aplica idénticamente para la regla de pre-filtro `oferta_vencida`, el cálculo de `diasRestantes` en la ficha, y se registra en los metadatos de las trazas de LangSmith como `fechaReferencia`.
7. **Regla de Honestidad sobre Pliegos y Protección Anti-Bot**:
   - Las páginas web del portal SECOP II (`community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=...`) están protegidas por Google ReCaptcha. El código **NUNCA debe hacer peticiones HTTP a esas URLs**.
   - El contenido del pliego **NO es legible de forma automatizada**. El Agente 2 **NUNCA debe afirmar ni sugerir que leyó el pliego**.
   - Los requisitos habilitantes (experiencia específica, capacidad financiera RUP, garantías, criterios ponderables) **NO están en los datos abiertos de Socrata**. El sistema nunca los inventa ni los supone; en su lugar, instruye a la pyme sobre qué debe verificar en el pliego oficial.

---

## 3. Estado de Avance por Etapas

| Etapa | Estado | Componentes Implementados |
|---|:---:|---|
| **Etapa 1** | **COMPLETA** | Capa de datos Socrata, pre-filtro determinista, setup de trazas LangSmith, script `probar-datos.ts`. |
| **Etapa 2** | **COMPLETA** | Tool `filtro_basico`, Agente 1 `agente_filtrador` (`ResultadoPagina`), runner `filtrar-pymes.ts`, CLI `correr-filtrador.ts`, entrega `aptos.json`. |
| **Etapa 3** | **COMPLETA** | Tool `obtener_ficha_proceso`, Agente 2 `agente_resumidor`, runner `resumir-procesos.ts`, CLI `correr-resumidor.ts`, entrega `resumenes.json`. |
| **Etapa 4** | **COMPLETA** | Catálogo auditado `documentos-habilitantes.json`, Tool `armar_lista_documentos`, Agente 3 `agente_documentos`, runner `armar-documentos.ts`, CLI `correr-documentos.ts`. |
| **Etapa 5** | **COMPLETA** | Grafo LangGraph StateGraph (5 nodos), CLI unificado (`src/index.ts`) con `--reanudar`, reportes JSON y MD (`generar-reporte.ts`), CLI tokens (`resumen-tokens.ts`), Docker y documentación completa. |

---

## 4. Mapa del Código Fuente

```text
├── docs/
│   └── CONTEXTO.md                      # Este archivo de referencia general
├── src/
│   ├── config/
│   │   ├── entorno.ts                   # Carga centralizada de .env y validación de SECOP_FECHA_PRUEBA
│   │   ├── secop.ts                     # Constantes de dataset p6dx-8zbt y modalidades competitivas
│   │   └── prefiltro.ts                 # Umbrales editables del pre-filtro (VALOR_MAXIMO = 5.000M COP, etc.)
│   ├── datos/
│   │   └── socrata.ts                   # Descarga exclusiva de HOY (UTC-5), paginación, reintentos y caché de prueba
│   ├── filtro/
│   │   └── prefiltro.ts                 # Pre-filtro por código: descarte countable por regla y formato Candidato
│   ├── herramientas/
│   │   └── filtro-basico.ts             # Tool LangChain 'filtro_basico' (páginas de 25, memoizado, orden por id)
│   ├── agentes/
│   │   ├── prompts/
│   │   │   └── filtrador.ts             # PROMPT_SISTEMA_FILTRADOR constante en español
│   │   └── filtrador.ts                 # Agente 1 (createAgent + Grok + ResultadoPagina zod)
│   ├── pipeline/
│   │   └── filtrar-pymes.ts             # Orquestador Agente 1: concurrencia 2, reintentos, validación de IDs, tokens
│   ├── tools/
│   │   ├── probar-datos.ts              # CLI para probar descarga + prefiltro sin LLM (pnpm probar:datos)
│   │   └── correr-filtrador.ts          # CLI para correr Agente 1 (pnpm filtrar [--max=N] [--completo])
│   ├── llm.ts                           # Instancia compartida ChatOpenAI apuntando a Grok (Reto Gateway)
│   ├── cost.ts                          # registrarCosto -> logs/tokens.jsonl
│   └── trazas.ts                        # Helpers de LangSmith (iniciarTrazas, configEjecucion, opcionesTraceable)
```

---

## 5. Contratos de Datos y Esquemas

### A. Candidato (Salida del Pre-filtro -> Entrada interna)
```typescript
interface Candidato {
  id: string;                  // id_del_proceso (ej: "CO1.REQ.11205497")
  nombre: string;              // nombre_del_procedimiento
  descripcion: string;         // descripci_n_del_procedimiento (máx 2000 chars)
  entidad: string;             // entidad compradora
  departamento: string;        // departamento_entidad
  ciudad: string;              // ciudad_entidad
  tipoDeContrato: string;      // Compraventa, Prestación de servicios, etc.
  modalidad: string;           // Mínima cuantía, Licitación pública, etc.
  fase: string | null;         // Fase contractual
  valor: number | null;        // precio_base numérico en COP (null si es 0 o desconocido)
  fechaPublicacion: string;    // YYYY-MM-DD
  url: string | null;          // Enlace al proceso en SECOP (urlproceso)
  // Campos extendidos reales de p6dx-8zbt (Etapa 3B):
  fechaLimiteOfertas: string | null; // fecha_de_recepcion_de (plazo de ofertas)
  duracion: number | null;           // duracion (numérica)
  unidadDuracion: string | null;     // unidad_de_duracion (Mes(es), día(s), Hora(s))
  numeroLotes: number | null;        // numero_de_lotes (0 = sin lotes, >0 = con lotes)
  justificacionModalidad: string | null; // justificaci_n_modalidad_de
  unidadContratante: string | null;  // nombre_de_la_unidad_de
  ciudadUnidad: string | null;       // ciudad_de_la_unidad_de
  idPortafolio: string | null;       // id_del_portafolio (clave para dmgg-8hin)
}
// NOTA: NO se usan 'subtipo_de_contrato' (siempre "No Definido") ni 'codigo_principal_de_categoria' (99% "UNSPECIFIED").
```

### B. Salida de `filtro_basico` (Para el Agente 1)
Devuelve un string JSON con páginas de 25 candidatos.

### C. Salida Estructurada de Agente 1 (`ResultadoPagina` Zod)
```typescript
{
  pagina: number,
  resultados: Array<{
    id: string,
    aptoPyme: "si" | "no" | "dudoso",
    categoriaObjeto: string,     // 2 a 4 palabras (ej: "evaluación psicosocial")
    razon: string,               // Máximo 20 palabras
    senales: string[]            // Frases cortas de respaldo
  }>
}
```

### D. Archivo de Entrega de Etapa 2 (`data/entregas/<fecha>/aptos.json`)
Contiene los procesos clasificados aptos para pymes por el Agente 1.

### E. Ficha del Proceso (`obtener_ficha_proceso` para el Agente 2)
Construida en código a partir de los datos verificados del candidato + anexos indexados (best-effort en `dmgg-8hin`):
```typescript
interface FichaProceso {
  id: string;
  nombre: string;
  descripcion: string;
  entidad: string;
  unidadContratante: string | null;
  departamento: string;
  ciudad: string;
  modalidad: string;
  justificacionModalidad: string | null;
  tipoDeContrato: string;
  fase: string | null;
  valorCOP: number | null;
  fechaPublicacion: string;
  fechaLimiteOfertas: string | null;
  diasRestantes: number | null;
  vencido: boolean | null;
  duracion: { cantidad: number | null; unidad: string | null };
  lotes: number | null;
  anexos: {
    estado: "con_anexos" | "sin_anexos_indexados" | "no_consultado_por_error";
    total: number;
    truncado: boolean;
    lista: Array<{ nombre: string; extension: string; tamanoKB: number }>; // máx 30
  };
}
```

### F. Salida Estructurada del Agente 2 (`ResumenProceso` Zod)
```typescript
interface ResumenProceso {
  id: string;
  resumen: string;                      // Máximo 100 palabras, lenguaje simple
  alertasParaPyme: Array<{
    alerta: string;
    basadoEn: string;                   // Clave exacta de FichaProceso
  }>;
  verificarEnElPliego: string[];        // Requisitos y condiciones a revisar
  comentarioAnexos: string | null;       // Observación prudente sobre anexos indexados
}
```

### G. Archivo de Entrega de Etapa 3 (`data/entregas/<fecha>/resumenes.json`)
```typescript
interface EntregaResumenes {
  fecha: string;
  modo: "produccion" | "prueba";
  totalAptos: number;
  totalProcesados: number;
  tokens: { entrada: number; salida: number; total: number };
  resumenes: Array<{
    id: string;
    diasRestantes: number | null;
    ficha: FichaProceso;
    resumen: string;
    alertasParaPyme: Array<{ alerta: string; basadoEn: string }>;
    verificarEnElPliego: string[];
    comentarioAnexos: string | null;
    advertencias: string[];             // Guardas de código (números no respaldados o basadoEn inválido)
    urlProceso: string | null;
    anexosUrls?: Array<{ nombre: string; urlDescarga: string }>;
  }>;
}
```

### H. Herramienta `armar_lista_documentos` y Catálogo
Filtra el catálogo auditado `data/catalogos/documentos-habilitantes.json` según modalidad y tipo de contrato:
```typescript
interface ItemCatalogoDocumento {
  id: string;
  nombre: string;
  expide: string | null;
  aplicaA: string[];
  condicion: string | null;
  nota: string | null;
  emisor: string | null;
  respaldoLegal: string | null;
  verificar: boolean;
}
```

### I. Salida del Modelo (`NotasDocumentos`) y Checklist Determinista
El modelo genera únicamente notas breves sobre los anexos y una recomendación general:
```typescript
interface NotasDocumentos {
  id: string;
  anexos: Array<{ nombre: string; queEs: string /* máx 15 palabras */ }>;
  observaciones: string /* máx 60 palabras */;
}
```
El código construye la lista de forma determinista y deduplicada (`MAPA_DEDUPLICACION_ANEXOS`), fusionando catálogo y anexos:
```typescript
interface ItemDocumento {
  nombre: string;
  base: "catalogo_con_emisor" | "catalogo_sin_emisor" | "nombre_de_anexo";
  fundamento: string;
  catalogoId: string | null;
  expide: string | null;
  condicion: string | null;
  observaciones: string | null;
}
```

### J. Archivo de Entrega de Etapa 4 (`data/entregas/<fecha>/documentos.json`)
```typescript
interface EntregaDocumentos {
  fecha: string;
  modo: "produccion" | "prueba";
  avisoOficial: string; // "Lista orientativa: confirme siempre en el pliego oficial"
  totalResumenesDisponibles: number;
  totalProcesados: number;
  tokens: { entrada: number; salida: number; total: number };
  documentosPorProceso: Array<{
    id: string;
    avisoOficial: string;
    items: ItemDocumento[];
    observacionGeneral: string | null;
    advertencias: string[];
    procesoInfo: {
      modalidad: string;
      tipoDeContrato: string;
      valorCOP: number | null;
      diasRestantes: number | null;
      urlProceso: string | null;
    };
  }>;
}
```

---

## 6. Comandos de Terminal para Pruebas y Operación

```powershell
# 1. Verificación estricta de TypeScript (siempre debe dar 0 errores)
pnpm typecheck

# 2. Probar capa de datos + prefiltro sin consumir LLM
pnpm probar:datos                                    # Ejecución para el día de hoy
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm probar:datos # Ejecución con fecha histórica de prueba

# 3. Ejecutar Agente 1 (filtrador) con guarda de créditos
pnpm filtrar                                         # Procesa 1 página (máx 25 candidatos) para hoy
pnpm filtrar --max=50                                # Procesa hasta 2 páginas (50 candidatos)
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm filtrar  # Procesa 1 página sobre la fecha de prueba
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm filtrar --completo # Procesa TODO el día de prueba

# 4. Ejecutar Agente 2 (resumidor) con guarda de créditos
pnpm resumir                                         # Procesa por defecto 5 procesos aptos de hoy
pnpm resumir --max=10                                # Procesa hasta 10 procesos aptos
pnpm resumir --incluir-dudosos                       # Incluye clasificados como "dudoso"
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm resumir  # Procesa procesos aptos de la fecha de prueba
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm resumir --completo # Procesa TODOS los aptos de la fecha

# 5. Ejecutar Agente 3 (documentos) con guarda de créditos
pnpm documentos                                      # Procesa por defecto 5 resúmenes de hoy
pnpm documentos --max=10                             # Procesa hasta 10 resúmenes
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm documentos # Procesa resúmenes de la fecha de prueba
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm documentos --completo # Procesa TODOS los resúmenes

# 6. Auditar fuentes oficiales del catálogo de documentos habilitantes
pnpm auditar:catalogo

# 7. Abrir dashboard de LangSmith
Start-Process "https://smith.langchain.com"
```
