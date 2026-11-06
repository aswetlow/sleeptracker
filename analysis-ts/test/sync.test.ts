import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivate } from "../src/lib/sync_server.ts";

test("isPrivate: home networks yes, public no", () => {
  for (const a of ["127.0.0.1", "::ffff:192.168.178.35", "10.1.2.3", "172.20.0.5", "169.254.1.1", "::1"]) assert.equal(isPrivate(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "::ffff:93.184.216.34", undefined]) assert.equal(isPrivate(a), false, String(a));
});
