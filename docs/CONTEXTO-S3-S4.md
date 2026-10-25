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

### Hito S4: Semana de carga [PENDIENTE]
- **1.000 unidades de trabajo**: Procesamiento a escala de 1.000 unidades (pendiente de ejecución).
- **12 horas desatendido**: Ejecución continua y autónoma en modo daemon / scheduler durante 12 horas seguidas (pendiente de ejecución).
- **Bitácora completa**: Registro continuo del ciclo de vida, eventos, consumo de recursos y fallas recuperadas bajo `data/pruebas-reto/carga/` (estructura preparada, pendiente de corrida).

---

## 3. Ítems Abiertos (Pendientes de Confirmación Oficial para S4)

> [!WARNING]
> **Definiciones y Criterios Oficiales No Confirmados para S4**:
> 1. **Definición de "Unidad de Trabajo"**: No se ha confirmado formalmente si 1 unidad de trabajo equivale a 1 proceso descargado de SECOP II, 1 candidato pre-filtrado, 1 proceso clasificado por el Agente 1, o 1 proceso completamente estructurado con ficha y documentos (Agentes 2 y 3).
> 2. **Criterios exactos de aprobación para la bitácora de 12 horas**: Formato específico de la telemetría operativa y métricas de recursos requeridas por la rúbrica oficial.
> 
> *Estrategia*: Mantener la arquitectura granular bajo `data/pruebas-reto/carga/` (`state/`, `events/`, `log/`, `resources/`, `reports/`) para que cualquier interpretación oficial quede soportada.

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
  carga/               # Telemetría de la semana de carga (S4) [PENDIENTE]
    state/             # Estado persistente del daemon
    events/            # Eventos operativos
    log/               # Log continuo de la prueba
    resources/         # Uso de memoria, CPU y red
    reports/           # Informes consolidados de la corrida de 12h
```
