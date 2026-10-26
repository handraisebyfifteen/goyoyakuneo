import express from "express";
import { createServer } from "node:http";
import { setupSession } from "./auth";
import { registerRoutes } from "./routes";
import { assertStripeTestKeys, handleWebhook } from "./payments";
import { startReminders } from "./reminders";
import { startCardHoldSweeper } from "./cardpay";

assertStripeTestKeys(); // 本番用の Stripe キーが入っていたら起動しない

const app = express();

// Stripe の Webhook は署名の検査に生の本文が要るので、JSON の読み込みより前に受ける
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const r = await handleWebhook(req.body as Buffer, req.header("stripe-signature"));
    res.json(r);
  } catch (e) {
    console.error("[stripe_webhook]", e instanceof Error ? e.message : e);
    res.status(400).json({ ok: false, code: "webhook_rejected" });
  }
});

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false }));
setupSession(app);

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  const started = Date.now();
  res.on("finish", () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`));
  next();
});

registerRoutes(app);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  if (!res.headersSent) res.status(500).json({ ok: false, code: "server_error" });
});

const server = createServer(app);
const port = Number(process.env.PORT) || 5000;

(async () => {
  if (process.env.NODE_ENV === "production") {
    const { serveStatic } = await import("./vite");
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  }
  server.listen(port, "0.0.0.0", () => console.log(`goyoyaku-neo listening on ${port}`));
  startReminders();
  startCardHoldSweeper();
})();
