# Estudio de Factibilidad: Lectura de Pliegos y Documentos en SECOP II (Etapa 3A - Corregido y Medido)

> **Documento de Investigación Técnica**: Determina con mediciones empíricas qué información real sobre un proceso de contratación de SECOP II es posible obtener de forma automatizada y confiable, evitando que el **Agente 2 ("resumidor")** prometa información que no pueda leer.
> **Decisión de Diseño**: Se adopta la **Opción (C) como base** (metadata enriquecida de `p6dx-8zbt`). Se descarta la Opción (A) (acceso web a pliegos). La Opción (B) de contenido queda descartada y una posible "B-light" (listado de nombres/tamaños de anexos) queda pendiente de evaluación debido a la cobertura del día.

---

## 1. Prueba de Acceso HTTP a las URLs del Portal SECOP II

Se realizó una prueba con peticiones `fetch` estándar (HTTP GET sin sesión ni emulación de navegador) sobre 5 procesos reales obtenidos del pre-filtro, abarcando 5 modalidades de contratación distintas:

| Modalidad | ID Proceso | URL Original (`OpportunityDetail`) | Status HTTP | Content-Type | Tamaño (bytes) | ¿Contiene Datos del Proceso? | ¿Requiere JS? | ¿Requiere Login? | ¿Aparece Captcha? |
|---|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Mínima cuantía** | `CO1.REQ.11205497` | `...noticeUID=CO1.NTC.11070275` | 200 (redirect 302) | `text/html; charset=utf-8` | 28.037 | **NO** | Sí | Sí (enlace) | **SÍ (Google ReCaptcha)** |
| **Menor cuantía** | `CO1.REQ.11206020` | `...noticeUID=CO1.NTC.11065430` | 200 (redirect 302) | `text/html; charset=utf-8` | 28.037 | **NO** | Sí | Sí (enlace) | **SÍ (Google ReCaptcha)** |
| **Subasta inversa** | `CO1.REQ.11204985` | `...noticeUID=CO1.NTC.11065673` | 200 (redirect 302) | `text/html; charset=utf-8` | 28.037 | **NO** | Sí | Sí (enlace) | **SÍ (Google ReCaptcha)** |
| **Concurso de méritos** | `CO1.REQ.11205650` | `...noticeUID=CO1.NTC.11071540` | 200 (redirect 302) | `text/html; charset=utf-8` | 28.037 | **NO** | Sí | Sí (enlace) | **SÍ (Google ReCaptcha)** |
| **Licitación pública** | `CO1.REQ.11205870` | `...noticeUID=CO1.NTC.11071179` | 200 (redirect 302) | `text/html; charset=utf-8` | 28.037 | **NO** | Sí | Sí (enlace) | **SÍ (Google ReCaptcha)** |

### Hallazgos del Portal Web
- Todas las peticiones son redirigidas a `https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index?previousUrl=...`.
- El HTML retornado corresponde a la pantalla de verificación de Google ReCaptcha (~28 KB). No contiene título, descripción, fechas, presupuestos ni pliegos.
- Siguiendo la regla de no vulnerar ni eludir protecciones técnicas, **se confirma que el scraping web directo sobre `OpportunityDetail` no es viable (Opción A descartada)**.

---

## 2. Auditoría del Dataset Principal `p6dx-8zbt` (Metadatos Reales Socrata)

Consultando directamente el endpoint oficial de esquema (`https://www.datos.gov.co/api/views/p6dx-8zbt.json`), el dataset expone exactamente **59 columnas**.

### A. Corrección de Discrepancias del Reporte Inicial

En la versión preliminar del informe se incluyeron 20 nombres de campos que **NO existen** en `p6dx-8zbt` (provenientes de esquemas de SECOP I o contratos), y se omitieron 20 campos reales. A continuación se detalla la conciliación:

