# Signet Docker Deployment

This directory contains the first-party Docker setup for self-hosted Signet.

## Quick start

```bash
cd deploy/docker
cp .env.example .env

docker compose up -d --build
```

Open `http://localhost/health` and `http://localhost/`.

## Auth bootstrap (team mode default)

The entrypoint writes `auth.mode: team` to `agent.yaml` on first run.
To mint an initial admin token, run:

```bash
docker compose exec signet bun /app/deploy/docker/scripts/create-token.mjs --role admin --sub bootstrap
```

Store the returned token securely and use it as `Authorization: Bearer <token>`.

## Persistent data

All state is stored in the `signet_data` volume at `/data/agents` inside
container:

- `agent.yaml`
- `MEMORY.md`
- `memory/memories.db`
- `.daemon/auth-secret`

## Upgrade flow

```bash
# optional backup
# docker run --rm -v signet_signet_data:/data -v "$PWD":/backup alpine tar czf /backup/signet-backup.tgz /data

# pull new image and restart
docker compose pull
docker compose up -d
```
