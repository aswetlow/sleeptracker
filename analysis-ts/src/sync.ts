/**
 * Receive sessions from the watch over Wi-Fi (no ADB): leave this running, press "Sync to PC" on the watch
 * (or Stop a recording – the watch syncs on its own when it finds the PC).
 *     npm run sync                    # into ../sessions
 *     npm run sync -- --out D:\sessions
 * npm run ui does the same in the background.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue } from "./lib/io.ts";
import { startSyncServer, SYNC_PORT } from "./lib/sync_server.ts";

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(argValue(args, "--out") ?? join(here, "..", "..", "sessions"));
startSyncServer({ sessionsDir: out, livePort: Number(argValue(args, "--port") ?? 9000), syncPort: Number(argValue(args, "--sync-port") ?? SYNC_PORT) });
console.log(`Waiting for the watch (Wi-Fi). Sessions go to ${out}. On the watch: "Sync to PC". Ctrl+C to stop.`);
console.log("If Windows asks: allow Node.js on private networks.");
