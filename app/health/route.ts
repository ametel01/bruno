import { checkDatabaseHealth } from "@/src/server/db/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkDatabaseHealth();
  const payload = {
    status: health.ok ? "ok" : "error",
    database: health.database,
    timestamp: new Date().toISOString(),
    ...(health.message ? { message: health.message } : {}),
  };

  return Response.json(payload, {
    status: health.ok ? 200 : 503,
  });
}
