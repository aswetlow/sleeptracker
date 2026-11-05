/**
 * Live-Analyzer mit React-Oberfläche: Express liefert Daten per Server-Sent Events (/api/stream)
 * und die gebaute Seite aus web/dist. Gleiche Verarbeitung wie src/live.ts (live_core.ts).
 *
 *     npm run ui -- --demo
 *     npm run ui -- --serial 192.168.178.35:41773
 *     npm run ui -- --replay ../sessions/<session> --speed 4
 *     npm run ui:dev -- --demo        # mit Vite-Hot-Reload für die Oberfläche
 */
import express from "express";
import { existsSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "../src/lib/io.ts";
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
    source: mode === "demo" ? "Synthetische Uhr" : mode === "replay" ? `Replay ${replay}` : serial ? `Uhr ${serial}` : "Uhr (USB/ADB)",
    tcpPort: port,
    recording: rec !== null,
  };
  const payload = () => JSON.stringify({ ...state.snapshot(), meta });

  const app = express();
  app.get("/api/snapshot", (_req, res) => { res.type("json").set("Cache-Control", "no-store").send(payload()); });
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
      console.error("Oberfläche nicht gebaut: npm run ui:build (oder npm run ui, das baut vorher).");
      process.exit(1);
    }
    app.use(express.static(dist, { index: "index.html" }));
  }

  app.listen(http, "127.0.0.1", () => {
    const url = `http://localhost:${http}`;
    console.log(`Live-Analyzer: ${url}  (Strg+C beendet)`);
    if (!has("--no-browser")) setTimeout(() => openBrowser(url), 1000);
  });
  process.on("SIGINT", () => { console.log("\nbeendet"); rec?.end(); process.exit(0); });
}

main();
