import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRootedFile } from "./data-source";
import { forgetWidgetRuns, refreshWidget, resolveWidget } from "./widgets";

let base: string;
let trusted: string;
let other: string;

async function widget(
  dir: string,
  name: string,
  header: string,
  script?: { name: string; body: string; exec?: boolean },
) {
  const file = path.join(dir, name);
  await writeFile(file, `${header}\nCard("W", [KeyValue(Load("data.json"))])\n`);
  if (script !== undefined) {
    const target = path.join(dir, script.name);
    await writeFile(target, script.body);
    if (script.exec !== false) await chmod(target, 0o755);
  }
  return file;
}

beforeEach(async () => {
  forgetWidgetRuns();
  base = await mkdtemp(path.join(os.tmpdir(), "genui-widgets-"));
  trusted = path.join(base, "trusted");
  other = path.join(base, "other");
  await mkdir(trusted);
  await mkdir(other);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("widget refresh scripts", () => {
  it("runs the script in the widget's folder and reports when it ran", async () => {
    const file = await widget(trusted, "a.ui", "@refresh 5m run ./update.sh hello", {
      name: "update.sh",
      body: '#!/bin/sh\necho "{\\"said\\": \\"$1\\", \\"cwd\\": \\"$(pwd)\\"}" > data.json\necho done',
    });
    const state = await refreshWidget(file, {
      force: false,
      trustedFolders: [trusted],
    });
    expect(state).toMatchObject({ ran: true, ok: true, output: "done" });
    expect(state.at).not.toBeNull();
    const loaded = await loadRootedFile(trusted, "data.json");
    expect(loaded).toEqual({
      ok: true,
      value: { said: "hello", cwd: trusted },
    });
  });

  it("skips a run that is not due, and runs again with force", async () => {
    const file = await widget(trusted, "a.ui", "@refresh 5m run ./count.sh", {
      name: "count.sh",
      body: "#!/bin/sh\necho x >> runs.txt",
    });
    expect((await refreshWidget(file, { force: false, trustedFolders: [trusted] })).ran).toBe(true);
    expect((await refreshWidget(file, { force: false, trustedFolders: [trusted] })).ran).toBe(false);
    expect((await refreshWidget(file, { force: true, trustedFolders: [trusted] })).ran).toBe(true);
    expect(await loadRootedFile(trusted, "runs.txt", { raw: true })).toEqual({
      ok: true,
      value: "x\nx\n",
    });
  });

  it("shares one run between concurrent callers", async () => {
    const file = await widget(trusted, "a.ui", "@refresh 5m run ./slow.sh", {
      name: "slow.sh",
      body: "#!/bin/sh\nsleep 0.3\necho x >> runs.txt",
    });
    const both = await Promise.all([
      refreshWidget(file, { force: true, trustedFolders: [trusted] }),
      refreshWidget(file, { force: true, trustedFolders: [trusted] }),
    ]);
    expect(both.every((state) => state.ok)).toBe(true);
    expect(await loadRootedFile(trusted, "runs.txt", { raw: true })).toEqual({
      ok: true,
      value: "x\n",
    });
  });

  it("refuses widgets outside the trusted folders and never runs their script", async () => {
    const file = await widget(other, "a.ui", "@refresh 5m run ./update.sh", {
      name: "update.sh",
      body: "#!/bin/sh\ntouch ran",
    });
    for (const trustedFolders of [[], [trusted], [path.join(base, "missing")]]) {
      const state = await refreshWidget(file, { force: true, trustedFolders });
      expect(state).toMatchObject({ ran: true, ok: false });
      expect(state.error).toMatch(/trusted folder/);
    }
    expect((await loadRootedFile(other, "ran", { raw: true })).ok).toBe(false);
  });

  it("refuses a widget reached through a symlink from a trusted folder", async () => {
    const file = await widget(other, "a.ui", "@refresh 5m run ./update.sh", {
      name: "update.sh",
      body: "#!/bin/sh\ntouch ran",
    });
    await symlink(file, path.join(trusted, "link.ui"));
    const state = await refreshWidget(path.join(trusted, "link.ui"), {
      force: true,
      trustedFolders: [trusted],
    });
    expect(state.error).toMatch(/trusted folder/);
  });

  it("refuses scripts outside the widget's folder, missing or not executable", async () => {
    await writeFile(path.join(base, "outside.sh"), "#!/bin/sh\ntrue");
    await chmod(path.join(base, "outside.sh"), 0o755);
    const escape = await widget(trusted, "a.ui", "@refresh 5m run ../outside.sh");
    expect((await refreshWidget(escape, { force: true, trustedFolders: [trusted] })).error).toMatch(
      /widget's folder/,
    );

    const missing = await widget(trusted, "b.ui", "@refresh 5m run ./nope.sh");
    expect((await refreshWidget(missing, { force: true, trustedFolders: [trusted] })).error).toMatch(
      /not found/,
    );

    const plain = await widget(trusted, "c.ui", "@refresh 5m run ./plain.sh", {
      name: "plain.sh",
      body: "#!/bin/sh\ntrue",
      exec: false,
    });
    expect((await refreshWidget(plain, { force: true, trustedFolders: [trusted] })).error).toMatch(
      /not executable/,
    );
  });

  it("reports a failing or hung script with its output", async () => {
    const failing = await widget(trusted, "a.ui", "@refresh 5m run ./fail.sh", {
      name: "fail.sh",
      body: "#!/bin/sh\necho 'disk check failed' >&2\nexit 3",
    });
    expect(await refreshWidget(failing, { force: true, trustedFolders: [trusted] })).toMatchObject({
      ok: false,
      error: "exited with code 3",
      output: "disk check failed",
    });

    const hung = await widget(trusted, "b.ui", "@refresh 5m run ./hang.sh", {
      name: "hang.sh",
      body: "#!/bin/sh\nsleep 30",
    });
    const state = await refreshWidget(hung, {
      force: true,
      trustedFolders: [trusted],
      timeoutMs: 300,
    });
    expect(state).toMatchObject({ ok: false, error: "stopped after 0s" });
  });

  it("has nothing to run for a widget without a script", async () => {
    const file = await widget(trusted, "a.ui", "@refresh 5m");
    expect(await refreshWidget(file, { force: true, trustedFolders: [] })).toEqual({
      ran: false,
      ok: true,
      at: null,
    });
  });
});

describe("widget files and loads", () => {
  it("only accepts existing *.ui files", async () => {
    await writeFile(path.join(trusted, "x.txt"), "");
    expect((await resolveWidget(path.join(trusted, "x.txt"))).ok).toBe(false);
    expect((await resolveWidget("relative.ui")).ok).toBe(false);
    expect((await resolveWidget(path.join(trusted, "missing.ui"))).ok).toBe(false);
    const file = await widget(trusted, "a.ui", "");
    expect(await resolveWidget(file)).toEqual({ ok: true, file, dir: trusted });
  });

  it("loads beside the widget and refuses paths that leave its folder", async () => {
    await writeFile(path.join(trusted, "data.json"), '{"a": 1}');
    expect(await loadRootedFile(trusted, "data.json")).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(await loadRootedFile(trusted, "./data.json")).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect((await loadRootedFile(trusted, "/etc/hostname")).ok).toBe(false);
    await symlink("/etc/hostname", path.join(trusted, "host.txt"));
    const escaped = await loadRootedFile(trusted, "host.txt", { raw: true });
    expect(escaped.ok).toBe(false);
  });
});
