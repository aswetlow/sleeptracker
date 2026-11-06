/**
 * Direct Wi-Fi link to the watch (no ADB), see app/…/WifiLink.kt and SessionSync.kt.
 *  - UDP 9001: answers the watch's broadcast "SLEEPLOGGER? 1" with "SLEEPLOGGER 1 <livePort> <syncPort> <name>".
 *  - HTTP <syncPort> (default 9002): the watch uploads finished sessions.
 *      GET /sessions/<name>          -> {"files": {"accel.csv": 123, …}}   (complete files only)
 *      PUT /sessions/<name>/<file>   -> body = file content, written to <file>.part and renamed when complete
 * Only clients from private networks (home Wi-Fi) are accepted.
 */
import { createSocket } from "node:dgram";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";

export const DISCOVERY_PORT = 9001, SYNC_PORT = 9002;
const SESSION = /^\d{8}_\d{6}$/, FILE = /^[\w.-]+$/;

/** loopback, RFC 1918, link-local, CGNAT (also IPv4-mapped IPv6) */
export function isPrivate(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  if (a === "::1") return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return /^fe80:/i.test(a) || /^f[cd]/i.test(a);
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

export interface SyncOptions { sessionsDir: string; livePort: number; syncPort?: number; log?: (s: string) => void }

export function startDiscovery(livePort: number, syncPort: number, log: (s: string) => void) {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  const name = hostname();
  sock.on("message", (msg, r) => {
    if (!isPrivate(r.address) || !msg.toString().startsWith("SLEEPLOGGER? 1")) return;
    sock.send(`SLEEPLOGGER 1 ${livePort} ${syncPort} ${name}`, r.port, r.address);
  });
  sock.on("error", (e) => log(`discovery UDP ${DISCOVERY_PORT}: ${e.message}`));
  sock.bind(DISCOVERY_PORT, "0.0.0.0");
  return sock;
}

function localFiles(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".part")) continue;
    const st = statSync(join(dir, f));
    if (st.isFile()) out[f] = st.size;
  }
  return out;
}

export function startSyncServer(o: SyncOptions) {
  const log = o.log ?? console.log;
  const syncPort = o.syncPort ?? SYNC_PORT;
  const got = new Map<string, number>();   // bytes received per session in this run (for the log)
  const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!isPrivate(req.socket.remoteAddress)) return send(res, 403, { error: "private networks only" });
    const parts = decodeURIComponent((req.url ?? "").split("?")[0]).split("/").filter(Boolean);
    if (parts[0] !== "sessions" || !parts[1] || !SESSION.test(parts[1])) return send(res, 404, { error: "not found" });
    const dir = join(o.sessionsDir, parts[1]);
    if (req.method === "GET" && parts.length === 2) return send(res, 200, { files: localFiles(dir) });
    if (req.method === "PUT" && parts.length === 3 && FILE.test(parts[2])) {
      const len = Number(req.headers["content-length"]);
      if (!Number.isFinite(len)) return send(res, 411, { error: "Content-Length required" });
      mkdirSync(dir, { recursive: true });
      const target = join(dir, parts[2]), part = target + ".part";
      const out = createWriteStream(part);
      let n = 0;
      req.on("data", (c: Buffer) => { n += c.length; });
      req.pipe(out);
      const fail = (why: string) => { try { rmSync(part, { force: true }); } catch { /* */ } if (!res.headersSent) send(res, 400, { error: why }); };
      req.on("aborted", () => fail("aborted"));
      out.on("error", (e) => fail(e.message));
      out.on("finish", () => {
        if (n !== len) return fail(`got ${n} of ${len} bytes`);
        renameSync(part, target);
        const total = (got.get(parts[1]) ?? 0) + n;
        got.set(parts[1], total);
        log(`sync: ${parts[1]}/${parts[2]} ${(n / 1e6).toFixed(1)} MB (session so far ${(total / 1e6).toFixed(1)} MB)`);
        send(res, 200, { size: n });
      });
      return;
    }
    send(res, 405, { error: "method not allowed" });
  });
  srv.requestTimeout = 0;   // a night of PPG takes minutes over the watch's Wi-Fi
  srv.on("error", (e) => log(`sync HTTP ${syncPort}: ${e.message}`));
  srv.listen(syncPort, "0.0.0.0");
  const udp = startDiscovery(o.livePort, syncPort, log);
  return { close: () => { srv.close(); udp.close(); } };
}
