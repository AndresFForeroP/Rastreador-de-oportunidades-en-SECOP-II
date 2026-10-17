# CONTEXTO — Rastreador de oportunidades en SECOP II

> Documento de arranque. Cada etapa nueva debe empezar leyendo este archivo.
> Reto: "Reto Agente 2026". Objetivo: rastrear oportunidades de SECOP II para pymes colombianas.

## 1. Arquitectura

Sistema multi-agente en TypeScript con LangChain / LangGraph. El modelo de razonamiento
**debe seguir siendo Grok** (gateway del Reto, `src/llm.ts`).

### Flujo diario (SOLO procesos publicados HOY)

```text
código:  descargar procesos de hoy            (src/datos/socrata.ts   -> descargarHoy)
código:  pre-filtro básico                    (src/filtro/prefiltro.ts -> prefiltrar)
Agente 1 "filtrador"   (tool filtro_basico)
Agente 2 "resumidor"   (tool leer_pliego)
Agente 3 "documentos"  (tool armar_lista_documentos)
código:  reporte final
```

Cada agente tiene su propio system prompt, salida estructurada con zod y nombre de traza.
No hay otra fecha en el código de producción.

### Archivos existentes / clave

| Archivo | Rol |
|---|---|
| `src/llm.ts` | `ChatOpenAI` apuntando al gateway Grok del Reto. |
| `src/cost.ts` | `registrarCosto` -> `logs/tokens.jsonl` (tokens por llamada). |
| `src/config/entorno.ts` | Carga `.env`; lee `SECOP_FECHA_PRUEBA`; `modoEjecucion()`. |
| `src/config/secop.ts` | Dataset, endpoint, paginación, modalidades competitivas. |
| `src/config/prefiltro.ts` | Parámetros editables del pre-filtro. |
| `src/datos/socrata.ts` | `fechaHoy()`, `descargarHoy()`. |
| `src/filtro/prefiltro.ts` | `prefiltrar()` -> `{ total, descartadosPorRegla, candidatos }`. |
| `src/herramientas/filtro-basico.ts` | Tool `filtro_basico` (25 candidatos/página, memoizado). |
| `src/agentes/prompts/filtrador.ts` | System prompt constante del Agente 1 (filtrador). |
| `src/agentes/filtrador.ts` | Agente 1 `agente_filtrador` (`createAgent` + Grok + `ResultadoPagina`). |
| `src/pipeline/filtrar-pymes.ts` | Runner: validación de IDs, concurrencia 2, reintentos y tokens. |
| `src/tools/correr-filtrador.ts` | CLI del Agente 1 (`pnpm filtrar`, flags `--max` y `--completo`). |
| `src/trazas.ts` | `iniciarTrazas`, `configEjecucion`, `opcionesTraceable`, `cerrarTrazas`. |
| `src/tools/probar-datos.ts` | Prueba de datos sin LLM (`pnpm probar:datos`). |
| `src/index.ts`, `src/test-grok.ts` | Esqueleto y prueba del gateway. |
| `Dockerfile`, `docker-compose.yml` | Ejecución en contenedor (`logs/` montado). |

### Trazas (LangSmith)

- Variables: `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT=secop-rastreador`.
- Si las trazas están activas pero la clave falta o es inválida: UNA advertencia y se sigue sin trazas.
- Pasos de código: `traceable(fn, opcionesTraceable({...}))` (registran resúmenes, no todas las filas).
- Llamadas LangChain/LangGraph: pasar `configEjecucion({ runName, tags, metadata })` como config.
- Metadata común: `modo` (`"produccion"` | `"prueba"`) y `fecha_prueba` si aplica.
- Llamar `iniciarTrazas()` al inicio y `cerrarTrazas()` antes de salir.

## 2. Reglas globales (válidas para todas las etapas)

