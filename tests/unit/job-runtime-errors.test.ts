import { describe, expect, it } from "vitest";

import { classifyRuntimeError } from "../../src/jobs/runtime-errors.js";

describe("job runtime error classification", () => {
  it.each([
    ["ENOSPC", "insufficient_disk_space"],
    ["EDQUOT", "insufficient_disk_space"],
    ["SQLITE_FULL", "insufficient_disk_space"],
    ["EACCES", "disk_write_failure"],
    ["EPERM", "disk_write_failure"],
    ["EROFS", "disk_write_failure"],
    ["EIO", "disk_write_failure"],
    ["SQLITE_BUSY", "database_unavailable"],
    ["SQLITE_LOCKED", "database_unavailable"],
    ["SQLITE_CORRUPT", "database_unavailable"],
    ["SQLITE_NOTADB", "database_unavailable"],
    ["SQLITE_CANTOPEN", "database_unavailable"],
    ["SQLITE_IOERR_WRITE", "database_unavailable"],
    ["SQLITE_READONLY", "database_unavailable"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(classifyRuntimeError(errorWithCode(code))).toBe(expected);
  });

  it("unwraps causes without exposing their messages", () => {
    const cause = errorWithCode("ENOSPC", "PRIVATE_CHILD_PATH");
    expect(classifyRuntimeError(new Error("outer", { cause }))).toBe(
      "insufficient_disk_space",
    );
  });

  it("recognizes a closed better-sqlite3 connection", () => {
    expect(
      classifyRuntimeError(
        new TypeError("The database connection is not open"),
      ),
    ).toBe("database_unavailable");
  });

  it("does not misclassify unrelated failures", () => {
    expect(classifyRuntimeError(new Error("fixture failure"))).toBeNull();
  });
});

function errorWithCode(code: string, message = "fixture"): Error {
  return Object.assign(new Error(message), { code });
}
