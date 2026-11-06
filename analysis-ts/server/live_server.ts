/**
 * Live analyzer with a React UI: Express serves data via server-sent events (/api/stream)
 * and the built page from web/dist. Same processing as src/live.ts (live_core.ts).
 *
 *     npm run ui -- --demo
 *     npm run ui -- --serial 192.168.178.35:41773
 *     npm run ui -- --replay ../sessions/<session> --speed 4
 *     npm run ui:dev -- --demo        # with Vite hot reload for the UI
 *     --sessions <dir>                # where saved sessions live for the "ECG test" tab (default ../sessions)
 */
import express from "express";
import { existsSync, readdirSync, statSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { analyzeEcg, hrvHistory, writeHrvHistory } from "../src/ecg_probe.ts";
import { fileURLToPath } from "node:url";
import { argValue } from "../src/lib/io.ts";
import { startSyncServer } from "../src/lib/sync_server.ts";
import { State, demoFeeder, openBrowser, openRecorder, replayFeeder, setupAdb, startProcessing, tcpServer } from "../src/live_core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");

export type Mode = "live" | "demo" | "replay";
export interface Meta { mode: Mode; source: string; tcpPort: number; recording: boolean }

async function main() {
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(n);
  const port = Number(argValue(args, "--port") ?? 9000);
  const http = Number(argValue(args, "--http") ?? 8765);
  const chArg = argValue(args, "--channel");
  const replay = argValue(args, "--replay");
  const serial = argValue(args, "--serial");
  const mode: Mode = has("--demo") ? "demo" : replay ? "replay" : "live";

  const rec: WriteStream | null = mode === "live" ? openRecorder() : null;
  const state = new State(chArg !== undefined ? Number(chArg) : null, rec);
  if (mode === "demo") demoFeeder(state);
  else if (mode === "replay") replayFeeder(state, replay!, Number(argValue(args, "--speed") ?? 1));
  else { setupAdb(serial, port); tcpServer(state, port); }
  startProcessing(state);

  const meta: Meta = {
    mode,
    source: mode === "demo" ? "Synthetic watch" : mode === "replay" ? `Replay ${replay}` : serial ? `Watch ${serial}` : "Watch (ADB or Wi-Fi)",
    tcpPort: port,
    recording: rec !== null,
  };
  const payload = () => JSON.stringify({ ...state.snapshot(), meta });

  const app = express();
  app.get("/api/snapshot", (_req, res) => { res.type("json").set("Cache-Control", "no-store").send(payload()); });
  // ECG tests saved on disk (exported from the watch): list + full report per session
  const sessionsDir = resolve(argValue(args, "--sessions") ?? join(HERE, "..", "..", "sessions"));
  // the watch finds this PC over Wi-Fi (live view without ADB) and uploads finished sessions here
  if (mode === "live") startSyncServer({ sessionsDir, livePort: port });
  const isEcgSession = (d: string) => ["raw_ecg.csv", "raw_ecg_lead.csv"].some((f) => existsSync(join(d, f)));
  app.get("/api/ecg/sessions", (_req, res) => {
    let names: string[] = [];
    try {
      names = readdirSync(sessionsDir).filter((n) => {
        const d = join(sessionsDir, n);
        return statSync(d).isDirectory() && isEcgSession(d);
      }).sort().reverse();
    } catch { /* folder missing */ }
    res.json({ dir: sessionsDir, sessions: names });
  });
  // HRV of every ECG test (morning measurements), oldest first; also written to <sessions>/hrv_ecg.csv
  app.get("/api/ecg/hrv", (_req, res) => {
    try { writeHrvHistory(sessionsDir); res.json({ rows: hrvHistory(sessionsDir) }); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.get("/api/ecg/sessions/:name", (req, res) => {
    const name = req.params.name;
    const dir = join(sessionsDir, name);
    if (!/^[\w.-]+$/.test(name) || !existsSync(dir) || !isEcgSession(dir)) { res.status(404).json({ error: "not an ECG-test session" }); return; }
    try { res.json(analyzeEcg(dir)); } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // oximeter reading typed into the SpO2 card (calibration test): {value: 70…100}
  app.post("/api/oximeter", express.json(), (req, res) => {
    const v = Number(req.body?.value);
    if (!Number.isFinite(v) || v < 50 || v > 100) { res.status(400).json({ error: "value 50–100 expected" }); return; }
    const t = Date.now() - (state.clockOffsetMs ?? 0);   // watch time, like the PPG samples
    state.addOximeter(v, t);
    res.json({ ok: true, t, value: v });
  });

  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("retry: 1000\n\n");
    const send = () => res.write(`data: ${payload()}\n\n`);
    send();
    const timer = setInterval(send, 250);
    req.on("close", () => clearInterval(timer));
  });

  if (has("--dev")) {
    const { createServer } = await import("vite");
    const vite = await createServer({ configFile: join(WEB, "vite.config.ts"), server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const dist = join(WEB, "dist");
    if (!existsSync(join(dist, "index.html"))) {
      console.error("UI not built: npm run ui:build (or npm run ui, which builds first).");
      process.exit(1);
    }
    app.use(express.static(dist, { index: "index.html" }));
  }

  app.listen(http, "127.0.0.1", () => {
    const url = `http://localhost:${http}`;
    console.log(`Live analyzer: ${url}  (Ctrl+C to stop)`);
    if (!has("--no-browser")) setTimeout(() => openBrowser(url), 1000);
  });
  process.on("SIGINT", () => { console.log("\nstopped"); rec?.end(); process.exit(0); });
}

main();
