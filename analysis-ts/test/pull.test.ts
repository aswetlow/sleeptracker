import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { differences, parseListing, TarExtract } from "../src/pull.ts";
import { mdnsTargets } from "../src/lib/adb.ts";

test("parseListing: sizes per session, recording = written in the last 2 min", () => {
  const s = parseListing("1000000\n10 999000 20261101_220000/accel.csv\n5 999000 20261101_220000/hr.csv\n7 999950 20261106_090000/accel.csv\n");
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].files, { "accel.csv": 10, "hr.csv": 5 });
  assert.equal(s[0].recording, false);
  assert.equal(s[1].recording, true);
  assert.deepEqual(differences(s[0], { "accel.csv": 10, "hr.csv": 4, "summary.txt": 99 }), ["hr.csv"]);
});

test("mdnsTargets finds ip:port of wireless debugging", () => {
  assert.deepEqual(mdnsTargets("List of discovered mdns services\nadb-XYZ\t_adb-tls-connect._tcp\t192.168.1.50:44691\nadb-XYZ\t_adb-tls-pairing._tcp\t192.168.1.50:37000\n"), ["192.168.1.50:44691"]);
});

test("TarExtract restores files byte for byte, also in small chunks and with long names", async () => {
  const src = mkdtempSync(join(tmpdir(), "tar-src-")), dst = mkdtempSync(join(tmpdir(), "tar-dst-"));
  const long = "x".repeat(120) + ".csv";
  mkdirSync(join(src, "20261101_220000"));
  const data = Buffer.from(Array.from({ length: 70001 }, (_, i) => (i * 7) % 256));
  writeFileSync(join(src, "20261101_220000", "raw_ppg.csv"), data);
  writeFileSync(join(src, "20261101_220000", long), "a,b\n");
  writeFileSync(join(src, "20261101_220000", "empty.csv"), "");
  const tar = execFileSync("tar", ["c", "-C", src, "20261101_220000"]);
  const x = new TarExtract(dst);
  for (let i = 0; i < tar.length; i += 333) x.write(tar.subarray(i, i + 333));
  await x.end();
  assert.deepEqual(readFileSync(join(dst, "20261101_220000", "raw_ppg.csv")), data);
  assert.equal(readFileSync(join(dst, "20261101_220000", long), "utf8"), "a,b\n");
  assert.equal(readFileSync(join(dst, "20261101_220000", "empty.csv"), "utf8"), "");
});
