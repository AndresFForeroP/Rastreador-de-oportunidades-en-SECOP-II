# CONTEXTO S3 & S4 — Rastreador de Oportunidades en SECOP II para Pymes

> **DOCUMENTO DE GOBERNANZA TÉCNICA (S3 & S4)**:
> Este documento define las reglas globales inmutables, la estructura de evidencias bajo `data/pruebas-reto/`, los requerimientos conocidos de los hitos S3 y S4, y los ítems abiertos pendientes de confirmación oficial.

---

## 1. Reglas Globales Inmutables

Estas reglas aplican estrictamente a todas las etapas de desarrollo, evaluación y carga:

1. **Lectura previa y secretos**:
   - Siempre leer `docs/CONTEXTO.md` primero.
   - NUNCA leer, imprimir en consola, modificar ni commitear archivos `.env` ni credenciales.
   - Los secretos jamás se hardcodean en código ni en pruebas.

2. **No confiar en la memoria para APIs**:
   - Para LangChain, LangGraph, LangSmith y Docker: consultar la documentación oficial y los archivos de tipos instalados (`.d.ts`).
   - Si la realidad de la librería difiere de una instrucción o prompt, reportarlo explícitamente antes de asumir comportamientos.

3. **Pasos pequeños, TypeScript estricto y ESM**:
   - Avanzar en pasos incrementales y ejecutables; nunca dejar código roto o con fallos de compilación (`pnpm typecheck` siempre debe dar 0 errores).
   - TypeScript estricto con imports relativos que incluyan obligatoriamente el sufijo `.js`.
   - Comentarios de código y documentos generados en idioma español.

4. **Guarda estricta de créditos**:
   - Cualquier comando que invoque al LLM debe operar por defecto con un tope pequeño (p. ej., máx 1 página de 25 candidatos para Agente 1, máx 5 procesos para Agentes 2 y 3).
   - Se requiere una bandera explícita (`--completo`) para procesar lotes mayores.
   - Prohibido realizar bucles de invocación a LLMs sin un tope duro (*hard cap*).

5. **Regla de honestidad sobre precios y costos**:
   - Los precios de los modelos **NUNCA se inventan ni se asumen**.
   - Provienen exclusivamente de `config/precios.json`, configurado por el usuario.
   - Si el archivo falta o no tiene configurado el modelo, los scripts deben reportar únicamente cantidades de tokens facturados y mostrar explícitamente `"precio no configurado"`.

6. **Etiquetas de Ground Truth exclusivas del usuario**:
   - Las etiquetas de evaluación (*ground truth* / salida esperada) son redactadas **ÚNICAMENTE por el usuario**.
   - Los agentes y asistentes nunca deben auto-generar, autocompletar, sugerir ni alterar etiquetas de verdad de terreno sin supervisión humana.

7. **Prohibición de lectura de pliegos oficiales**:
   - Los pliegos oficiales en el portal transaccional de SECOP II están bajo ReCaptcha y no son legibles de forma automatizada.
   - Ningún agente debe declarar ni sugerir que leyó el pliego, ni declarar requisitos como "obligatorios" si provienen de datos abiertos o del catálogo orientativo.

8. **Comportamiento en producción vs. modos especiales**:
   - En producción, el sistema procesa **únicamente procesos publicados HOY** (hora legal de Colombia, UTC-5).
   - Los modos de prueba histórica, evaluación y carga deben activarse mediante banderas o variables explícitas.
   - Toda salida, reporte o entrega producida debe portar explícitamente el campo `modo` (`"prueba"` | `"evaluacion"` | `"carga"` | `"hoy"`).

9. **Integridad del README.md**:
   - `README.md` **NO debe contener enlaces a videos ni mención de ellos** (la entrega del video se realiza de forma independiente por el canal oficial del reto).
   - Toda cifra, métrica, rendimiento o afirmación cuantitativa en el `README.md` debe provenir comprobablemente de un archivo dentro de `data/pruebas-reto/` o ser eliminada.

