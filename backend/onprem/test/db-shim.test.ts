import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyUpdate, evaluateCondition } from "../src/shims/db";

test("conditions match DynamoDB for the forms the handlers use", () => {
  const invite = "attribute_not_exists(email) OR attribute_exists(redeemedAt) OR expiresAt < :now";
  assert.equal(evaluateCondition(invite, undefined, { ":now": "2026" }), true);
  assert.equal(evaluateCondition(invite, { email: "a", expiresAt: "2027" }, { ":now": "2026" }), false);
  assert.equal(evaluateCondition(invite, { email: "a", expiresAt: "2025" }, { ":now": "2026" }), true);
  assert.equal(evaluateCondition("attribute_not_exists(mountPath)", { mountPath: "x" }), false);
});

test("an expression the shim doesn't know fails instead of passing", () => {
  assert.throws(() => evaluateCondition("size(email) > :n", {}, {}), /Unsupported/);
  assert.throws(() => applyUpdate({}, "ADD count :n", {}, { ":n": 1 }), /Unsupported/);
});

test("updates set and remove attributes", () => {
  const out = applyUpdate({ a: 1, b: 2 }, "SET #x = :x, c = :c REMOVE b", { "#x": "a" }, { ":x": 9, ":c": 3 });
  assert.deepEqual(out, { a: 9, c: 3 });
});
