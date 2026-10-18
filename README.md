# Rastreador de Oportunidades en SECOP II para Pymes

Sistema multi-agente basado en **LangGraph** y **LangChain** para la vigilancia, triaje y estructuración diaria de oportunidades de contratación pública en Colombia a partir de datos abiertos de SECOP II ([datos.gov.co](https://www.datos.gov.co/)).

---

## 1. El Problema

Cada jornada hábil en Colombia, entidades de orden nacional y territorial publican entre 300 y 600 procesos de contratación en SECOP II. Para una micro, pequeña o mediana empresa (pyme):
- Es humanamente inviable revisar cientos de pliegos y avisos de convocatoria antes de los plazos de cierre.
- Muchas pymes pierden oportunidades viables por desconocimiento de los plazos o quedan descalificadas por omitir documentos habilitantes básicos.
- Los portales web transaccionales de contratación pública presentan barreras técnicas de automatización y lectura masiva (como sistemas de protección anti-bot y ReCaptcha).

---

## 2. Qué Hace el Sistema Hoy

El sistema ejecuta una canalización diaria completamente automatizada:
1. **Descarga exclusiva de HOY**: Consulta en la API Socrata (`p6dx-8zbt`) únicamente los procesos publicados en la fecha corriente en hora legal de Colombia (UTC-5).
2. **Pre-filtro determinista por código**: Descarta sin costo de LLM procesos no competitivos (contratación directa, régimen especial), procesos cerrados, tipos de contrato excluidos (seguros, concesiones), cuantías superiores a $5.000M COP, ofertas ya vencidas y registros duplicados.
3. **Triaje y Clasificación (Agente 1)**: Evalúa los candidatos viables en bloques paginados de 25 y los clasifica como `SÍ`, `NO` o `DUDOSO` para pymes, sustentando su decisión con señales objetivas.
4. **Ficha Técnica y Resumen Abierto (Agente 2)**: Consulta metadatos enriquecidos oficiales y genera un resumen del objeto, alertas operativas y los puntos indispensables que la pyme debe verificar en el pliego oficial.
5. **Estructuración de Documentos Habilitantes (Agente 3)**: Cruza la modalidad y tipo contractual con un catálogo auditado de 12 documentos de contratación estatal, deduplica contra nombres de anexos indexados en SECOP II (`dmgg-8hin`) y emite una lista orientativa con fuentes institucionales y condiciones.
6. **Consolidación de Reporte Diario**: Genera automáticamente entregas estructuradas en `data/entregas/<fecha>/` y reportes listos para consulta en `data/reportes/<fecha>.json` y `data/reportes/<fecha>.md`.

---

## 3. Arquitectura del Grafo (LangGraph)

El flujo está modelado como un `StateGraph` de 5 nodos con estado tipado mediante esquemas Zod y canales con *reducers* para acumulación de listas y aislamiento de errores:

```mermaid
flowchart TD
    START([START]) --> N1[1. descargar_y_prefiltrar<br/><i>Código determinista</i>]
    N1 --> N2[2. filtrar_pymes<br/><i>Agente 1: Clasificación de viabilidad</i>]
    N2 --> N3[3. resumir_procesos<br/><i>Agente 2: Fichas y resumen de datos abiertos</i>]
    N3 --> N4[4. armar_documentos<br/><i>Agente 3: Lista orientativa de documentos</i>]
    N4 --> N5[5. ensamblar_reporte<br/><i>Código: Consolidación JSON y Markdown</i>]
    N5 --> END([END])

    classDef codeNode fill:#2d3748,stroke:#4a5568,stroke-width:2px,color:#fff;
    classDef agentNode fill:#1a365d,stroke:#2b6cb0,stroke-width:2px,color:#fff;
    class N1,N5 codeNode;
    class N2,N3,N4 agentNode;
```

---

## 4. Agentes y Herramientas

| Componente | Rol / Tipo | Descripción |
|---|---|---|
| `filtro_basico` | **Herramienta** | Expone los candidatos pre-filtrados al Agente 1 en páginas ordenadas de a 25 registros. Memoiza la consulta en memoria para evitar llamadas redundantes a la API. |
| `agente_filtrador` | **Agente 1** | Modelo Grok (`grok-4.6`) con salida estructurada `ResultadoPagina`. Identifica viabilidad para pymes evaluando objeto, presupuesto, modalidad y ubicación. |
| `obtener_ficha_proceso` | **Herramienta** | Construye la ficha técnica con campos nativos de SECOP II, calcula los días restantes para presentar ofertas y consulta archivos anexos indexados en `dmgg-8hin`. |
| `agente_resumidor` | **Agente 2** | Modelo Grok con salida estructurada `ResumenProceso`. Genera el resumen del objeto, alertas para pymes y puntos a verificar. **Analiza metadatos abiertos, no lee pliegos**. |
| `armar_lista_documentos` | **Herramienta** | Consulta el catálogo general de 12 documentos habilitantes auditados según modalidad y tipo de contrato. |
| `agente_documentos` | **Agente 3** | Modelo Grok con salida estructurada `NotasDocumentos`. Emite notas sobre anexos indexados. Si el proceso no tiene anexos, el sistema resuelve la lista 100% en código sin invocar al modelo (0 tokens). |

---

## 5. Ejecución del Sistema

### Requisitos previos
- Node.js 22+ y pnpm (`corepack enable`).
- Archivo `.env` con las credenciales necesarias (ver sección Variables de Entorno).

### 5.1 Ejecución Local

```powershell
# Ejecución diaria estándar (procesa candidatos y hasta 5 procesos aptos)
pnpm exec tsx src/index.ts

# Ejecución personalizada con banderas
pnpm exec tsx src/index.ts --max=50 --max-aptos=10 --incluir-dudosos

# Ejecución completa de toda la jornada (elimina topes)
pnpm exec tsx src/index.ts --completo

# Reanudar ejecución (omite etapas ya guardadas en data/entregas/<fecha>/ sin gastar créditos)
pnpm exec tsx src/index.ts --reanudar

# Modo prueba / histórico (emula ejecución en fecha pasada)
$env:SECOP_FECHA_PRUEBA="2026-10-15"; pnpm exec tsx src/index.ts

# Reporte consolidado de consumo de tokens y promedios por proceso
pnpm tokens:resumen

# Verificación estricta de TypeScript (0 errores)
pnpm typecheck
```

### 5.2 Ejecución con Docker

La imagen Docker cumple estrictamente con el principio de no incluir secretos ni archivos `.env` en el empaquetado:

```powershell
# Construir la imagen
docker compose build

# Ejecutar el rastreador dentro del contenedor
docker compose run --rm agent

# Ejecutar con fecha histórica de prueba y reanudación
docker compose run --rm -e SECOP_FECHA_PRUEBA=2026-10-15 agent pnpm exec tsx src/index.ts --reanudar

# Consultar métricas de tokens dentro del contenedor
docker compose run --rm agent pnpm tokens:resumen
```

- Los directorios `./logs` y `./data` se encuentran montados como volúmenes persistentes en el anfitrión.
- El contenedor no expone puertos innecesarios ni cuenta con políticas de reinicio automático descontroladas (`restart: unless-stopped` se mantiene comentada para evitar gasto no supervisado de créditos).

---

## 6. Variables de Entorno

El archivo `.env` local debe definir las siguientes variables (los valores nunca deben subirse al repositorio):

- `RETO_KEY`: Clave de acceso al gateway del modelo de lenguaje (Grok / xAI).
- `LANGSMITH_TRACING`: Bandera booleana (`true` o `false`) para activar la trazabilidad en LangSmith.
- `LANGSMITH_API_KEY`: API Key de LangSmith para telemetría.
- `LANGSMITH_PROJECT`: Nombre del proyecto en LangSmith (por defecto `secop-rastreador`).
- `SECOP_FECHA_PRUEBA`: *(Opcional)* Fecha en formato `YYYY-MM-DD` para simular la ejecución en una jornada histórica utilizando la caché local.

---

## 7. Trazabilidad en LangSmith

Cuando `LANGSMITH_TRACING=true` está configurado, cada ejecución del grafo se registra bajo el árbol jerárquico `secop-diario` con las etiquetas `["secop", "diario"]` y metadatos completos (`fecha`, `modo`, `fechaReferencia`, `caps`).

### Cómo inspeccionar la traza
1. **Raíz (`secop-diario`)**: Muestra la duración global, estado y métricas acumuladas de la jornada.
2. **Nodos del Grafo**: Cada etapa aparece como un tramo anidado:
   - `descargar_y_prefiltrar`: Conteo de filas procesadas y desglose de exclusiones.
   - `filtrar_pymes`: Despliega las llamadas concurrentes `filtrador:pagina-N` y las consultas a `filtro_basico`.
   - `resumir_procesos`: Despliega las llamadas hijo `resumidor:<id_proceso>` con sus invocaciones a `obtener_ficha_proceso`.
   - `armar_documentos`: Despliega las llamadas `documentos:<id_proceso>` (solo para procesos con anexos) y consultas a `armar_lista_documentos`.
   - `ensamblar_reporte`: Generación final y almacenamiento de archivos.
3. **Flujo de Cierre Limpio**: El programa invoca `cerrarTrazas()` al finalizar para garantizar que no queden lotes de telemetría en tránsito. Si la API Key falta o es inválida, se emite una única advertencia y la ejecución continúa sin interrumpirse.

---

## 8. Contabilidad de Tokens y Costos

El sistema registra meticulosamente cada invocación al modelo en `logs/tokens.jsonl` a través de `src/cost.ts`.

### Particularidad de Modelos de Razonamiento (Grok)
En modelos avanzados como `grok-4.6`, la suma aritmética de tokens de entrada + tokens visibles de salida **es inferior al total facturado**. Esto ocurre porque la API genera tokens internos de razonamiento (*reasoning tokens* / cadena de pensamiento interna).
- **Regla presupuestal**: Las métricas del sistema y las decisiones de consumo se basan invariablemente en la métrica `tokens_total`, que refleja el cobro efectivo de la plataforma proveedora.

### Estrategia de Reducción de Costos Implementada
1. **Guarda de créditos predeterminada**: Por defecto procesa 1 página de candidatos (25 procesos) y hasta 5 procesos para Agentes 2 y 3.
2. **Ejecución determinista en Agente 3**: Si un proceso no tiene archivos anexos indexados en SECOP II, la lista orientativa se construye por código utilizando el catálogo auditado ($0 USD, 0 tokens), reduciendo en más del 70% el gasto en la etapa de documentos.
3. **Modo `--reanudar`**: Permite reiniciar corridas interrumpidas o reensamblar reportes sin repetir llamadas LLM ya completadas.

---

## 9. Limitaciones Honestas y Advertencias Legales

1. **El pliego de condiciones oficial NO es leído**:
   Las páginas web transaccionales de SECOP II (`community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?...`) se encuentran protegidas por Google ReCaptcha. El bot **nunca realiza peticiones directas a dichas páginas ni evade medidas anti-bot**. Toda la información analizada por el Agente 2 proviene exclusivamente de los metadatos públicos del portal de datos abiertos.
2. **Requisitos habilitantes no presentes en Socrata**:
   Criterios como experiencia específica requerida, capacidad financiera del RUP, pólizas particulares y fórmulas de ponderación no existen en los datasets abiertos. El sistema identifica alertas orientativas, pero instruye expresamente a la empresa a consultar el pliego oficial.
3. **Desfase en la indexación de archivos anexos**:
   El dataset abierto de anexos (`dmgg-8hin`) presenta frecuentemente una ventana de retraso de 24 a 48 horas frente a los procesos publicados el día de hoy. La ausencia de anexos indexados en el reporte no implica que el proceso oficial carezca de documentos.
4. **Carácter no vinculante del catálogo**:
   La lista de documentos generada por el Agente 3 es un listado orientativo de referencia y **NO constituye asesoría jurídica ni garantiza la habilitación de la oferta**.
5. **Aviso legal obligatorio**:
   > *Lista orientativa: confirme siempre en el pliego oficial.*

---

## 10. Extracto Real de Reporte Generado

A continuación se presenta un extracto textual sin modificaciones obtenido de la ejecución sobre la fecha de prueba `2026-10-15` (`data/reportes/2026-10-15.md`):

```markdown
### 1. [CO1.REQ.11205986] ADQUIRIR EL SERVICIO DE INFRAESTRUCTURA PARA DESPLIEGUE EN NUBE DE LA PLATAFORMA; PROCESAMIENTO Y ALMACENAMIENTO DE LA RADICACIÓN DE FACTURA ELECTRÓNICA; EN LA PRESTACIÓN DE SERVICIOS DE SALUD ENMARCA

- **Entidad Compradora**: DEPARTAMENTO DE SANTANDER
- **Ubicación**: Bucaramanga, Santander
- **Modalidad**: Mínima cuantía
- **Tipo de Contrato**: Prestación de servicios
- **Presupuesto Oficial**: $ 44.166.500
- **Plazo de Ofertas**: 2026-10-20T00:00:00.000 (⏳ 5 día(s))
- **Duración Estimada**: 0 día(s)
- **Estructura de Lotes**: Sin lotes (oferta global)
- **Enlace Oficial en SECOP II**: [Ver proceso en SECOP II](https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.11070456)

#### Archivos Anexos Indexados en SECOP II
*Sin archivos anexos indexados aún en el dataset `dmgg-8hin` de SECOP II.*

#### Resumen del Objeto (Agente 2 — Datos Abiertos)
La entidad busca contratar un servicio de infraestructura en la nube para desplegar una plataforma y para procesar y almacenar la radicación de factura electrónica, en la prestación de servicios de salud. El objeto se enmarca en un proyecto de asistencia para atención en salud a población a cargo del departamento (extranjera e inimputable) en Santander.

#### Alertas Técnicas para la Pyme
- ⚠️ **Queda poco tiempo para presentar oferta; el calendario de presentación es apretado para armar una propuesta de servicios en nube.** *(Basado en campo: `diasRestantes`)*
- ⚠️ **En los datos abiertos la duración del contrato aparece en cero días: no se puede dar por hecho el plazo de ejecución y hay que confirmarlo en el pliego.** *(Basado en campo: `duracion`)*
- ⚠️ **El proceso no está dividido en lotes, así que se trata de un único paquete y no de adjudicaciones parciales.** *(Basado en campo: `lotes`)*
- ⚠️ **La modalidad es mínima cuantía (presupuesto por debajo del umbral de menor cuantía): conviene revisar en el pliego las reglas y el formulario de oferta propios de esa modalidad, sin asumir de antemano cómo se evalúa.** *(Basado en campo: `modalidad`)*
- ⚠️ **El tipo de contrato es prestación de servicios (no compraventa de bienes): hay que verificar alcance, obligaciones y forma de pago en el pliego.** *(Basado en campo: `tipoDeContrato`)*

#### Puntos Clave a Verificar en el Pliego Oficial
- 🔍 Requisitos habilitantes de experiencia específica (nube, plataformas, facturación electrónica o salud) y si piden contratos similares o certificaciones.
- 🔍 Capacidad financiera e indicadores (patrimonio, liquidez, endeudamiento u otros) y si hay umbrales mínimos.
- 🔍 Garantías de seriedad de la oferta, de cumplimiento y demás pólizas, montos y vigencias.
- 🔍 Criterios de evaluación, factores de desempate y si el precio es el único puntaje o hay factores técnicos.
- 🔍 Especificaciones técnicas de la nube (capacidad, disponibilidad, ubicación de datos, copias, soporte) y niveles de servicio.
- 🔍 Plazo real de ejecución, fecha de inicio, prórrogas y si hay cronograma de desplieque.
- 🔍 Anticipo, forma de pago, facturación y si hay retenciones o pagos contra entregables.
- 🔍 Visita técnica, audiencia o mesas de aclaraciones, y si son obligatorias.
- 🔍 Tratamiento de datos personales y de salud, confidencialidad y requisitos de seguridad de la información.
- 🔍 Anexos, formatos de oferta económica y documentos que hay que diligenciar y firmar.

#### Lista Orientativa de Documentos Habilitantes
> ℹ️ *Aviso obligatorio: Lista orientativa: confirme siempre en el pliego oficial.*

- 🏛️ `[Catálogo con Emisor]` **Registro Único Tributario (RUT)** *(ID: `rut`)*
  - **Fundamento / Emisor**: https://www.dian.gov.co/
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Dirección de Impuestos y Aduanas Nacionales (DIAN)
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 🏛️ `[Catálogo con Emisor]` **Certificado de existencia y representación legal o matrícula mercantil** *(ID: `existencia_representacion`)*
  - **Fundamento / Emisor**: https://www.rues.org.co/
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Cámaras de Comercio (Registro Único Empresarial y Social - RUES)
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 📋 `[Catálogo sin Emisor]` **Documento de identidad del representante legal o persona natural proponente** *(ID: `cedula_representante`)*
  - **Fundamento / Emisor**: Catálogo general (sin emisor oficial enlazado; confirme en pliego)
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Registraduría Nacional del Estado Civil o autoridad migratoria
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 📋 `[Catálogo sin Emisor]` **Certificación de pago de aportes a seguridad social y parafiscales** *(ID: `seguridad_social`)*
  - **Fundamento / Emisor**: Catálogo general (sin emisor oficial enlazado; confirme en pliego)
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Revisor fiscal o Representante legal
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 🏛️ `[Catálogo con Emisor]` **Certificado de antecedentes disciplinarios** *(ID: `antecedentes_disciplinarios`)*
  - **Fundamento / Emisor**: https://www.procuraduria.gov.co/
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Procuraduría General de la Nación
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 📋 `[Catálogo sin Emisor]` **Certificado de antecedentes fiscales (Boletín de Responsables Fiscales)** *(ID: `antecedentes_fiscales`)*
  - **Fundamento / Emisor**: Catálogo general (sin emisor oficial enlazado; confirme en pliego)
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Contraloría General de la República
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 🏛️ `[Catálogo con Emisor]` **Certificado de antecedentes judiciales y medidas correctivas** *(ID: `antecedentes_judiciales`)*
  - **Fundamento / Emisor**: https://www.policia.gov.co/
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Policía Nacional
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 🏛️ `[Catálogo con Emisor]` **Certificado del Registro Único de Proponentes (RUP)** *(ID: `rup`)*
  - **Fundamento / Emisor**: https://www.rues.org.co/
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Cámaras de Comercio (RUES)
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
- 📋 `[Catálogo sin Emisor]` **Garantía de seriedad de la oferta** *(ID: `garantia_seriedad`)*
  - **Fundamento / Emisor**: Catálogo general (sin emisor oficial enlazado; confirme en pliego)
  - **Condición**: Puede exigirse según el pliego; verificar.
  - **Expide**: Compañía de seguros o entidad bancaria
  - **Observación**: Documento del catálogo general de referencia; confirme en el pliego oficial.
```