10. **Evidencias en `data/pruebas-reto/`**:
    - Toda la evidencia de pruebas, corridas, costos, evaluaciones y carga reside en `data/pruebas-reto/`.
    - Esta carpeta **debe ser committeable** (nunca ignorada en `.gitignore`).
    - Ningún archivo individual debe superar 5 MB (emitir advertencia si ocurre).
    - Prohibido almacenar secretos o tokens de autenticación dentro de las evidencias.

---

## 2. Requerimientos de Hitos y Estado de Avance

### Hito S3: Datos reales y Evaluación [COMPLETO]
- **Set de evaluación propio**: Construcción de un benchmark representativo con **55 casos reales** de contratación pública en Colombia, con etiquetas humanas (*Ground Truth* redactado exclusivamente por el usuario) ([`data/pruebas-reto/evaluacion/casos-sin-etiquetar.json`](../data/pruebas-reto/evaluacion/casos-sin-etiquetar.json) y [`claves-privadas.json`](../data/pruebas-reto/evaluacion/claves-privadas.json)).
- **Línea base Agente 1**: Evaluación con inyección de dependencias ([`src/tools/evaluar.ts`](../src/tools/evaluar.ts)), registrando 85.0% de exactitud, 80.6% de precisión y 100.0% de recall ([`data/pruebas-reto/evaluacion/resultados/linea-base/`](../data/pruebas-reto/evaluacion/resultados/linea-base/)).
- **Chequeo de invariantes Agentes 2 y 3**: Evaluación de invariantes lógicas y hoja de revisión humana de fidelidad ([`src/tools/evaluar-agentes.ts`](../src/tools/evaluar-agentes.ts), [`src/tools/evaluar-hoja.ts`](../src/tools/evaluar-hoja.ts)).
- **Reporte de costo por tarea**: Calibración en `config/precios.json` ($2.00 / 1M entrada, $6.00 / 1M salida) y comando CLI `pnpm costos`.
- **Libro mayor de ejecuciones**: Trazabilidad histórica en `data/pruebas-reto/ejecuciones/registro.jsonl` y `RESUMEN.md` (7 corridas registradas).
- **Auditoría de afirmaciones**: Documentado en `docs/AUDITORIA-README.md`.

### Hito S4: Semana de carga [S4-0 A S4-6 COMPLETADOS — INFRAESTRUCTURA LISTA PARA CORRIDA DE 12H]
- **1.000 o más unidades de trabajo**: Procesamiento a escala de tareas completas resueltas de principio a fin (*end to end*).
- **12 horas desatendido**: Ejecución continua y autónoma durante al menos 12 horas seguidas sin operación ni reinicios manuales, verificada con el consumo real de la llave del reto en el gateway.
- **Bitácora completa por tarea**: Registro en tiempo real (`bitacora-tareas.csv` y `bitacora-tareas.jsonl`) de cada tarea al finalizar con hora, entrada, resultado, éxito/fallo, costo, errores y recuperación bajo `data/pruebas-reto/carga/`.
- **Bitácora oficial consolidada y resumen de entrega**: Implementado en `src/carga/bitacora.ts` (`pnpm bitacora`), con verificación de consistencia entre datos de máquina, tabla horaria de rendimiento, incidentes con recuperación, telemetría de Docker y preservación de notas del operador.
- **Daemon desatendido y cola histórica con ritmo**: Implementado en `src/daemon.ts` con control de presupuesto estricto, límite de concurrencia a 2 llamadas simultáneas y *heartbeat* cada 60s.
- **Verificación pre-vuelo y reporte final**: Implementado en `src/tools/preflight.ts` (`pnpm preflight` con dictamen **GO / NO-GO**) y `src/tools/reporte-carga.ts` (`pnpm reporte:carga` con dictamen **PASS / FAIL** y generación de `REPORTE-FINAL.md`).

---

## 3. Criterios Oficiales de S4 y Decisiones de Implementación (S4-0)

### 3.1. Criterios Oficiales Recibidos (S4)

