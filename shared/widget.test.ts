import { describe, expect, it } from "vitest";
import { compileStreaming } from "./core";
import { formatAge, parseInterval, parseWidget, splitArgs } from "./widget";

describe("widget files", () => {
  it("reads @refresh with and without a script, and keeps the spec's line numbers", () => {
    const plain = parseWidget('@refresh 5m\n\nCard("A", [Text("x")])');
    expect(plain.errors).toEqual([]);
    expect(plain.refresh).toEqual({ everyMs: 300_000, every: "5m", run: null });
    expect(plain.code.split("\n")[2]).toBe('Card("A", [Text("x")])');
    expect(compileStreaming(plain.code).program).not.toBeNull();

    const scripted = parseWidget('@refresh 1h run ./update.sh --out "data dir/x.json"\nText("hi")');
    expect(scripted.refresh?.run).toEqual({
      command: "./update.sh",
      args: ["--out", "data dir/x.json"],
    });
    expect(scripted.refresh?.everyMs).toBe(3_600_000);
  });

  it("treats a file without directives as a plain spec", () => {
    const parsed = parseWidget('Text("hi")\n@refresh 5m');
    expect(parsed.refresh).toBeNull();
    expect(parsed.code).toBe('Text("hi")\n@refresh 5m');
  });

  it("reports bad directives with their line", () => {
    const parsed = parseWidget('@refresh soon\n@refresh 2s\n@title X\n@refresh 5m go\nText("x")');
    expect(parsed.refresh).toBeNull();
    expect(parsed.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(parsed.errors[1]!.message).toMatch(/at most every 10s/);
  });

  it("rejects a second @refresh and a run without a script", () => {
    expect(parseWidget('@refresh 5m\n@refresh 1h\nText("x")').errors[0]!.message).toMatch(/only one/);
    expect(parseWidget('@refresh 5m run\nText("x")').errors[0]!.message).toMatch(/needs a script/);
  });

  it("parses intervals and arguments", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("1.5h")).toBe(5_400_000);
    expect(parseInterval("2d")).toBe(172_800_000);
    expect(parseInterval("5")).toBeNull();
    expect(splitArgs(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
    expect(splitArgs(`a "unclosed`)).toBeNull();
    expect(formatAge(10_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5m ago");
  });
});
