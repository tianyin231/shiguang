import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "./app";
import { startWorker } from "./queue";
const app = createApp();
const server = createServer(app);
const production =
  process.argv.includes("--production") ||
  process.env.NODE_ENV === "production";
if (production) {
  app.use(express.static(path.resolve("dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const worker =
  process.env.WORKER_ENABLED === "false" ? undefined : startWorker();
const port = Number(process.env.PORT || 4327);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () =>
  console.log(`拾光工作台 http://${host}:${port}`),
);
server.on("error", async (error) => {
  console.error("启动失败：" + error.message);
  await worker?.stop();
  process.exit(1);
});
async function stop() {
  server.close();
  await worker?.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