1. **1.000 o más unidades de trabajo**: Una unidad es una tarea completa que el agente resuelve de principio a fin (*end to end*). Las llamadas aisladas a Grok no cuentan; las tareas terminadas sí.
2. **12 horas desatendido**: El agente corre al menos 12 horas seguidas sin que nadie lo opere ni lo reinicie a mano. Se verificará con el consumo real de la llave del reto (*challenge key*) en el gateway, por lo que la corrida debe usar la llave del reto.
3. **Bitácora completa**: Un registro de cada tarea con hora, entrada, resultado, éxito o fallo y costo, además de los errores y cómo se recuperó el agente. En formato CSV o JSON dentro del repositorio.
- **Fecha límite (Deadline)**: Sábado 7 de noviembre de 2026, 23:59 hora de la Ciudad de México.
- **Entrega (Submission)**: Enlace al repositorio con la bitácora, un resumen corto (unidades totales, tasa de éxito, costo total, costo por tarea) y, opcionalmente, un video corto que se envía por separado (**jamás enlazado ni mencionado en el `README.md`**).

### 3.2. Decisiones Técnicas Registradas e Implementadas

- **Unidad de trabajo (`unidad_de_trabajo`)**: Equivale a **un proceso de SECOP II analizado de principio a fin (*end to end*)**: entra al pipeline (tras superar el pre-filtro determinista) y termina con un resultado final registrado (el veredicto del Agente 1 y, cuando `aptoPyme === "si"`, también el resumen del Agente 2 y la lista de documentos del Agente 3) y queda marcado como éxito (`exito: true`) o fallo (`exito: false`).
  - Los procesos descartados por el pre-filtro de código **NO se cuentan**.
  - Las llamadas individuales al modelo **nunca se cuentan** como unidades.
  - Se mantienen en paralelo como cifras secundarias los conteos alternativos: (a) solo veredicto del Agente 1 (`veredicto_agente1`) y (b) procesos `"si"` completados íntegramente hasta el Agente 3 (`si_completados_123`), mostrando siempre las tres cifras.
- **Regla de éxito (`exito`)**: Una tarea se marca como éxito (`exito: true`) **únicamente** cuando el resultado estructurado final es válido y completo para ese proceso. Cualquier resultado de contingencia (*fallback*) como `"sin respuesta del modelo"`, `"error en invocación del modelo"`, `"fallback_por_error_modelo"` o un ítem estacionado sin completar sus etapas requeridas es un **FALLO (`exito: false`)** con la explicación registrada en el campo `recuperacion`.
- **Costo por tarea (`costoAsignadoUSD` y `costoDirectoUSD`)**:
  - El Agente 1 opera en páginas de hasta 25 procesos: el costo de la página se asigna en partes iguales entre los procesos evaluados en dicha página (`costoAsignadoUSD = costoPaginaA1 / nProcesosPagina`) y se declara explícitamente como costo prorrateado de página.
  - Los costos de los Agentes 2 y 3 corresponden a invocaciones individuales por proceso y se registran como costo directo (`costoDirectoUSD = costoA2 + costoA3`).
  - Si los precios no están configurados (`null`), los campos en USD se dejan vacíos (`null` en JSONL y celda vacía en CSV) y se conservan los conteos de tokens (`tokensEntrada`, `tokensSalida`, `tokensTotal`).
- **Llave y Gateway del Reto (`RETO_BASE_URL`)**: El modo daemon y el modo de carga se niegan a iniciar a menos que la URL base del modelo sea el gateway oficial del reto (`https://api.reto.pltk.mx/v1`, leída desde `src/llm.ts`) y la llave `RETO_KEY` esté presente (sin imprimir jamás la llave; se imprime únicamente el `hostname`: `api.reto.pltk.mx`).
- **Bitácora por tarea (`src/carga/bitacora-tareas.ts`)**: Escribe **una fila por tarea en el momento exacto en que finaliza** (modo *append* con `sync` a disco, nunca reconstruida desde memoria) en `data/pruebas-reto/carga/bitacora-tareas.csv` y `data/pruebas-reto/carga/bitacora-tareas.jsonl`, garantizando idempotencia mediante estado persistente para que un reinicio jamás duplique la fila de una misma tarea.

