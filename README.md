# Rastreador de oportunidades en SECOP II

Esqueleto funcional de un agente para el desafío **Reto Agente 2026**. El agente final rastreará oportunidades de contratación pública en el SECOP II de Colombia (datos abiertos de datos.gov.co mediante la API Socrata), las filtrará según el perfil de una empresa y generará resúmenes. Por ahora, este repositorio contiene la base funcional inicial adaptada a partir de la [guía de inicio rápido de LangChain JS](https://docs.langchain.com/oss/javascript/langchain/quickstart).

- Modelo de razonamiento: **Grok**, accesible a través del gateway compatible con OpenAI del reto (`https://api.reto.pltk.mx/v1`).
- Stack tecnológico: TypeScript (ESM), pnpm, LangChain JS (`createAgent`), Docker.

## Configuración inicial

Requiere Node.js 22+ y corepack (incluido en Node 22/24).

```powershell
corepack enable
pnpm install
Copy-Item .env.example .env   # luego agrega tu RETO_KEY en .env (nunca lo subas al repositorio)
```

Define el nombre exacto del modelo Grok en [`src/llm.ts`](src/llm.ts) (`MODEL_NAME`) y los precios por millón de tokens en [`src/cost.ts`](src/cost.ts) (`PRECIOS`).

## Ejecución local

```powershell
pnpm exec tsx src/test-grok.ts   # prueba del gateway: respuesta simple, llamada a herramienta y salida estructurada
pnpm exec tsx src/index.ts       # agente básico (herramienta get_weather)
```

Cada invocación al modelo registra una línea en `logs/costos.jsonl` con: fecha, tarea, modelo, tokens de entrada/salida y costo estimado en USD.

## Ejecución con Docker

La imagen Docker no contiene secretos: el archivo `.env` está excluido mediante `.dockerignore`, y la variable `RETO_KEY` se inyecta en tiempo de ejecución a través de `env_file` en `docker-compose.yml`.

```powershell
docker compose build
docker compose run --rm agent pnpm exec tsx src/test-grok.ts   # prueba del gateway dentro del contenedor
docker compose run --rm agent                                  # agente básico (comando por defecto)
```

- La carpeta `./logs` se monta en `/app/logs`, por lo que el archivo `logs/costos.jsonl` se almacena directamente en tu máquina local.
- `node_modules` se instala internamente en la imagen; nunca se monta desde Windows.
- No se exponen puertos y no se establece una política de reinicio automático: el script se ejecuta una sola vez y finaliza. La línea `restart: unless-stopped` se encuentra comentada en `docker-compose.yml` para ejecuciones continuas futuras (activarla ahora reintentaría la ejecución indefinidamente, consumiendo créditos).

## Notas adicionales

- El rastreo con LangSmith está desactivado (`LANGSMITH_TRACING=false`).
- Por defecto, pnpm bloquea la ejecución de scripts de construcción en dependencias; el archivo `pnpm-workspace.yaml` aprueba de forma explícita únicamente a `esbuild` (requerido por `tsx`) mediante `allowBuilds`.
