import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middleware/errorHandler.js";
import { resolveTargetMemberFromRows } from "./memberScopeUtils.js";

test("resolveTargetMemberFromRows defaults to actor when member is omitted", () => {
  const scope = resolveTargetMemberFromRows(
    { id: "actor-1", householdId: "hh-1" },
    null,
    undefined
  );

  assert.equal(scope.actorMemberId, "actor-1");
  assert.equal(scope.targetMemberId, "actor-1");
  assert.equal(scope.householdId, "hh-1");
});

test("resolveTargetMemberFromRows allows same-household member selection", () => {
  const scope = resolveTargetMemberFromRows(
    { id: "actor-1", householdId: "hh-1" },
    { id: "member-2", householdId: "hh-1" },
    "member-2"
  );

  assert.equal(scope.actorMemberId, "actor-1");
  assert.equal(scope.targetMemberId, "member-2");
  assert.equal(scope.householdId, "hh-1");
});

test("resolveTargetMemberFromRows rejects cross-household member selection", () => {
  assert.throws(
    () =>
      resolveTargetMemberFromRows(
        { id: "actor-1", householdId: "hh-1" },
        { id: "member-3", householdId: "hh-2" },
        "member-3"
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 403);
      return true;
    }
  );
});