### 3.3. Decisiones y Correcciones Técnicas de S4-2+3

1. **Definición por defecto de unidad de trabajo**:
   - Se fija `UNIDAD_TRABAJO_POR_DEFECTO: DefinicionUnidadTrabajo = "oficialFinAFin"`.
   - Las condiciones de parada del daemon evalúan estrictamente `conteo.exitosasFinAFin >= metaUnidades`. Los procesos fallidos (`exito: false`) no computan para la meta.
   - Se mantienen en paralelo los contadores de las otras definiciones (`evaluadosAgente1`, `clasificadosSi`, `completadosAgentes2y3`, etc.).

2. **Tasa única de "sí" y calibración del estimador de carga**:
   - Causa de la discrepancia previa (6.6% vs 81.8%): El cálculo previo en scripts exploratorios medía la proporción sobre sub-lotes pequeños que incluían los 40 casos etiquetados de calibración (diseñados intencionalmente con 31 casos positivos).
   - Tasa única oficial confirmada: **6.63%** basada en $N = 1.569$ candidatos procesados en el libro mayor (`data/pruebas-reto/ejecuciones/registro.jsonl`), arrojando 104 procesos clasificados como "sí".
   - Los escenarios 3 y 4 del estimador de carga quedan explícitamente rotulados como meramente informativos.

3. **Política de precios en `config/precios.json` y calibración S4-8**:
   - Calibración realizada el 2026-11-06 a partir de las métricas reales del panel del reto:
     - Panel acumulado: 798 peticiones, 1.884.897 tokens de entrada, 359.101 de salida, costo total $10.81 USD.
     - Ledger local (`logs/tokens.jsonl`) al corte (772 llamadas): 1.804.255 entrada, 343.402 salida, 3.082.448 total.
     - **Discrepancia de tokens (~935.000 tokens)**: Corresponde a los tokens de razonamiento (`reasoning_tokens` en `output_token_details`) emitidos por Grok-4.6 e incorporados por el gateway en `tokens_total`.
     - **Llamadas no registradas (~26 llamadas)**: Correspondían a chequeos de `pnpm preflight` (`src/tools/preflight.ts`) y reintentos previos que no registraban en el ledger; se corrigió `preflight.ts` para registrar formalmente cada llamada.
     - **Precio efectivo calibrado**: $10.81 / (3.082.448 / 10^6) = **3.5070 USD por millón de tokens** (cota superior conservadora). Se configuró en `config/precios.json` con `porMillonEntrada: 3.507` y `porMillonSalida: 3.507`.
     - **Regla de costo final**: El costo final oficial reportado de la prueba de carga será el delta real del panel del reto prorrateado por tokens entre las unidades completadas.

4. **Punto único de contabilidad en la Guarda de Presupuesto**:
   - Se eliminaron las interceptaciones duplicadas y se consolidó el control y registro en un único punto canónico: `ChatOpenAI.prototype._generate`.
   - Se verificó con una llamada real mínima:
     - Guarda de presupuesto: 1 llamada, 872 tokens (652 entrada, 2 salida, 218 razonamiento).
     - Módulo de costos: 1 llamada, 872 tokens.
     - Coincidencia exacta del 100% y cero conteos dobles.
   - Se implementó un limitador de concurrencia a nivel de pasarela (`LimitadorConcurrenciaGateway`) con concurrencia máxima 2 y manejo automático de respuestas HTTP 429 respetando el encabezado `Retry-After`.

