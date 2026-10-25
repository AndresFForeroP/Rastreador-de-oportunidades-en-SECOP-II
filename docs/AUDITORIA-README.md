# Auditoría de Afirmaciones Factuales en README.md y Documentación (S3-6)

> **PROPÓSITO DE LA AUDITORÍA**:
> Revisar de forma exhaustiva cada cifra, métrica y afirmación fáctica contenida en el `README.md` y la documentación del proyecto, verificando si cuenta con respaldo comprobable en los archivos de evidencia bajo `data/pruebas-reto/` o si carece de respaldo empírico en nuestras mediciones.

---

## 1. Tabla de Auditoría de Afirmaciones Factuales

| # | Afirmación en el texto original | Ubicación original | Estado de Respaldo | Archivo de Evidencia en `data/pruebas-reto/` o Justificación | Acción / Cambio Aplicado en `README.md` |
|---|---|---|:---:|---|---|
| **1** | *"Cada jornada hábil en Colombia, entidades de orden nacional y territorial publican entre 300 y 600 procesos de contratación en SECOP II"* | `README.md` (Sección 1: El Problema) | **Parcialmente respaldado** | En la corrida sobre fecha de prueba (`2026-10-15`) se registraron **423 procesos competitivos** descargados (`data/pruebas-reto/ejecuciones/20261020-223545_89fd/reporte.json`). El rango "300 a 600" no fue medido formalmente a lo largo de un año. | **Suavizado**: Se aclara que en jornadas evaluadas (ej. 15 de octubre de 2026) se capturaron 423 procesos competitivos, eliminando la afirmación categórica no muestreada del rango 300-600. |
| **2** | *"Muchas pymes pierden oportunidades viables por desconocimiento de los plazos o quedan descalificadas por omitir documentos habilitantes básicos"* | `README.md` (Sección 1: El Problema) | **Sin respaldo empírico** | No existe en `data/pruebas-reto/` un estudio de campo ni tasa cuantitativa medida de descalificación de pymes colombianas. | **Aclarado**: Se formula explícitamente como una premisa de contexto e hipótesis de diseño del proyecto, no como un dato cuantitativo medido por el sistema. |
| **3** | *"Los portales web transaccionales de contratación pública presentan barreras técnicas de automatización y lectura masiva (como sistemas de protección anti-bot y ReCaptcha)"* | `README.md` (Sección 1 y Sección 9) | **Con respaldo técnico** | Verificado técnicamente en la arquitectura y documentado en `docs/CONTEXTO.md` (Regla 7). Las peticiones directas a `community.secop.gov.co` retornan desafíos ReCaptcha. | **Mantenido y precisado**: Se mantiene con referencia explícita a la imposibilidad técnica de lectura directa de pliegos y a la decisión de limitarse a datos abiertos de Socrata. |
| **4** | *"Pre-filtro determinista por código: Descarta sin costo de LLM procesos no competitivos... cuantías > $5.000M COP"* | `README.md` (Sección 2: Qué Hace el Sistema) | **Con respaldo** | Verificado en `src/filtro/prefiltro.ts` y auditado en Bloque B (`data/pruebas-reto/evaluacion/claves-privadas.json`), donde 15 casos descartados por código no requirieron tokens. | **Mantenido**: Respaldado por el código y la auditoría de descarte del Bloque B. |
| **5** | *"reduciendo en más del 70% el gasto en la etapa de documentos"* | `README.md` (Sección 8: Estrategia de Costos) | **Sin respaldo del porcentaje exacto** | El porcentaje "70%" era una estimación a priori. En la corrida de evaluación de 10 casos (`data/pruebas-reto/evaluacion/resultados/20261025-015244-agentes/resumen.md`), los procesos sin anexos consumieron $0 USD (0 tokens), mientras que forzar el LLM en 3 casos consumió $0.0530 USD. | **Corregido**: Se elimina la cifra "70%" y se reemplaza con el ahorro medido: el Agente 3 reduce al 100% el consumo de tokens en cualquier proceso que no cuente con anexos indexados. |
| **6** | *"Extracto Real de Reporte Generado (2026-10-15)"* | `README.md` (Sección 10) | **Con respaldo** | Corresponde al reporte real almacenado en `data/pruebas-reto/ejecuciones/20261020-223545_89fd/reporte.md`. | **Mantenido con enlace relativo**: Se añade enlace relativo al archivo de evidencia correspondiente. |
| **7** | *Menciones a videos o enlaces audiovisuales* | Todo el documento | **Cumple (Sin mención)** | No existe ningún enlace a video ni mención de material audiovisual en `README.md`. | **Mantenido**: Conforme a la regla inmutable 9 de gobernanza, la entrega de video se gestiona exclusivamente por el canal oficial del reto. |

