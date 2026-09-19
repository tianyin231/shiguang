import { startWorker } from "./queue";
const worker = startWorker();
console.log("持久化 worker 已启动");
async function stop() {
  await worker.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