5. **Daemon desatendido y cola de procesos históricos (`src/daemon.ts`)**:
   - **Cola histórica**: En modo `--fuente=historico`, se consume una cola explícita de días pasados (`modo: "carga"`), procesando desde el día más reciente hacia atrás, agotando un día completo antes de continuar con el anterior. Se omiten días con menos de 150 procesos (registrando el evento respectivo).
   - **Nota para el `README.md`**: El `README.md` debe explicitar claramente que las corridas con `--fuente=historico` utilizan una cola de prueba de procesos reales de días anteriores de SECOP II.
   - **Ritmo de consumo (*pacing*)**: El daemon dosifica el trabajo a lo largo de la ventana de horas solicitada (`tasa = unidades / horas` por hora), durmiendo entre lotes para mantener un consumo continuo y sostenido en la pasarela del reto.
   - **Idempotencia absoluta**: Sincronización en el arranque entre `bitacora-tareas.jsonl` y `GestorEstadoCarga` mediante `idsExcluidos`. Cualquier interrupción por `SIGINT`, `SIGTERM` o detención inesperada retoma exactamente donde quedó sin duplicar tareas ni sobrecontar unidades.
   - **Monitoreo y telemetría**: *Heartbeat* emitido cada 60s en `data/pruebas-reto/carga/heartbeat.json`, trazas LangSmith por ciclo (`secop-ciclo`), y registro en el libro mayor como tipo `"daemon"`.

### 3.4. Infraestructura Docker, Healthcheck y Muestreo de Recursos (S4-4)

1. **Servicio Docker Compose `daemon`**:
   - Definido en `docker-compose.yml` junto al servicio puntual original `agent` (que se mantiene intacto).
   - Configuración operativa: `build: .`, `command: ["pnpm", "daemon"]`, `env_file: .env`, `restart: unless-stopped`, `init: true`, `stop_grace_period: 60s`, volúmenes montados en `./data:/app/data` y `./logs:/app/logs`, sin puertos expuestos, y rotación de registros `json-file` (`max-size: "10m"`, `max-file: "5"`).
   - Variables de entorno no secretas documentadas en la plantilla comitteable [`.env.carga.example`](../.env.carga.example).
   - Imagen resultante: `rastreador-de-oportunidades-en-secop-ii-daemon:latest` (745 MB).

2. **Healthcheck en Contenedor (`scripts/healthcheck.js`)**:
   - Script Node.js nativo que evalúa `data/pruebas-reto/carga/heartbeat.json`.
   - Reporta estado no saludable (*unhealthy*, código de salida 1) si:
     - El archivo no existe o está corrupto.
     - El campo `status` es `"error"` o `"error_ciclo"`.
     - La antigüedad del latido supera 3 veces el intervalo del ciclo (`3 * intervaloCicloSeg`).
   - Integrado en `docker-compose.yml` con intervalo de 30s, timeout de 10s, 3 reintentos y 40s de gracia inicial.

3. **Muestreo Periódico de Recursos en Windows (`scripts/muestrear-docker.ps1`)**:
   - Script PowerShell que consulta cada 5 minutos `docker stats --no-stream` para registrar uso de CPU, uso/límite de memoria, porcentaje de memoria, tiempo de actividad (*uptime*) y conteo de reinicios vía `docker inspect --format '{{.RestartCount}}'` (sin imprimir jamás variables de entorno resueltas).
   - Salida persistida en tiempo real en [`data/pruebas-reto/carga/recursos.csv`](../data/pruebas-reto/carga/recursos.csv).

4. **Procedimiento Operativo y Runbook (`docs/RUNBOOK-12H.md`)**:
   - Documento en español que detalla la lista de verificación del host (plan de energía para no suspender nunca, conexión a corriente CA, inicio automático de Docker Desktop, pausa de actualizaciones automáticas de Windows, estabilidad de red y espacio en disco).
   - Protocolo de parada limpia (`docker compose stop daemon`), recuperación automática idempotente ante reinicios, y directrices estrictas de no exponer credenciales (`docker compose config`, `docker inspect`, etc.).

### 3.5. Generador de Bitácora Oficial, Resumen S4 y Consistencia (S4-5)