- Nunca leer, imprimir, modificar ni commitear `.env`. Nunca hardcodear secretos.
- No confiar en la memoria para APIs de LangChain / LangGraph / LangSmith: leer la documentación
  oficial (https://docs.langchain.com/oss/javascript/) y revisar los tipos de la versión instalada.
  Si la realidad difiere del pedido, avisar en vez de adivinar.
- Pasos pequeños, ejecutar cada uno, corregir errores. Nunca dejar código que falle.
- TypeScript strict, ESM (imports relativos con sufijo `.js`). Comentarios en español.
- Toda llamada al LLM debe ser trazable en LangSmith y registrar tokens con `src/cost.ts`.
- **GUARDA DE CRÉDITOS**: los créditos de Grok son limitados. Todo comando que llame al LLM
  procesa por defecto una corrida PEQUEÑA (máx. 10 procesos) y requiere la bandera explícita
  `--completo` para procesar el día entero. Nunca iterar llamadas al LLM sin un tope duro.
- Preguntar cuando un secreto, un nombre de modelo o una decisión de producto no esté claro.
- Al final de cada etapa: listar archivos creados/cambiados, comandos ejecutados con su salida
  y lo que NO se pudo verificar.

### Regla de fecha

- Producción procesa SOLO los procesos con `fecha_de_publicacion_del` en
  `[hoy 00:00:00, mañana 00:00:00)`, hora de Colombia (UTC-5 fijo).
- `descargarHoy()` no recibe fecha. Si hoy no hay procesos: lista vacía + mensaje claro.
  **Nunca** se recurre a otra fecha.
- Única excepción de desarrollo: `SECOP_FECHA_PRUEBA=YYYY-MM-DD` (apagada por defecto).
  Imprime una advertencia visible y marca `modo: "prueba"` en las trazas. Solo en este modo
  se usa caché en `data/dias/<fecha>.json` (nunca para la fecha de hoy).

## 3. Diccionario de datos

### Dataset

- Nombre: "SECOP II - Procesos de Contratación"
- Id: `p6dx-8zbt`
- Endpoint: `https://www.datos.gov.co/resource/p6dx-8zbt.json`
- SoQL: `$where`, `$order`, `$limit`, `$offset`. Paginación de 1000 filas,
  `$order=id_del_proceso, :id` (`:id` = id interno de fila, desempata ids repetidos).
- 3 reintentos con backoff (1 s, 2 s, 4 s) ante errores de red, 5xx y 429.
- Socrata devuelve todos los valores como texto y **omite los campos nulos**.

### Campos usados (verificados contra el dataset)

| Campo Socrata | Tipo real | Uso | Notas |
|---|---|---|---|
| `id_del_proceso` | texto | `Candidato.id` | Ej. `CO1.REQ.11205497`. Puede repetirse. |
| `nombre_del_procedimiento` | texto | `nombre` | |
| `descripci_n_del_procedimiento` | texto | `descripcion` | Recortada a 2000 caracteres. |
| `entidad` | texto | `entidad` | |
| `departamento_entidad` | texto | `departamento` | |
| `ciudad_entidad` | texto | `ciudad` | A veces `"No Definido"`. |
| `tipo_de_contrato` | texto | `tipoDeContrato`, regla 3 | Ver valores abajo. |
| `modalidad_de_contratacion` | texto | `modalidad`, consulta, regla 1 | Ver modalidades competitivas. |
| `fase` | texto | `fase` | Existe en el esquema pero suele venir vacío (nulo). |
| `estado_de_apertura_del_proceso` | texto | regla 2 | Valores: `Abierto`, `Cerrado`. |
| `precio_base` | número como texto | `valor`, regla 4 | 0 / vacío / no numérico = desconocido. |
| `fecha_de_publicacion_del` | fecha `YYYY-MM-DDT00:00:00.000` | consulta, `fechaPublicacion` | Solo fecha (hora 00:00). |
| `urlproceso` | objeto `{ url }` | `url` | Con frecuencia es la URL genérica de login de SECOP. |

Otros campos disponibles (no usados aún): `nit_entidad`, `ordenentidad`, `referencia_del_proceso`,
`fecha_de_recepcion_de`, `fecha_de_apertura_de_respuesta`, `duracion`, `unidad_de_duracion`,
`estado_del_procedimiento`, `adjudicado`, `codigo_principal_de_categoria` (UNSPSC, ej. `V1.50301501`),
`subtipo_de_contrato`, `justificaci_n_modalidad_de`, `estado_resumen`.

### Modalidades competitivas (cadenas exactas)

- `Mínima cuantía`
- `Selección Abreviada de Menor Cuantía`
- `Selección abreviada subasta inversa`
- `Concurso de méritos abierto`
- `Licitación pública`
- `Licitación pública Obra Publica`

No incluidas (existen en el dataset): `Contratación directa`, `Contratación Directa (con ofertas)`,
`Contratación régimen especial`, `Contratación régimen especial (con ofertas)`,
`Seleccion Abreviada Menor Cuantia Sin Manifestacion Interes`, `Licitación Pública Acuerdo Marco de Precios`,
`Solicitud de información a los Proveedores`, `Enajenación de bienes ...`, `Subasta de prueba`.

### Valores observados de `tipo_de_contrato`

`Compraventa`, `Suministros`, `Prestación de servicios`, `Obra`, `Consultoría`, `Interventoría`,
`Arrendamiento de muebles`, `Negocio fiduciario`, `Servicios financieros`, `Seguros`, `Concesión`, `Otro`.

### Pre-filtro básico (primera regla que aplica, cada una contada)

1. `modalidad_no_competitiva` — modalidad fuera del conjunto competitivo (red de seguridad).
2. `estado_cerrado` — `estado_de_apertura_del_proceso` = `Cerrado`.
3. `tipo_contrato_excluido` — `tipo_de_contrato` en `["Seguros", "Concesión"]` (criterio editable).
4. `valor_supera_maximo` — `precio_base` > `VALOR_MAXIMO` (5 000 000 000 COP, editable).
5. `id_duplicado` — `id_del_proceso` ya visto.

### Candidato (objeto compacto para los agentes)

```ts
{
  id: string; nombre: string; descripcion: string /* máx 2000 */;
  entidad: string; departamento: string; ciudad: string;
  tipoDeContrato: string; modalidad: string; fase: string | null;
  valor: number | null; fechaPublicacion: string | null /* YYYY-MM-DD */; url: string | null;
}
```

### Observación operativa

El dataset se publica con retraso: el 2026-10-17 a media mañana, el día 16 no tenía procesos
competitivos y el 17 ninguno. Con la regla "solo hoy" es esperable que muchas corridas den 0 filas.
