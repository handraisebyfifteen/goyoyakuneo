import type { Express } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

export async function setupVite(app: Express, server: Server) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: path.resolve(import.meta.dirname, "..", "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    try {
      const template = await fs.promises.readFile(path.resolve(import.meta.dirname, "..", "client", "index.html"), "utf-8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const dist = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(dist)) throw new Error(`Build directory not found: ${dist}. Run "npm run build" first.`);
  app.use(express.static(dist));
  app.use("*", (_req, res) => res.sendFile(path.resolve(dist, "index.html")));
}
