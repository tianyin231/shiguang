import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings } from "../shared/types";

export const dataDir = path.resolve(process.env.DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, "workbench.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,token TEXT UNIQUE NOT NULL,active_provider_id TEXT,settings TEXT NOT NULL,last_seen INTEGER);
CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),provider_id TEXT NOT NULL REFERENCES providers(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),project_id TEXT NOT NULL REFERENCES projects(id),sha TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),project_id TEXT NOT NULL REFERENCES projects(id),created_at INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),provider_id TEXT NOT NULL REFERENCES providers(id),model_id TEXT NOT NULL REFERENCES models(id),project_id TEXT NOT NULL REFERENCES projects(id),batch_id TEXT NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,available_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,owner TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,available_at,priority DESC,created_at);
CREATE INDEX IF NOT EXISTS tasks_provider ON tasks(provider_id,status);
CREATE INDEX IF NOT EXISTS images_sha ON images(device_id,sha);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_device ON events(device_id,id);
CREATE TABLE IF NOT EXISTS requests(device_id TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(device_id,key));
CREATE TABLE IF NOT EXISTS charges(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,model_id TEXT NOT NULL,kind TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proxy_leases(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,expires INTEGER NOT NULL);
`);
type Table =
  | "providers"
  | "models"
  | "projects"
  | "sessions"
  | "memories"
  | "images"
  | "versions";
export const uid = () => randomUUID();
export const now = () => Date.now();
export function all<T>(table: Table, deviceId: string): T[] {
  return (
    db.prepare(`SELECT data FROM ${table} WHERE device_id=?`).all(deviceId) as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data));
}
export function get<T>(
  table: Table,
  id: string,
  deviceId?: string,
): T | undefined {
  const row = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=?${deviceId ? " AND device_id=?" : ""}`,
    )
    .get(...(deviceId ? [id, deviceId] : [id])) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
export function put(
  table: Table,
  deviceId: string,
  value: { id: string },
  extra: Record<string, string | number> = {},
) {
  const keys = ["id", "device_id", ...Object.keys(extra), "data"];
  const vals = [
    value.id,
    deviceId,
    ...Object.values(extra),
    JSON.stringify(value),
  ];
  db.prepare(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
  ).run(...vals);
}
export function remove(table: Table, id: string, deviceId: string) {
  db.prepare(`DELETE FROM ${table} WHERE id=? AND device_id=?`).run(
    id,
    deviceId,
  );
}
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db.exec("COMMIT");
    return v;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function event(deviceId: string, type: string, data: unknown) {
  db.prepare(
    "INSERT INTO events(device_id,type,data,created_at) VALUES(?,?,?,?)",
  ).run(deviceId, type, JSON.stringify(data), now());
}
export const defaultSettings = (): Settings => ({
  outputDir: path.resolve(process.env.OUTPUT_DIR || "./outputs"),
  filenameTemplate: "{date}/{model}/{prompt_hash}/{seed}-{id}.png",
  quotaMB: 10240,
  totalBudgets: {},
  concurrency: 2,
  retries: 1,
  timeout: 600,
});
export interface Device {
  id: string;
  token: string;
  active_provider_id: string | null;
  settings: string;
  last_seen: number;
}
export function deviceByToken(token: string) {
  return db
    .prepare("SELECT * FROM devices WHERE token=?")
    .get(token) as unknown as Device | undefined;
}
export function settings(deviceId: string): Settings {
  const row = db
    .prepare("SELECT settings FROM devices WHERE id=?")
    .get(deviceId) as { settings: string };
  return JSON.parse(row.settings);
}
export function createDevice(): Device {
  const d: Device = {
    id: uid(),
    token: uid() + uid(),
    active_provider_id: null,
    settings: JSON.stringify(defaultSettings()),
    last_seen: now(),
  };
  db.prepare("INSERT INTO devices VALUES(?,?,?,?,?)").run(
    d.id,
    d.token,
    d.active_provider_id,
    d.settings,
    d.last_seen,
  );
  return d;
}
