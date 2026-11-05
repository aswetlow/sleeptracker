/**
 * Live-Dashboard: Uhr -> ADB-Tunnel -> Laptop -> Browser (TypeScript-Fassung von analysis/live.py).
 *
 *     npx tsx src/live.ts --serial 192.168.178.35:41773
 *     npx tsx src/live.ts --demo
 *     npx tsx src/live.ts --replay ../sessions/<session> [--speed 4]
 *
 * Gleiches Protokoll wie live.py (Uhr verbindet sich auf 127.0.0.1:9000), gleiche Seite auf
 * http://localhost:8765. Alles Empfangene wird nach sessions/live/live_<Zeit>.txt mitgeschrieben.
 * Moderneres Dashboard (React): npm run ui -- --demo (siehe server/live_server.ts).
 */
import { readFileSync, type WriteStream } from "node:fs";
import { createServer as createHttp } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "./lib/io.ts";
import { State, demoFeeder, openBrowser, openRecorder, replayFeeder, setupAdb, startProcessing, tcpServer } from "./live_core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(n);
  const port = Number(argValue(args, "--port") ?? 9000);
  const http = Number(argValue(args, "--http") ?? 8765);
  const chArg = argValue(args, "--channel");
  const replay = argValue(args, "--replay");
  const rec: WriteStream | null = !has("--demo") && !replay ? openRecorder() : null;
  const state = new State(chArg !== undefined ? Number(chArg) : null, rec);
  if (has("--demo")) demoFeeder(state);
  else if (replay) replayFeeder(state, replay, Number(argValue(args, "--speed") ?? 1));
  else { setupAdb(argValue(args, "--serial"), port); tcpServer(state, port); }
  startProcessing(state);

  const page = readFileSync(join(HERE, "live_page.html"), "utf8").replace("<h1>SleepLogger live</h1>", "<h1>SleepLogger live · TS</h1>");
  const srv = createHttp((req, res) => {
    if (req.url?.startsWith("/data")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(state.snapshot()));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page);
    }
  });
  srv.listen(http, "127.0.0.1", () => {
    const url = `http://localhost:${http}`;
    console.log(`Dashboard: ${url}  (Strg+C beendet)`);
    if (!has("--no-browser")) setTimeout(() => openBrowser(url), 1000);
  });
  process.on("SIGINT", () => { console.log("\nbeendet"); rec?.end(); process.exit(0); });
}

main();
