/**
 * Finding the watch over Wi-Fi debugging without typing IP:port.
 * Order: --serial if given → devices adb already knows → mDNS (`adb mdns services`, works once the watch has been
 * paired with this PC) → `adb connect` to what mDNS found. With several devices the one that has the app wins.
 */
import { spawnSync } from "node:child_process";

export const PKG = "de.alex.sleeplogger";

export function adb(args: string[], timeout = 15000) {
  const r = spawnSync("adb", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error((r.error as NodeJS.ErrnoException).code === "ENOENT" ? "adb not found – is it on PATH?" : String(r.error));
  return { ok: r.status === 0, out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString() };
}

export function onlineDevices(): string[] {
  return adb(["devices"]).out.split("\n").slice(1).map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device").map((p) => p[0]);
}

/** ip:port of devices announcing wireless debugging via mDNS. */
export function mdnsTargets(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (!l.includes("_adb-tls-connect")) continue;
    const m = l.match(/(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function hasApp(serial: string) {
  return adb(["-s", serial, "shell", `run-as ${PKG} ls files`], 8000).ok;
}

/** Serial of the watch, connecting via mDNS if needed. Throws with a helpful message when nothing is found. */
export function findWatch(serial?: string, log: (s: string) => void = console.log): string {
  if (serial) {
    if (/:\d+$/.test(serial) && !onlineDevices().includes(serial)) adb(["connect", serial]);
    return serial;
  }
  let devs = onlineDevices();
  if (!devs.length) {
    // a freshly started adb server needs a few seconds before mDNS has seen the watch
    let targets: string[] = [];
    for (let i = 0; i < 8 && !targets.length; i++) {
      if (i) { if (i === 1) log("searching for the watch via mDNS …"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }
      targets = mdnsTargets(adb(["mdns", "services"]).out);
    }
    for (const t of targets) { log(`connecting to ${t} (found via mDNS)`); adb(["connect", t]); }
    devs = onlineDevices();
  }
  if (!devs.length) {
    throw new Error("Watch not found. On the watch: Settings → Developer options → Wireless debugging on (watch and PC in " +
      "the same Wi-Fi). If it still isn't found, connect once by hand: adb connect <IP:port shown on the watch>, or pass --serial.");
  }
  if (devs.length === 1) return devs[0];
  // the watch often shows up twice (IP:port and the mDNS name); any of them with the app is fine
  const withApp = devs.find(hasApp);
  if (withApp) return withApp;
  throw new Error(`Several devices (${devs.join(", ")}), none with ${PKG}. Choose one with --serial.`);
}
