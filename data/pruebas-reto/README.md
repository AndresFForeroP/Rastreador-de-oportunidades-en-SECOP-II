# Directorio de Evidencias Técnicas — Reto Agente 2026

Este directorio (`data/pruebas-reto/`) contiene toda la evidencia documental, registros de ejecución, benchmarks de evaluación y telemetría de pruebas requeridas para la validación y auditoría de los hitos **S1, S2, S3 y S4**.

> ⚠️ **Regla de Commits**:
> A diferencia de los volcados crudos de la API (`data/dias/`), todos los archivos bajo `data/pruebas-reto/` **son committeables y deben mantenerse en el repositorio Git**.
> Ningún archivo individual debe superar **5 MB** y está estrictamente prohibido registrar claves secretas o tokens de autenticación.

---

## 1. Estructura Real del Directorio

```text
data/pruebas-reto/
  README.md            # Este archivo de índice y documentación de evidencias
  ejecuciones/         # Libro mayor y evidencias de corridas históricas
    registro.jsonl     # Ledger histórico (1 línea JSON por corrida, 7 corridas registradas)
    RESUMEN.md         # Tabla Markdown de corridas y métricas financieras/tokens acumuladas
    <ejecucionId>/     # Subcarpeta por corrida individual con sus artefactos inmutables
      reporte.json     # Reporte consolidado de la corrida en JSON
      reporte.md       # Reporte consolidado de la corrida en Markdown
      tokens.jsonl     # Desglose de tokens consumidos por invocación
      trazas.json      # Árbol compacto de trazas de LangSmith (cuando está disponible)
  costos/              # Historial y reportes de costos financieros (S3-2)
  evaluacion/          # Set propio de 55 casos y resultados de benchmark (S3-3 a S3-5)
    casos-sin-etiquetar.json  # 55 casos con etiquetas Ground Truth del usuario humano
    claves-privadas.json      # Metadatos completos de los 55 casos y claves privadas (Bloques A y B)
    resultados/
      linea-base/             # Evaluación del Agente 1 (resumen.md, resultados.json, matriz.csv)
      <timestamp>-agentes/    # Invariantes Agentes 2 y 3 (resumen.md, resultados.json, hoja-revision-humana.md)
  carga/               # Telemetría de la semana de carga (S4: 12h desatendido / 1.000 unidades) [PENDIENTE]
    state/             # Estado persistente del daemon y marcas de reanudación
    events/            # Registro cronológico de eventos operativos y fallas recuperadas
    log/               # Registro continuo de ejecución del runner
    resources/         # Métricas de consumo de CPU, memoria y red
    reports/           # Informes consolidados de la corrida de carga
```

---

## 2. Detalle de Componentes Implementados (Hito S3)

### A. Libro Mayor de Ejecuciones (`ejecuciones/`)
- **`registro.jsonl`**: Ledger inmutable en formato JSON Lines. Cada ejecución del sistema (`src/index.ts`, evaluación o carga) registra automáticamente: `ejecucionId`, fecha/hora UTC, duración en segundos, tipo (`"normal"` | `"evaluacion"` | `"carga"`), modo (`"produccion"` | `"prueba"` | `"evaluacion"`), candidatos pre-filtrados, clasificados aptos, resúmenes generados, documentos estructurados, tokens de entrada, salida, razonamiento y total, costo en USD y commit hash.
- **`RESUMEN.md`**: Tabla Markdown generada automáticamente por `src/pruebas/registro-ejecuciones.ts`. Registra actualmente 7 ejecuciones (100% exitosas) con un gasto acumulado de **$ 1.7263 USD** y **1.050.972 tokens facturados**.

### B. Gestión de Precios y Costos (`costos/`)
- Calibración de tarifas oficiales en `config/precios.json`: $2.00 / 1M entrada, $6.00 / 1M salida para `grok-4.6`.
- Comando CLI `pnpm costos` para auditoría y proyección de costos financieros en USD.
- Procedimiento empírico de calibración documentado en `docs/PRECIOS.md`.

### C. Benchmark de Evaluación Humana (`evaluacion/`)
- **55 casos reales** de contratación pública en Colombia distribuidos en:
  - **Bloque A (40 casos viables)**: Candidatos pre-filtrados para medir clasificación del Agente 1.
  - **Bloque B (15 casos de control)**: Procesos descartados por código para medir la tasa de falso descarte.
- **Línea Base del Agente 1 (`resultados/linea-base/`)**:
  - Exactitud: 85.0%
  - Precisión: 80.6%
  - Recall: 100.0% (25 de 25 oportunidades detectadas, 0 falsos negativos)
  - Falsos positivos graves: 3 (7.5%)
- **Chequeo de Invariantes de Agentes 2 y 3 (`resultados/<timestamp>-agentes/`)**:
  - Evaluación sobre 10 casos deterministas y 3 casos con invocación forzada de LLM (`--siempre-agente`).
  - Agente 2: 100% de cumplimiento en datos oficiales, números respaldados, claves reales y no atribución de lectura de pliegos.
  - Agente 3: 100% en origen de ítems, aviso oficial y respaldo legal; detección de fallo de duplicación de nombres de anexos provenientes de `dmgg-8hin`.
  - Hoja de revisión humana de fidelidad (`hoja-revision-humana.md`) y agregador CLI (`pnpm evaluar:hoja`).

---

## 3. Estado de Hitos

| Hito | Estado | Evidencias Principales |
|---|:---:|---|
| **Hito S1 (Pipeline y Grafo)** | **COMPLETO** | Grafo LangGraph de 5 nodos, `data/entregas/`, reportes JSON/MD |
| **Hito S2 (Agentes y Herramientas)** | **COMPLETO** | Herramientas `filtro_basico`, `obtener_ficha_proceso`, `armar_lista_documentos`, catálogo auditado |
| **Hito S3 (Benchmark y Costos)** | **COMPLETO** | Benchmark de 55 casos, matriz de confusión, invariantes Agentes 2 y 3, calibración de precios USD |
| **Hito S4 (Semana de Carga: 12h / 1.000 unidades)** | **PENDIENTE** | Estructura en `data/pruebas-reto/carga/` preparada; pendiente de ejecución en hito S4 |