#### 1. Columnas reportadas erróneamente que NO existen en `p6dx-8zbt`:
1. `marcado_pyme` (Error 400 SoQL: `No such column: marcado_pyme`).
2. `condiciones_de_entrega` (Error 400 SoQL: `No such column: condiciones_de_entrega`).
3. `procedimiento_en_lotes` (No existe en el esquema).
4. `valor_total_de_adjudicacion` (El nombre real es `valor_total_adjudicacion`).
5. `nombre_principal_de_categoria` (No existe; solo existe `codigo_principal_de_categoria`).
6. `respuestas_salvadas` (No existe).
7. `consorcios_asociaciones` (No existe).
8. `habilita_proveedores` (No existe).
9. `preguntas_al_procedimiento` (No existe).
10. `respuestas_a_las_preguntas` (No existe).
11. `dias_adicionados` (No existe).
12. `puntos_del_acuerdo` (No existe).
13. `moneda` (No existe).
14. `origen_de_los_recursos` (No existe).
15. `destino_del_gasto` (No existe).
16. `espostconflicto` (No existe).
17. `fecha_firma_del_contrato` (No existe).
18. `fecha_inicio_ejecucion` (No existe).
19. `fecha_fin_ejecucion` (No existe).
20. `duracion_dias` (No existe; solo existen `duracion` y `unidad_de_duracion`).

#### 2. Columnas reales de `p6dx-8zbt` que habían sido omitidas:
1. `estado_de_apertura_del_proceso` (Texto: Abierto, Cerrado, etc.).
2. `valor_total_adjudicacion` (Número).
3. `fecha_de_publicacion_fase_1` (Fecha: Fase Selección Precalificación).
4. `fecha_de_publicacion` (Fecha: Manifestación de Interés).
5. `fecha_de_publicacion_fase_2` (Fecha: Fase Borrador).
6. `fecha_de_publicacion_fase_3` (Fecha: Fase Selección definitiva).
7. `conteo_de_respuestas_a_ofertas` (Número).
8. `proveedores_unicos_con` (Número).
9. `id_estado_del_procedimiento` (Número).
10. `adjudicado` (Texto: Si / No).
11. `id_adjudicacion` (Texto).
12. `codigoproveedor` (Texto).
13. `departamento_proveedor` (Texto).
14. `ciudad_proveedor` (Texto).
15. `nombre_del_adjudicador` (Texto).
16. `nombre_del_proveedor` (Texto).
17. `nit_del_proveedor_adjudicado` (Texto).
18. `categorias_adicionales` (Texto).
19. `codigo_entidad` (Número).
20. `estado_resumen` (Texto).

---

### B. Listado Completo y Oficial de las 59 Columnas de `p6dx-8zbt`

Leído directamente de `https://www.datos.gov.co/api/views/p6dx-8zbt.json`:

