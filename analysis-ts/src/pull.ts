/**
 * Fetch recordings from the watch over Wi-Fi debugging in one command:
 *   npm run pull                 # new and changed sessions → ../sessions
 *   npm run pull -- --list       # only show what is on the watch
 *   npm run pull -- --delete     # afterwards delete on the watch what is complete and identical locally
 *   npm run pull -- --serial 192.168.1.50:44691 --out D:\sessions
 * The watch is found automatically (see lib/adb.ts). A session that is still recording is fetched as it is now
 * and fetched again next time; it is never deleted.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adb, findWatch, PKG } from "./lib/adb.ts";

export interface RemoteSession { name: string; files: Record<string, number>; bytes: number; lastWrite: number; recording: boolean }

/** Parses `date +%s` followed by `stat -c '%s %Y %n'` lines (paths relative to files/sessions). */
export function parseListing(text: string): RemoteSession[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const now = Number(lines.shift());
  const by = new Map<string, RemoteSession>();
  for (const l of lines) {
    const m = l.match(/^(\d+) (\d+) ([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, size, mtime, name, file] = m;
    const s = by.get(name) ?? { name, files: {}, bytes: 0, lastWrite: 0, recording: false };
    s.files[file] = Number(size); s.bytes += Number(size); s.lastWrite = Math.max(s.lastWrite, Number(mtime));
    by.set(name, s);
  }
  // still recording = written to in the last 2 min (a night whose battery died has no "stop" but is finished)
  for (const s of by.values()) s.recording = Number.isFinite(now) && now - s.lastWrite < 120;
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function localFiles(dir: string): Record<string, number> {
  if (!existsSync(dir)) return {};
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir)) { const st = statSync(join(dir, f)); if (st.isFile()) out[f] = st.size; }
  return out;
}

/** Files of the watch session that are missing locally or have a different size (extra local files like summary.txt are fine). */
export function differences(remote: RemoteSession, local: Record<string, number>): string[] {
  return Object.keys(remote.files).filter((f) => local[f] !== remote.files[f]);
}

/**
 * Minimal streaming tar reader (ustar + GNU long names), enough for toybox `tar c`. Files are written to
 * `<name>.part` and renamed at the end, so an aborted transfer never leaves a truncated file under the real name.
 */
export class TarExtract {
  private buf: Buffer = Buffer.alloc(0);
  private out: WriteStream | null = null;
  private left = 0;
  private pad = 0;
  private longName: string | null = null;
  private longBuf: Buffer[] | null = null;
  private target = "";
  private pending: Promise<void>[] = [];
  files: string[] = [];
  constructor(private root: string, private onFile?: (name: string, size: number) => void) {}

  write(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.left > 0) {
        if (!this.buf.length) return;
        const n = Math.min(this.left, this.buf.length);
        const part = this.buf.subarray(0, n);
        if (this.longBuf) this.longBuf.push(Buffer.from(part)); else this.out?.write(Buffer.from(part));
        this.buf = this.buf.subarray(n); this.left -= n;
        if (this.left === 0) this.finishEntry();
        continue;
      }
      if (this.pad > 0) {
        const n = Math.min(this.pad, this.buf.length);
        this.buf = this.buf.subarray(n); this.pad -= n;
        if (this.pad > 0) return;
        continue;
      }
      if (this.buf.length < 512) return;
      const h = this.buf.subarray(0, 512);
      this.buf = this.buf.subarray(512);
      if (h.every((b) => b === 0)) continue;             // end-of-archive blocks
      const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(str(124, 136).trim() || "0", 8);
      const type = String.fromCharCode(h[156] || 48);
      const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? str(345, 500) : "";
      let name = this.longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
      this.longName = null;
      name = name.replace(/^\.\//, "");
      this.left = size; this.pad = (512 - (size % 512)) % 512;
      if (type === "L") { this.longBuf = []; if (size === 0) this.finishEntry(); continue; }
      if (type === "0" || type === "\0" || type === "7") {
        if (name.split("/").some((p) => p === "..") || name.startsWith("/")) throw new Error(`unsafe path in archive: ${name}`);
        this.target = join(this.root, name);
        mkdirSync(dirname(this.target), { recursive: true });
        const out = createWriteStream(this.target + ".part");
        this.out = out;
        const target = this.target;
        this.pending.push(new Promise((res, rej) => { out.on("finish", () => { renameSync(target + ".part", target); res(); }); out.on("error", rej); }));
        this.files.push(name);
        this.onFile?.(name, size);
        if (size === 0) this.finishEntry();
      } else if (type === "5") {
        mkdirSync(join(this.root, name), { recursive: true });
        this.left = 0; this.pad = 0;
      }
      // other types (links etc.) are skipped: their data, if any, is consumed via left/pad with out = null
    }
  }

  private finishEntry() {
    if (this.longBuf) { this.longName = Buffer.concat(this.longBuf).toString("utf8").replace(/\0.*$/s, ""); this.longBuf = null; return; }
    this.out?.end(); this.out = null;
  }

  async end() { this.out?.end(); await Promise.all(this.pending); }
}

