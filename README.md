# AgentBay

AgentBay is a Bun-managed Next.js App Router scaffold for the Milestone 0 product skeleton.

## Development

Install dependencies:

```bash
bun install
```

Run the development server:

```bash
bun run dev
```

Run the current quality gate:

```bash
bun run verify
```

## Local Database

Start the local Postgres service:

```bash
docker compose up -d postgres
```

Apply infrastructure migrations:

```bash
bun run db:migrate
```

Check database-backed health from the command line:

```bash
bun run db:health
```

The local default database URL is:

```text
postgres://agentbay:agentbay@127.0.0.1:54329/agentbay
```

Set `DATABASE_URL` and `NEXT_PUBLIC_APP_URL` in local or deployment environments. The
application validates both at runtime and returns a non-2xx `/health` response when the database
configuration is missing, malformed, or unreachable.

## Vercel Preview Deployment

The initial empty-app preview was deployed from the authenticated local Vercel CLI account `ametel01` to scope `ametel01s-projects` and project `agentbay`.

Preview URL:

```text
https://agentbay-9wi2xvhbh-ametel01s-projects.vercel.app
```

To repeat a preview deployment from the CLI:

```bash
vercel whoami
vercel deploy -y --no-wait --target preview --scope ametel01s-projects
```

If this checkout is not linked locally, link it first:

```bash
vercel link --project agentbay --scope ametel01s-projects -y
```

The Vercel CLI creates local `.vercel/` metadata and may create `.env.local` for local credentials. Keep both out of commits.