| # | `fieldName` (SoQL) | Nombre en Plataforma | Tipo de Dato |
|---|---|---|---|
| 1 | `entidad` | Entidad | `text` |
| 2 | `nit_entidad` | Nit Entidad | `text` |
| 3 | `departamento_entidad` | Departamento Entidad | `text` |
| 4 | `ciudad_entidad` | Ciudad Entidad | `text` |
| 5 | `ordenentidad` | OrdenEntidad | `text` |
| 6 | `codigo_pci` | Entidad Centralizada | `text` |
| 7 | `id_del_proceso` | ID del Proceso | `text` |
| 8 | `referencia_del_proceso` | Referencia del Proceso | `text` |
| 9 | `ppi` | PCI | `text` |
| 10 | `id_del_portafolio` | ID del Portafolio | `text` |
| 11 | `nombre_del_procedimiento` | Nombre del Procedimiento | `text` |
| 12 | `descripci_n_del_procedimiento` | Descripción del Procedimiento | `text` |
| 13 | `fase` | Fase | `text` |
| 14 | `fecha_de_publicacion_del` | Fecha de Publicacion del Proceso | `calendar_date` |
| 15 | `fecha_de_ultima_publicaci` | Fecha de Ultima Publicación | `calendar_date` |
| 16 | `fecha_de_publicacion_fase` | Fecha de Publicacion (Fase Planeacion Precalificacion) | `calendar_date` |
| 17 | `fecha_de_publicacion_fase_1` | Fecha de Publicacion (Fase Seleccion Precalificacion) | `calendar_date` |
| 18 | `fecha_de_publicacion` | Fecha de Publicacion (Manifestacion de Interes) | `calendar_date` |
| 19 | `fecha_de_publicacion_fase_2` | Fecha de Publicacion (Fase Borrador) | `calendar_date` |
| 20 | `fecha_de_publicacion_fase_3` | Fecha de Publicacion (Fase Seleccion) | `calendar_date` |
| 21 | `precio_base` | Precio Base | `number` |
| 22 | `modalidad_de_contratacion` | Modalidad de Contratacion | `text` |
| 23 | `justificaci_n_modalidad_de` | Justificación Modalidad de Contratación | `text` |
| 24 | `duracion` | Duracion | `number` |
| 25 | `unidad_de_duracion` | Unidad de Duracion | `text` |
| 26 | `fecha_de_recepcion_de` | Fecha de Recepcion de Respuestas | `calendar_date` |
| 27 | `fecha_de_apertura_de_respuesta` | Fecha de Apertura de Respuesta | `calendar_date` |
| 28 | `fecha_de_apertura_efectiva` | Fecha de Apertura Efectiva | `calendar_date` |
| 29 | `ciudad_de_la_unidad_de` | Ciudad de la Unidad de Contratación | `text` |
| 30 | `nombre_de_la_unidad_de` | Nombre de la Unidad de Contratación | `text` |
| 31 | `proveedores_invitados` | Proveedores Invitados | `number` |
| 32 | `proveedores_con_invitacion` | Proveedores con Invitacion Directa | `number` |
| 33 | `visualizaciones_del` | Visualizaciones del Procedimiento | `number` |
| 34 | `proveedores_que_manifestaron` | Proveedores que Manifestaron Interes | `number` |
| 35 | `respuestas_al_procedimiento` | Respuestas al Procedimiento | `number` |
| 36 | `respuestas_externas` | Respuestas Externas | `number` |
| 37 | `conteo_de_respuestas_a_ofertas` | Conteo de Respuestas a Ofertas | `number` |
| 38 | `proveedores_unicos_con` | Proveedores Unicos con Respuestas | `number` |
| 39 | `numero_de_lotes` | Numero de Lotes | `number` |
| 40 | `estado_del_procedimiento` | Estado del Procedimiento | `text` |
| 41 | `id_estado_del_procedimiento` | ID Estado del Procedimiento | `number` |
| 42 | `adjudicado` | Adjudicado | `text` |
| 43 | `id_adjudicacion` | ID Adjudicacion | `text` |
| 44 | `codigoproveedor` | CodigoProveedor | `text` |
| 45 | `departamento_proveedor` | Departamento Proveedor | `text` |
| 46 | `ciudad_proveedor` | Ciudad Proveedor | `text` |
| 47 | `fecha_adjudicacion` | Fecha Adjudicacion | `calendar_date` |
| 48 | `valor_total_adjudicacion` | Valor Total Adjudicacion | `number` |
| 49 | `nombre_del_adjudicador` | Nombre del Adjudicador | `text` |
| 50 | `nombre_del_proveedor` | Nombre del Proveedor Adjudicado | `text` |
| 51 | `nit_del_proveedor_adjudicado` | NIT del Proveedor Adjudicado | `text` |
| 52 | `codigo_principal_de_categoria` | Codigo Principal de Categoria | `text` |
| 53 | `estado_de_apertura_del_proceso` | Estado de Apertura del Proceso | `text` |
| 54 | `tipo_de_contrato` | Tipo de Contrato | `text` |
| 55 | `subtipo_de_contrato` | Subtipo de Contrato | `text` |
| 56 | `categorias_adicionales` | Categorias Adicionales | `text` |
| 57 | `urlproceso` | URLProceso | `url` |
| 58 | `codigo_entidad` | Codigo Entidad | `number` |
| 59 | `estado_resumen` | Estado Resumen | `text` |