---

## 2. Nuevas Secciones Añadidas con Respaldo en Evidencias

A continuación se resumen las secciones añadidas al `README.md` a partir de los datos consolidados en `data/pruebas-reto/`:

1. **Sección "Evaluación Científica y Benchmarks"**:
   - Tamaño del set: 55 casos de contratación pública en Colombia ([`data/pruebas-reto/evaluacion/casos-sin-etiquetar.json`](../data/pruebas-reto/evaluacion/casos-sin-etiquetar.json)).
   - Procedimiento de etiquetado ciego por el usuario humano ([`docs/GUIA-ETIQUETADO.md`](./GUIA-ETIQUETADO.md)).
   - Métricas de línea base del Agente 1: **85.0% Accuracy**, **80.6% Precision**, **100.0% Recall**, 3 falsos positivos graves ([`data/pruebas-reto/evaluacion/resultados/linea-base/resumen.md`](../data/pruebas-reto/evaluacion/resultados/linea-base/resumen.md)).
   - Tasa de falso descarte del pre-filtro en Bloque B (11/15 casos etiquetados como viables por el humano pero descartados por reglas de cuantía/estado/fecha).
   - Aprobación de invariantes de Agentes 2 y 3 ([`data/pruebas-reto/evaluacion/resultados/20261025-015244-agentes/resumen.md`](../data/pruebas-reto/evaluacion/resultados/20261025-015244-agentes/resumen.md)):
     * Agente 2: 100% de cumplimiento en concordancia con dataset, cifras de 6+ dígitos, claves de `basadoEn`, verificación en pliego y no atribuirse lectura de pliegos.
     * Agente 3: 100% de cumplimiento en origen de ítems, aviso orientativo y respaldo legal; fallo en duplicación (10% de aprobación) por presencia de archivos con nombres idénticos en `dmgg-8hin`.
2. **Sección "Contabilidad de Costos y Facturación"**:
   - Desglose financiero en USD calibrado con el panel del reto ([`config/precios.json`](../config/precios.json)): $2.00 / 1M entrada, $6.00 / 1M salida.
   - Costo unitario por tarea:
     * Agente 1: ~$0.0013 USD por candidato evaluado.
     * Agente 2: ~$0.0142 USD por proceso estructurado.
     * Agente 3: $0.0000 USD en procesos sin anexos; ~$0.0170 USD en procesos con anexos o invocación LLM forzada.
3. **Sección "Historial de Ejecuciones y Libro Mayor"**:
   - Registro de las 7 ejecuciones registradas en [`data/pruebas-reto/ejecuciones/RESUMEN.md`](../data/pruebas-reto/ejecuciones/RESUMEN.md) con enlaces relativos a cada carpeta de corrida.
4. **Sección "Limitaciones Objetivas y Marco Operativo"**:
   - Imposibilidad de leer pliegos oficiales protegidos con ReCaptcha.
   - Procesamiento exclusivo de procesos publicados HOY (incompletitud de jornadas en curso).
   - Desfase de 24 a 48 horas en el dataset de anexos `dmgg-8hin`.
   - Carácter orientativo del catálogo general (no es asesoría jurídica).
   - Tamaño y sesgo de la muestra de evaluación (55 casos, 1 anotador).