function listRemote(serial: string): RemoteSession[] {
  const r = adb(["-s", serial, "shell", `run-as ${PKG} sh -c 'date +%s; cd files/sessions 2>/dev/null && stat -c "%s %Y %n" */* 2>/dev/null'`], 30000);
  if (!r.ok && !r.out.trim()) throw new Error(`could not read the sessions on the watch: ${r.err.trim()}`);
  return parseListing(r.out);
}

function fetch(serial: string, names: string[], outDir: string): Promise<string[]> {
  return new Promise((res, rej) => {
    const p = spawn("adb", ["-s", serial, "exec-out", `run-as ${PKG} tar c -C files/sessions ${names.join(" ")}`]);
    let got = 0, lastLog = 0;
    const t0 = Date.now();
    const x = new TarExtract(outDir, (name) => process.stdout.write(`\n  ${name} `));
    let failed: Error | null = null;
    p.stdout.on("data", (c: Buffer) => {
      if (failed) return;
      try { x.write(c); } catch (e) { failed = e as Error; p.kill(); return; }
      got += c.length;
      if (Date.now() - lastLog > 1000) { lastLog = Date.now(); process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB, ${(got / 1e6 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s   `); }
    });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("error", rej);
    p.on("close", async (code) => {
      process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      if (failed) return rej(failed);
      try { await x.end(); } catch (e) { return rej(e); }
      if (code !== 0) return rej(new Error(`adb exec-out ended with ${code}: ${err.trim()}`));
      res(x.files);
    });
  });
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

async function main() {
  const args = process.argv.slice(2);
  const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(val("--out") ?? join(here, "..", "..", "sessions"));
  const serial = findWatch(val("--serial"));
  console.log(`Watch: ${serial}   local folder: ${outDir}`);
  const remote = listRemote(serial);
  if (!remote.length) { console.log("No sessions on the watch."); return; }

  const todo: RemoteSession[] = [];
  for (const s of remote) {
    const diff = differences(s, localFiles(join(outDir, s.name)));
    const state = s.recording ? "recording" : diff.length === 0 ? "complete locally" : existsSync(join(outDir, s.name)) ? `${diff.length} file(s) differ` : "new";
    console.log(`  ${s.name}  ${mb(s.bytes).padStart(9)}  ${state}`);
    if (diff.length) todo.push(s);
  }
  if (args.includes("--list")) return;

  if (todo.length) {
    console.log(`Fetching ${todo.length} session(s), ${mb(todo.reduce((a, s) => a + s.bytes, 0))} …`);
    mkdirSync(outDir, { recursive: true });
    await fetch(serial, todo.map((s) => s.name), outDir);
  } else console.log("Nothing new.");

  // check every fetched session against the watch's file sizes
  const bad = todo.filter((s) => !s.recording && differences(s, localFiles(join(outDir, s.name))).length);
  for (const s of bad) console.log(`  WARNING ${s.name}: sizes differ after the transfer: ${differences(s, localFiles(join(outDir, s.name))).join(", ")}`);
  for (const s of todo.filter((x) => !bad.includes(x))) console.log(`  ok ${join(outDir, s.name)}`);

  if (args.includes("--delete")) {
    const del = remote.filter((s) => !s.recording && differences(s, localFiles(join(outDir, s.name))).length === 0);
    if (!del.length) console.log("Nothing to delete on the watch.");
    for (const s of del) {
      const r = adb(["-s", serial, "shell", `run-as ${PKG} rm -r files/sessions/${s.name}`]);
      console.log(`  ${r.ok ? "deleted on the watch" : "could NOT delete"} ${s.name}${r.ok ? "" : `: ${r.err.trim()}`}`);
    }
  } else if (remote.some((s) => !s.recording)) console.log("Tip: --delete removes the sessions on the watch that are complete here.");
  if (todo.some((s) => !s.recording)) console.log(`Next: npm run analyze -- ${join(outDir, todo.filter((s) => !s.recording).at(-1)!.name)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
}
