import { startWorker } from "./queue";
const worker = startWorker();
console.log(
  "独立 worker 已启动；个人 API Key 仅在 API 进程内存中，不能跨进程共享。BYOK 生图请使用 npm start/dev 默认内置 worker；独立 worker 只会处理无需 Key 的连接。",
);
async function stop() {
  await worker.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
