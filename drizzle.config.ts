import { defineConfig } from "drizzle-kit";

const localDatabaseUrl = "postgres://agentbay:agentbay@127.0.0.1:54329/bruno";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? localDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