---

## 3. Mediciones Empíricas sobre Procesos Competitivos del 2026-10-16

Se midió el porcentaje real de llenado sobre los **208 procesos competitivos** publicados el **2026-10-16**:

| Campo Consultado | ¿Existe en `p6dx-8zbt`? | Filas Llenas / Total | % Lleno | Observaciones y Valores Distintos |
|---|:---:|:---:|:---:|---|
| `fecha_de_recepcion_de` | **SÍ** | 208 / 208 | **100,00%** | **Completamente confiable**. Fecha y hora exacta límite para presentar oferta. |
| `duracion` | **SÍ** | 208 / 208 | **100,00%** | **Completamente confiable**. Tiempo numérico de ejecución (acompañado de `unidad_de_duracion`). |
| `numero_de_lotes` | **SÍ** | 208 / 208 | **100,00%** | **Completamente confiable**. Informa si el proceso se concursa en bloque o por lotes. |
| `subtipo_de_contrato` | **SÍ** | 0 / 208 | **0,00%** | **Inutilizable**: Aunque la columna existe en el esquema, el 100% de los 208 procesos tienen el valor literal `'No Definido'`. (Se verificó además en todo el histórico del dataset: de 9.342.264 filas, las 9.342.264 filas tienen `'No Definido'`). |
| `marcado_pyme` | **NO** | 0 / 208 | **0,00%** | **No existe en el dataset**. Socrata responde error 400 (`No such column`). Valores distintos: `[]` (ninguno). |
| `condiciones_de_entrega` | **NO** | 0 / 208 | **0,00%** | **No existe en el dataset**. Socrata responde error 400 (`No such column`). |

### Medición de `codigo_principal_de_categoria` (UNSPSC)
Se midió el comportamiento de este campo sobre **2.468 procesos competitivos** publicados durante una semana completa (`2026-10-09` al `2026-10-16`):
- Con valor `"UNSPECIFIED"`: **2.445 procesos (99,07%)**.
- Con código numérico real (ej. `"V1.72121100"`): **23 procesos (0,93%)**.
- Vacíos / nulos: **0 (0,00%)**.

> [!WARNING]
> **Conclusión sobre UNSPSC**: El campo `codigo_principal_de_categoria` viene con el texto `"UNSPECIFIED"` en el 99,07% de los casos recientes. **El reporte NO debe considerarlo un código UNSPSC confiable**, ni el Agente 2 debe fundamentar en él la clasificación del objeto contractual.

---

## 4. Medición Real del Dataset de Anexos `dmgg-8hin` (2026-10-09 vs. 2026-10-16)

El dataset `dmgg-8hin` ("SECOP II - Archivos Descarga Desde 2025") indexa los archivos vinculados a través del identificador `proceso` = `id_del_portafolio` (`CO1.BDOS.XXXXX`).

### A. Unidad de Medida de `tamanno_archivo`
- El campo `tamanno_archivo` viene expresado estrictamente en **BYTES** (número entero).
  - Ejemplos de valores reales: `4993` = ~4,88 KB; `377579` = ~368,7 KB; `50457413` = ~48,1 MB.

### B. Medición Comparativa: Día Reciente vs. Día con Sincronización

Se midieron todos los portafolios de procesos competitivos en dos fechas exactas:

