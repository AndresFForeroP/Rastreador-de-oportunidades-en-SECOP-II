# Rastreador de oportunidades en SECOP II

Skeleton agent for the **Reto Agente 2026** challenge. The final agent will track public
procurement opportunities in Colombia's SECOP II (datos.gov.co, Socrata API), filter them
against a company profile and summarize them. For now this is only a working skeleton based
on the [LangChain JS quickstart](https://docs.langchain.com/oss/javascript/langchain/quickstart).

- Reasoning model: **Grok**, through the challenge's OpenAI-compatible gateway
  (`https://api.reto.pltk.mx/v1`).
- Stack: TypeScript (ESM), pnpm, LangChain JS (`createAgent`), Docker.

## Setup

Requires Node.js 22+ and corepack (bundled with Node 22/24).

```powershell
corepack enable
pnpm install
Copy-Item .env.example .env   # then add your RETO_KEY to .env (never commit it)
```

Set the Grok model name in [`src/llm.ts`](src/llm.ts) (`MODEL_NAME`) and the prices in
[`src/cost.ts`](src/cost.ts) (`PRECIOS`).

## Run locally

```powershell
pnpm exec tsx src/test-grok.ts   # gateway check: plain response, tool call, structured output
pnpm exec tsx src/index.ts       # basic agent (get_weather tool)
```

Every model call appends a line to `logs/costos.jsonl`
(date, task, model, input/output tokens, cost in USD).

## Run with Docker

The image contains no secrets: `.env` is excluded by `.dockerignore`, and `RETO_KEY` is
injected only at runtime through `env_file` in `docker-compose.yml`.

```powershell
docker compose build
docker compose run --rm agent pnpm exec tsx src/test-grok.ts   # gateway check
docker compose run --rm agent                                  # basic agent (default command)
```

- `./logs` is mounted at `/app/logs`, so `logs/costos.jsonl` stays on your machine.
- `node_modules` is installed inside the image; it is never mounted from the host.
- No ports are exposed and there is no restart policy: the script runs once and exits.
  `restart: unless-stopped` is left commented in `docker-compose.yml` for a future
  long-running mode (enabling it now would re-run the script forever and spend credits).

## Notes

- LangSmith tracing is disabled (`LANGSMITH_TRACING=false`).
- pnpm blocks dependency build scripts by default; `pnpm-workspace.yaml` allows only
  `esbuild` (required by `tsx`) through `allowBuilds`.
