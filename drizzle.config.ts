import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  // ログインの状態は connect-pg-simple が sessions 表に持つ。スキーマに無いので、push で消されないよう外す
  tablesFilter: ["!sessions"],
  dbCredentials: { url: process.env.DATABASE_URL },
});
