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
2. **Código (pre-filtro básico)**: Descarta por reglas deterministas (modalidad no competitiva, estado cerrado, tipos excluidos como seguros/concesiones, valor > $5.000M COP, duplicados).
3. **Agente 1 "filtrador" (`agente_filtrador`)**: Evalúa candidatos pre-filtrados en páginas de 25 mediante la tool `filtro_basico` y clasifica `aptoPyme: "si" | "no" | "dudoso"`. Genera `data/entregas/<fecha>/aptos.json`.
4. **Agente 2 "resumidor" (Etapa 3 - Pendiente)**: Recibe los procesos `aptoPyme: "si"`, consulta los pliegos mediante la tool `leer_pliego` y genera un resumen ejecutivo claro para una pyme.
5. **Agente 3 "documentos" (Etapa 4 - Pendiente)**: Identifica requisitos habilitantes y arma la lista de documentos exigidos mediante la tool `armar_lista_documentos`.
6. **Código (reporte final - Etapa 5 - Pendiente)**: Consolida la entrega diaria lista para consumo.

---

## 2. Reglas Globales Inmutables

1. **Seguridad y Secretos**: NUNCA leer, imprimir, modificar ni commitear `.env`. Los secretos jamás se hardcodean.
2. **Docs-First**: No confiar en memoria para APIs de LangChain / LangGraph / LangSmith. Revisar la documentación oficial (https://docs.langchain.com/oss/javascript/) y los archivos de tipos instalados (`.d.ts`).
3. **TypeScript Estricto & ESM**: Imports relativos con sufijo obligatorio `.js`. Comentarios explicativos en español. Cero errores en `pnpm typecheck`.
4. **Trazabilidad 100%**: Toda llamada a modelo o pipeline debe quedar registrada en LangSmith (proyecto `secop-rastreador`) y registrar tokens en `logs/tokens.jsonl` a través de `src/cost.ts`.
5. **GUARDA DE CRÉDITOS (Estricta)**: Los créditos de Grok son limitados.
   - Cualquier comando que invoque LLM **debe operar por defecto en un lote pequeño** (máx. 1 página / 25 procesos).
   - Solo procesa el día completo si se especifica explícitamente la bandera `--completo`.
   - Prohibido realizar bucles sin tope duro.
6. **Regla de Fecha (Solo HOY)**:
   - Producción procesa **ÚNICAMENTE** procesos con `fecha_de_publicacion_del` del día de hoy en hora Colombia (UTC-5).
   - `descargarHoy()` no recibe parámetro de fecha. Si hoy hay 0 procesos, devuelve lista vacía y mensaje claro; **NUNCA recurre a otra fecha**.
   - **Única excepción de desarrollo**: La variable de entorno `SECOP_FECHA_PRUEBA=YYYY-MM-DD` (apagada por defecto). Si está activa, emite una advertencia ruidosa en consola, marca `modo: "prueba"` en las trazas y utiliza la caché local en `data/dias/<fecha>.json`.

---

## 3. Estado de Avance por Etapas

| Etapa | Estado | Componentes Implementados |
|---|:---:|---|
| **Etapa 1** | **COMPLETA** | Capa de datos Socrata, pre-filtro determinista, setup de trazas LangSmith, script `probar-datos.ts`. |
| **Etapa 2** | **COMPLETA** | Tool `filtro_basico`, Agente 1 `agente_filtrador` (`ResultadoPagina`), runner `filtrar-pymes.ts`, CLI `correr-filtrador.ts`, entrega `aptos.json`. |
| **Etapa 3** | *Pendiente* | Agente 2 "resumidor", herramienta `leer_pliego`. |
| **Etapa 4** | *Pendiente* | Agente 3 "documentos", herramienta `armar_lista_documentos`. |
| **Etapa 5** | *Pendiente* | Pipeline integral orquestado y generación de reporte final. |

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
  url: string | null;          // Enlace al proceso en SECOP
}
```

### B. Salida de `filtro_basico` (Para el Agente 1)
Devuelve un string JSON:
```json
{
  "pagina": 1,
  "totalPaginas": 17,
  "totalCandidatos": 423,
  "estadisticasPrefiltro": { ... },
  "candidatos": [
    {
      "id": "CO1.REQ.11205497",
      "nombre": "...",
      "descripcion": "... (máx 600 caracteres)",
      "entidad": "...",
      "departamento": "...",
      "tipoDeContrato": "...",
      "modalidad": "...",
      "valor": 1309000,
      "fase": "..."
    }
  ]
}
```

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
Base para el Agente 2 de la Etapa 3:
```json
{
  "fecha": "YYYY-MM-DD",
  "modo": "produccion | prueba",
  "totalCandidatos": 423,
  "paginasProcesadas": 1,
  "totalPaginasDisponibles": 17,
  "estadisticasClasificacion": { "si": 20, "no": 5, "dudoso": 0, "total": 25 },
  "tokens": { "entrada": 7564, "salida": 2598, "total": 15280 },
  "resultados": [
    {
      "id": "CO1.REQ.11205497",
      "aptoPyme": "si",
      "categoriaObjeto": "evaluación psicosocial",
      "razon": "Mínima cuantía de bajo valor que una pyme puede prestar.",
      "senales": ["mínima cuantía", "valor 1.3 millones"],
      "proceso": { ...datos completos del candidato... }
    }
  ]
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

# 4. Abrir dashboard de LangSmith
Start-Process "https://smith.langchain.com"
```