| Métrica Medida | **2026-10-16** (Publicación reciente / Día previo) | **2026-10-09** (7 días después / Sincronizado) |
|---|:---:|:---:|
| **Total procesos competitivos analizados** | 208 | 421 |
| **Procesos con al menos 1 archivo indexado** | **67 de 208 (32,21%)** | **353 de 421 (83,85%)** |
| **Procesos con 0 archivos en el dataset** | **141 de 208 (67,79%)** | **68 de 421 (16,15%)** |
| **Total de archivos encontrados** | 1.207 archivos | 8.310 archivos |
| **Archivos por proceso (promedio)** | 5,80 archivos | 19,74 archivos |
| **Archivos por proceso (rango min – max)** | 0 a 62 archivos | 0 a 142 archivos |
| **Tamaño mínimo de archivo** | 4.993 bytes (~4,9 KB) | 3.969 bytes (~3,9 KB) |
| **Tamaño mediana de archivo** | 377.579 bytes (~368,7 KB) | 375.045 bytes (~366,3 KB) |
| **Tamaño promedio de archivo** | 1.861.283 bytes (~1,77 MB) | 2.079.538 bytes (~1,98 MB) |
| **Tamaño máximo de archivo** | 50.457.413 bytes (~48,1 MB) | 51.178.667 bytes (~48,8 MB) |

### C. Consecuencias para la Opción "B-light" (Listado de nombres y tamaños de anexos)
- Para los procesos recién publicados (**el día de HOY**), **el 67,79% de los procesos aún no tienen archivos indexados en `dmgg-8hin`**.
- Aunque el 32,21% sí tiene archivos (y sus enlaces binarios directos descargan con HTTP 200 sin captcha), **una dependencia estricta de `dmgg-8hin` en el pipeline diario dejaría sin anexos a más de dos tercios de las oportunidades del día**.
- Por ende, la opción "B-light" **no puede ser un requisito obligatorio de entrada para el Agente 2**, sino a lo sumo un enriquecimiento condicional opcional (*best-effort*).

---

## 5. Resumen de Decisiones y Recomendación para la Etapa 3B

1. **Opción A (Texto completo vía Scraping web)**: **DESCARTADA**. El portal web SECOP II bloquea el 100% de las peticiones automáticas con Google ReCaptcha.
2. **Opción B (Descarga y lectura del contenido de PDFs)**: **DESCARTADA / NO APROBADA**. Archivos de hasta 50 MB, promedios de 20 anexos por proceso y latencia/costo de tokens inmanejable.
3. **Opción B-light (Listado de archivos/anexos)**: **PENDIENTE DE VERIFICACIÓN / BEST-EFFORT**. Solo disponible para ~32% de los procesos en su día de publicación. No debe frenar la generación del resumen.
4. **Opción C (Metadata Enriquecida de `p6dx-8zbt`)**: **BASE APROBADA**.
   - Disponibilidad del 100% el mismo día de publicación.
   - Campos de valor verificado:
     - `nombre_del_procedimiento` y `descripci_n_del_procedimiento` (objeto).
     - `precio_base` (presupuesto en COP).
     - `fecha_de_recepcion_de` (cierre de ofertas, 100% lleno).
     - `duracion` y `unidad_de_duracion` (plazo de ejecución, 100% lleno).
     - `numero_de_lotes` (división por lotes, 100% lleno).
     - `entidad`, `nombre_de_la_unidad_de`, `departamento_entidad`, `ciudad_entidad` (comprador y ubicación).
     - `modalidad_de_contratacion` y `justificaci_n_modalidad_de` (marco legal).
     - `urlproceso` (enlace oficial directo para que el usuario humano ingrese con su cuenta de SECOP II a descargar los pliegos).
   - Consumo estimado de tokens: **300 a 450 tokens por proceso**, 100% determinista y sin riesgo de corte de créditos.

---

## 6. Aspectos que NO se Pudieron Verificar

1. **Causa del retraso en `dmgg-8hin`**: No es posible verificar si los 141 procesos de 2026-10-16 sin anexos en Socrata no tienen documentos en la plataforma transaccional de SECOP II o si se debe exclusivamente al retraso de replicación de datos.gov.co, dado que las páginas de SECOP II están protegidas por Google ReCaptcha.
2. **Requisitos habilitantes estructurados (RUP, índices financieros, experiencia)**: Se verificó que ninguna de las 59 columnas de `p6dx-8zbt` almacena los requisitos habilitantes de forma estructurada; dichos requisitos solo constan en los pliegos redactados en PDF por cada entidad.
