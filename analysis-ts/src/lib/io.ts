/** Dateien lesen/schreiben, Zeitzonen, Zahlformat wie Python. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TZ = "Europe/Berlin";

/** Numerische CSV-Spalten (Kopfzeile, Komma-getrennt) als Float64Arrays. Nicht-Zahlen werden NaN. */
export function readNumericCsv(path: string, cols?: string[]): Record<string, Float64Array> {
  const buf = readFileSync(path);
  let nl = buf.indexOf(10);
  const header = buf.toString("latin1", 0, nl).replace(/\r$/, "").split(",");
  const want = (cols ?? header).map((c) => {
    const i = header.indexOf(c);
    if (i < 0) throw new Error(`${path}: Spalte ${c} fehlt`);
    return i;
  });
  let lines = 0;
  for (let i = nl + 1; i < buf.length; i++) if (buf[i] === 10) lines++;
  if (buf[buf.length - 1] !== 10) lines++;
  const out = want.map(() => new Float64Array(lines));
  let row = 0, pos = nl + 1;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = buf.length;
    if (end > pos) {
      const parts = buf.toString("latin1", pos, end).split(",");
      for (let k = 0; k < want.length; k++) {
        const v = parts[want[k]];
        out[k][row] = v === undefined || v === "" ? NaN : Number(v);
      }
      row++;
    }
    pos = end + 1;
  }
  const res: Record<string, Float64Array> = {};
  (cols ?? header).forEach((c, k) => (res[c] = out[k].subarray(0, row)));
  return res;
}

/** events.csv: epoch_ms,"text" */
export function readEvents(session: string): { t: number; event: string }[] {
  const p = join(session, "events.csv");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const i = l.indexOf(",");
    let e = l.slice(i + 1);
    if (e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1).replace(/""/g, '"');
    return { t: Number(l.slice(0, i)), event: e };
  });
}

/** Datensätze nach einem Zeitfeld sortieren (stabil), alle Spalten mit. */
export function sortBy(cols: Record<string, Float64Array>, key: string): Record<string, Float64Array> {
  const t = cols[key];
  let sorted = true;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (sorted) return cols;
  const idx = Array.from(t, (_, i) => i).sort((a, b) => t[a] - t[b] || a - b);
  const out: Record<string, Float64Array> = {};
  for (const [k, v] of Object.entries(cols)) out[k] = Float64Array.from(idx, (i) => v[i]);
  return out;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number) {
  let f = fmtCache.get("p");
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    fmtCache.set("p", f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** Versatz Berlin gegen UTC in Minuten für einen Zeitpunkt. */
export function tzOffsetMin(ms: number): number {
  const o = parts(ms);
  const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export const hms = (ms: number) => { const o = parts(ms); return `${o.hour}:${o.minute}:${o.second}`; };
export const hm = (ms: number) => { const o = parts(ms); return `${o.hour}:${o.minute}`; };

/** "2026-11-03 23:06:00+01:00" wie pandas beim CSV-Export. */
export function isoLocal(ms: number): string {
  const o = parts(ms);
  const off = tzOffsetMin(ms);
  const s = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Lokale Berliner Zeit ohne Versatz ("2026-11-04T01:02:00.000") -> epoch ms. */
export function berlinToEpoch(local: string): number {
  const m = local.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?/);
  if (!m) return NaN;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7] ? +m[7].slice(0, 3).padEnd(3, "0") : 0);
  let t = naive - tzOffsetMin(naive) * 60000;
  t = naive - tzOffsetMin(t) * 60000;
  return t;
}

/** Zahl wie Python repr (kürzeste Darstellung, NaN leer wie pandas). */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1).replace(/\.0$/, ".0");
  return String(v);
}

/**
 * Python-artiges f"{v:.{d}f}" (NaN -> "nan"): rundet den exakten Binärwert, bei genau .5 zur geraden
 * Ziffer (2.25 -> "2.2", 0.5 -> "0"). JS toFixed würde hier aufrunden.
 */
export function f(v: number, d = 0): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v) || Math.abs(v) >= 1e21) return String(v);
  const exact = Math.abs(v).toFixed(Math.min(100, d + 60));   // exakte Dezimaldarstellung des Doubles
  const [ip, fp] = exact.split(".");
  const keep = fp.slice(0, d), rest = fp.slice(d);
  let digits = ip + keep;
  const up = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || Number(digits[digits.length - 1]) % 2 === 1));
  if (up) {
    const arr = digits.split("").map(Number);
    let i = arr.length - 1;
    while (i >= 0) { if (arr[i] === 9) { arr[i] = 0; i--; } else { arr[i]++; break; } }
    if (i < 0) arr.unshift(1);
    digits = arr.join("");
  }
  const intPart = digits.slice(0, digits.length - d) || "0";
  const out = d ? `${intPart}.${digits.slice(digits.length - d)}` : intPart;
  return v < 0 || Object.is(v, -0) ? "-" + out : out;   // Python schreibt auch "-0"
}

export function writeCsv(path: string, header: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const cell = (v: string | number | boolean | null | undefined) =>
    typeof v === "number" ? num(v) : typeof v === "boolean" ? (v ? "True" : "False") : v == null ? "" :
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  writeFileSync(path, [header.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n");
}

export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