1. **Bitácora Integral Basada en Datos de Máquina (`src/carga/bitacora.ts`)**:
   - Genera [`data/pruebas-reto/carga/bitacora-carga.md`](../data/pruebas-reto/carga/bitacora-carga.md) de forma 100% determinista a partir de archivos de máquina (`bitacora-tareas.csv`, `eventos.jsonl`, `progreso.jsonl`, `estado.json`, `heartbeat.json`, `recursos.csv`, `registro.jsonl` y `logs/tokens.jsonl`), sin intervención ni inferencias de modelos LLM (costo cero, ejecución instantánea).
   - Secciones estructuradas:
     - **Verificación de consistencia de datos de máquina** al inicio del reporte.
     - **Configuración operativa** (modelo, gateway hostname `api.reto.pltk.mx`, presupuesto, modo, definición de unidad).
     - **Línea de tiempo** (inicio, fin, duración en horas y segundos, ritmo de pacing, estado de reinicios).
     - **Tabla horaria de rendimiento**: Ventanas de 1 hora con unidades fin a fin concluidas, tasa de éxito horaria, unidades acumuladas, gasto USD, tokens facturados, latencia promedio y percentil 90 (p90), errores por tipo, backoffs y circuit breakers.
     - **Errores y recuperación**: Registro exhaustivo de incidentes con timestamp, tipo, elementos afectados, estrategia de mitigación (*retry*, *backoff*, *resume after restart*, *parked as failed*) y tiempo de recuperación.
     - **Monitoreo de recursos**: Min/Avg/Max de CPU y RAM, uptime y conteo de reinicios a partir de `recursos.csv`.
     - **Desglose de costos y tokens**: Método de prorrateo por página en Agente 1 y directo en Agentes 2 y 3.
     - **Totales acumulados oficiales**: Primaria fin a fin y métricas secundarias en paralelo.
     - **Notas del operador**: Sección preservada intacta entre sucesivas regeneraciones.

2. **Resumen Ejecutivo para la Plataforma (`docs/RESUMEN-S4.md`)**:
   - Texto conciso en español listo para pegar en la plataforma de entrega: unidades totales bajo la definición oficial y secundarias, tasa de éxito, gasto financiero, tokens totales, costo por tarea con desglose del método de asignación, duración desatendida y reinicios.
   - Conciliación de consistencia financiera Gateway vs Ledger al suministrar `--gasto-panel-usd=<valor>`.

3. **Verificación Estricta de Consistencia**:
   - Valida invariantes cruzados: Filas en CSV vs unidades en `estado.json` vs `progreso.jsonl` vs libro mayor (`registro.jsonl`); tokens en CSV vs llamadas registradas en `logs/tokens.jsonl`; costos de CSV vs módulo de costos; y unicidad estricta de `tareaId` (cero duplicados).
   - Cualquier discrepancia o delta de llamadas en vuelo se resalta obligatoriamente en negrita (`**MISMATCH**`), garantizando transparencia técnica total.

4. **Integración Operativa (`pnpm bitacora`)**:
   - Comando directo en `package.json` (`pnpm bitacora`).
   - El daemon (`src/daemon.ts`) invoca la regeneración automáticamente cada hora de ejecución continua y al finalizar en su bloque `finally`.

### 3.6. Verificación Pre-vuelo, Reporte Final y Sección README (S4-6)

1. **Chequeo Integral Pre-vuelo (`src/tools/preflight.ts`, `pnpm preflight`)**:
   - Emite dictamen estructurado **GO / NO-GO** evaluando 12 comprobaciones críticas:
     1. Presencia de nombres de variables en `.env` (`RETO_KEY`, `LANGSMITH_API_KEY`, etc.; **NUNCA imprime valores**).
     2. Autenticación exitosa con LangSmith (`https://api.smith.langchain.com/info`, HTTP 200).
     3. Pasarela oficial alcanzable con **1 llamada real mínima** al modelo (reporta tokens reales y costo).
     4. Estado de precios en `config/precios.json`.
     5. Presupuesto y meta de unidades provistos.
     6. Consistencia e idempotencia del archivo de estado persistente (`estado.json`).
     7. Permisos de escritura garantizados en `data/pruebas-reto/`.
     8. Espacio libre en disco disponible (`statfs`, mínimo recomendado: 5 GB).
     9. Estado activo de Docker Engine.
     10. Existencia de la imagen Docker construida (`rastreador-de-oportunidades-en-secop-ii-daemon:latest`).
     11. Estado del árbol Git (`git status --porcelain` con listado de pendientes).
     12. Escaneo de seguridad en archivos staged (cero secretos ni llaves; reporta solo rutas de archivo).

