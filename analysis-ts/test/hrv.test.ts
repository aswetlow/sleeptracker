import assert from "node:assert/strict";
import { test } from "node:test";
import { hrv } from "../src/lib/hrv.ts";

test("hrv: RMSSD/SDNN of a known series, extrasystole counted once and excluded", () => {
  const base = Array.from({ length: 200 }, (_, i) => 1000 + (i % 2 ? 20 : -20));   // successive diff 40 ms
  const h = hrv(base);
  assert.equal(h.rmssd, 40);
  assert.equal(h.ectopic, 0);
  assert.equal(h.valid, true);
  const es = base.slice(); es[100] = 600; es[101] = 1400;                              // premature beat + pause
  const h2 = hrv(es);
  assert.equal(h2.ectopic, 1);
  assert.equal(h2.rmssd, 40);
  assert.equal(h2.nn, 198);
  const short = hrv(base.slice(0, 60));
  assert.equal(short.valid, false);
  assert.match(short.note, /only 60 s/);
});
