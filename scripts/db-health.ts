import { checkDatabaseHealth } from "@/src/server/db/health";

const health = await checkDatabaseHealth();
const payload = {
  status: health.ok ? "ok" : "error",
  database: health.database,
  timestamp: new Date().toISOString(),
  ...(health.message ? { message: health.message } : {}),
};

console.log(JSON.stringify(payload, null, 2));

process.exitCode = health.ok ? 0 : 1;