2. **Generador del Reporte Final de Validación (`src/tools/reporte-carga.ts`, `pnpm reporte:carga`)**:
   - Evalúa formalmente los criterios oficiales del reto con dictamen **PASS / FAIL**:
     - Criterio 1: Unidades de trabajo completadas ($\ge 1.000$ bajo definición oficial fin a fin).
     - Criterio 2: Ventana desatendida ($\ge 12$ horas sin intervención humana).
     - Criterio 3: Unicidad e idempotencia absoluta (0 tareaId duplicados).
     - Criterio 4: Consistencia cruzada (CSV == estado.json == progreso.jsonl == ledger).
     - Criterio 5: Calibración financiera y control estricto de tokens con opción `--gasto-panel-usd=<n>`.
     - Criterio 6: Estabilidad y telemetría del contenedor Docker (0 caídas inesperadas).
   - Genera el artefacto oficial [`data/pruebas-reto/carga/REPORTE-FINAL.md`](../data/pruebas-reto/carga/REPORTE-FINAL.md).
   - Preserva la sección "Notas del operador" entre regeneraciones.

3. **Sección Oficial en `README.md`**:
   - Añadida sección 13 "Prueba de Carga Desatendida (Hito S4)" con cifras empíricas reales del ensayo de Docker, enlaces relativos a las evidencias y rotulado honesto de estado "PENDIENTE" previo a la corrida final de 12 horas.
   - **Sin enlaces ni menciones a videos**, conforme a la directriz inmutable de entrega.

---

## 4. Estructura del Directorio de Evidencias `data/pruebas-reto/`

```text
data/pruebas-reto/
  README.md            # Índice maestro y explicación de contenidos
  ejecuciones/         # Registro histórico y corridas individuales
    registro.jsonl     # Libro mayor (ledger) con 1 línea JSON por ejecución
    RESUMEN.md         # Tabla Markdown de las últimas ejecuciones y acumulados
    <ejecucionId>/     # Carpeta por corrida (reporte.json, reporte.md, tokens.jsonl, trazas.json)
  costos/              # Reportes consolidados de costos y precios
  evaluacion/          # Set de 55 casos, guías y resultados/benchmarks
    casos-sin-etiquetar.json  # Dataset con etiquetas Ground Truth humanas
    claves-privadas.json      # Metadatos completos y partición A/B
    resultados/
      linea-base/             # Evaluación del Agente 1
      <timestamp>-agentes/    # Evaluación de invariantes Agentes 2 y 3
  carga/               # Telemetría de la semana de carga (S4)
    bitacora-tareas.csv    # Bitácora oficial por tarea (UTF-8, RFC 4180, append en tiempo real)
    bitacora-tareas.jsonl  # Bitácora oficial por tarea en formato JSON Lines
    progreso.jsonl         # Réplica síncrona JSON Lines de progreso por tarea
    estado.json            # Estado persistente atómico e idempotencia entre reinicios
    heartbeat.json         # Heartbeat periódico con estado y límites
    recursos.csv           # Muestreo periódico de CPU, memoria y reinicios de Docker
    bitacora-carga.md      # Bitácora consolidada con desglose horario e incidentes
    REPORTE-FINAL.md       # Reporte final con evaluación PASS/FAIL por criterio oficial
    state/                 # Estado persistente del daemon
    events/                # Eventos operativos
    log/                   # Log continuo de la prueba
    resources/             # Uso de memoria, CPU y red
    reports/               # Informes consolidados de la corrida de 12h
```
