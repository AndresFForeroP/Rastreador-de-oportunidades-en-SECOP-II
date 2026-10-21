# Directorio de Evidencias Técnicas — Reto Agente 2026

Este directorio (`data/pruebas-reto/`) contiene toda la evidencia documental, registros de ejecución, benchmarks de evaluación y telemetría de pruebas de carga requeridas para la validación y auditoría de los hitos **S1, S2, S3 y S4**.

> ⚠️ **Regla de Commits**:
> A diferencia de los volcados crudos de la API (`data/dias/`), todos los archivos bajo `data/pruebas-reto/` **son committeables y deben mantenerse en el repositorio Git**.
> Ningún archivo individual debe superar **5 MB** y está estrictamente prohibido registrar claves secretas o tokens de autenticación.

---

## Estructura del Directorio

```text
data/pruebas-reto/
  README.md            # Este archivo de índice
  ejecuciones/         # Libro mayor y evidencias de corridas
    registro.jsonl     # Ledger histórico (1 línea JSON por corrida)
    RESUMEN.md         # Tabla Markdown de las últimas 20 corridas y métricas acumuladas
    <ejecucionId>/     # Subcarpeta por corrida individual con sus artefactos
      reporte.json     # Reporte consolidado de la corrida en JSON
      reporte.md       # Reporte consolidado de la corrida en Markdown
      tokens.jsonl     # Desglose de tokens consumidos en la corrida
      trazas.json      # Árbol compacto de trazas de LangSmith (si está disponible)
  costos/              # Reportes de costos financieros por tarea (S3)
  evaluacion/          # Set propio de 30+ casos y resultados de benchmark (S3)
    casos.json         # Dataset curado con etiquetas Ground Truth (solo redactadas por el autor)
    guia-anotacion.md  # Criterios humanos de etiquetado
    resultados/        # Salidas de evaluaciones automatizadas por marca de tiempo (<timestamp>/)
  carga/               # Telemetría de la semana de carga (S4: 12h desatendido / 1.000 unidades)
    state/             # Estado persistente del daemon y marcas de reanudación
    events/            # Registro cronológico de eventos operativos y fallas recuperadas
    log/               # Registro continuo de ejecución del runner
    resources/         # Métricas de consumo de CPU, memoria y red
    reports/           # Informes consolidados de la corrida de carga
```

---

## Contenido de las Subcarpetas

### 1. `ejecuciones/`
- **`registro.jsonl`**: Libro mayor central donde cada ejecución del sistema (`src/index.ts`, evaluación o carga) registra automáticamente una línea con: ID de ejecución, fecha/hora, duración, tipo, modo, parámetros, procesos procesados en cada etapa, tokens (entrada, salida, razonamiento, total), costo en USD (si aplica), estado y hash corto del commit.
- **`RESUMEN.md`**: Vista en tabla Markdown generada automáticamente con las últimas 20 corridas y métricas totales acumuladas.
- **`<ejecucionId>/`**: Copia aislada e inmutable de los reportes y registros de tokens generados en dicha corrida, evitando la pérdida de evidencia local tras el vencimiento de la retención de 14 días de LangSmith.

### 2. `costos/`
- Historial de reportes financieros generados por `src/tools/resumen-tokens.ts` cruzados contra `config/precios.json`.
- Si `config/precios.json` no está definido, los reportes indican `"precio no configurado"` respetando la regla inmutable de no inventar tarifas.

### 3. `evaluacion/`
- Benchmark con **30+ casos representativos** de SECOP II.
- Las etiquetas de verdad de terreno (*Ground Truth*) son definidas exclusivamente por el autor del proyecto y nunca alteradas por agentes de IA.
- Resultados de precisión, recall y matrices de confusión almacenados bajo `resultados/<timestamp>/`.

### 4. `carga/`
- Evidencia de soporte para el hito **S4** (ejecución desatendida durante 12 horas consecutivas y procesamiento de 1.000 unidades de trabajo).
- Almacena bitácoras de recuperación de caídas de red, reinicios de ciclo y curvas de uso de recursos en Docker.

---

*Cualquier cifra o afirmación cuantitativa expuesta en el `README.md` principal del repositorio debe estar respaldada por un archivo verificable dentro de esta carpeta.*
