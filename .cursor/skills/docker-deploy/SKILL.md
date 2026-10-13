---
name: docker-deploy
description: >-
  Deploy and run jobby only via Docker. Use when starting the app, rebuilding
  after UI changes, promoting to stage/production, or preparing Kubernetes.
  Stages: dev, stage, production. Never start host next dev.
---

# Docker deploy (jobby)

Load `.cursor/rules/47-docker-first.mdc` first. Product runtime is Compose (and
later Kubernetes), never host `next dev`.

Issue: [JOBBY-BL-079](https://github.com/ahmedyusef9/jobby/issues/84).

## Images (one build path)

| Image | Dockerfile | Role |
|---|---|---|
| web | `deploy/Dockerfile.web` | Next standalone; `CMD` from `/app/web` (`server.js` nested under `web/` because of the repo-root lockfile) |
| worker | `deploy/Dockerfile.worker` | Score/scan/PDF jobs |
| redis | `redis:7-alpine` | Queue only; never published to the host |

Build context is **repository root**. Rebuild after any change under `web/` or
`scripts/` that the image copies. User-layer files on `CAREER_OPS_ROOT=/data`
update without a rebuild.

## Stages

Same services and env **names** at every stage. Difference is host, secrets,
and bind vs volume.

| Stage | How | URL / bind | Data |
|---|---|---|---|
| **dev** | `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build` | `http://127.0.0.1:<.ports.yml compose-web>` (loopback). `JOBBY_WEB_PORT` must match. Optional tailnet bind via `JOBBY_BIND_ADDR` | Host checkout `..:/data` |
| **stage** | `docker compose -f deploy/docker-compose.qa.yml` (or the same compose file on a stage host with `deploy/.env` for that host) | Stage hostname; `AUTH_URL` / `JOBBY_APP_PUBLIC_URL` must match it | Named volume or stage checkout mount; never copy `deploy/.env` from a laptop into git |
| **production** | Same Dockerfiles. Compose is acceptable until k8s exists. When k8s lands: Deployment/Service per web+worker+redis, same `AUTH_*` / `REDIS_URL` / `CAREER_OPS_ROOT` / `JOBBY_HOST_ROOT` contract | Public `AUTH_URL`; loopback-only Redis | Persistent volume for tenant data; secrets from the platform secret store, not a committed file |

Do **not** invent a second Next server for stage. Promote by rebuilding these
images and pointing env at the stage/prod host.

### Kubernetes later (not in this issue)

When you add k8s: one Deployment for `jobby-deploy-web`, one for the worker,
one StatefulSet or managed Redis; env from Secrets/ConfigMap matching
`deploy/.env.example`; containerPort **3000**; Service/NodePort/hostPort =
`.ports.yml` `compose-web` (never another project's 3000/3001). No new app
architecture — only orchestration. Do not write manifests until a dedicated
issue exists.

## Dev loop

1. Change code on the host checkout.
2. `docker compose -f deploy/docker-compose.yml up -d --build web` (or `worker` if the worker image changed).
3. Verify `http://127.0.0.1:<compose-web>` from `.ports.yml` (status + visible UI). Sign-in: operator control when `AUTH_SINGLE_TENANT=0`.
4. Do not run `scripts/web-ui.sh` except `--stop`. Emergency host Next: `JOBBY_ALLOW_HOST_NEXT=1` only.

Stop stack: `docker compose -f deploy/docker-compose.yml down`.

## Env contract (all stages)

Required for web to boot and sign in:

- `AUTH_SECRET`
- `AUTH_URL` (the URL in the browser, not an internal container name; local compose = `http://127.0.0.1:<compose-web>`)
- `JOBBY_WEB_PORT` (host publish; must equal `.ports.yml` `compose-web`)
- `JOBBY_OPERATOR_SECRET` for the operator door
- `AUTH_SINGLE_TENANT` (`0` = email/OAuth front door; operator is collapsed)
- `JOBBY_HOST_ROOT` on the worker (absolute **host** path of this checkout)
- `REDIS_URL=redis://redis:6379` inside the compose network

Never bake secrets into the image.

## Checks before claiming a stage is up

1. `docker compose … ps` — web/worker/redis `Up`, web not `Restarting`.
2. `curl -s -o /dev/null -w '%{http_code}' http://<host>/signin` → `200`.
3. Image contains the change (`docker exec … ls` the route or grep the built page) if the claim is a UI feature.
4. Record the evidence (status code + container `Created` time).
5. If clients use the `*.ts.net` MCP URL: Funnel/Serve backend is
   `http://127.0.0.1:<compose-web>` — `.cursor/skills/tailscale-serve/SKILL.md`.
   `curl` the Funnel `/signin` (200). A 502 means the mapping still points at a
   dead host port (historically `3001`).
