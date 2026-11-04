import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WidgetRunState } from "../shared/rpc";
import { parseWidget } from "../shared/widget";

export const RUN_TIMEOUT_MS = 120_000;
const MAX_WIDGET_BYTES = 256 * 1024;
const OUTPUT_TAIL = 2_000;

export type WidgetFile = { ok: true; file: string; dir: string } | { ok: false; error: string };

function expandHome(folder: string): string {
  return folder === "~" || folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(1)) : folder;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The widget's canonical path and folder, after checking it is a regular `*.ui` file. */
export async function resolveWidget(widget: string): Promise<WidgetFile> {
  if (!path.isAbsolute(widget) || !widget.toLowerCase().endsWith(".ui")) {
    return {
      ok: false,
      error: "not a widget file (an absolute path ending in .ui)",
    };
  }
  try {
    const file = await realpath(widget);
    if (!file.toLowerCase().endsWith(".ui") || !(await stat(file)).isFile()) {
      return { ok: false, error: "not a widget file" };
    }
    return { ok: true, file, dir: path.dirname(file) };
  } catch {
    return { ok: false, error: "widget file not found" };
  }
}

interface RunRecord {
  ok: boolean;
  at: string;
  finishedAt: number;
  error?: string;
  output?: string;
}

const lastRuns = new Map<string, RunRecord>();
const running = new Map<string, Promise<WidgetRunState>>();

function stateOf(record: RunRecord | undefined, ran: boolean): WidgetRunState {
  if (record === undefined) return { ran, ok: true, at: null };
  return {
    ran,
    ok: record.ok,
    at: record.at,
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.output !== undefined ? { output: record.output } : {}),
  };
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

async function trustedRoot(file: string, trustedFolders: readonly string[]): Promise<boolean> {
  for (const folder of trustedFolders) {
    try {
      if (inside(await realpath(expandHome(folder)), file)) return true;
    } catch {
      // A trusted folder that does not exist trusts nothing.
    }
  }
  return false;
}

function exec(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const output = tail([stdout, stderr].filter(Boolean).join("\n"));
        if (error === null) return resolve({ ok: true, output });
        const reason =
          "killed" in error && error.killed
            ? `stopped after ${Math.round(timeoutMs / 1000)}s`
            : typeof error.code === "number"
              ? `exited with code ${error.code}`
              : error.message;
        resolve({ ok: false, output, error: reason });
      },
    );
  });
}

/**
 * Runs the widget's `@refresh <every> run <script>` when the last run is older than <every>, or
 * at once with `force`. The script comes from the file on disk, never from the caller; it must be
 * an executable file inside the widget's folder, and the widget must sit in a trusted folder. One
 * run per widget at a time; concurrent callers share it.
 */
export async function refreshWidget(
  widget: string,
  {
    force,
    trustedFolders,
    timeoutMs = RUN_TIMEOUT_MS,
  }: {
    force: boolean;
    trustedFolders: readonly string[];
    timeoutMs?: number;
  },
): Promise<WidgetRunState> {
  const resolved = await resolveWidget(widget);
  if (!resolved.ok) return { ran: false, ok: false, at: null, error: resolved.error };
  const { file, dir } = resolved;

  const pending = running.get(file);
  if (pending !== undefined) return pending;
  const job = runIfDue(file, dir, force, trustedFolders, timeoutMs).finally(() => running.delete(file));
  running.set(file, job);
  return job;
}

async function runIfDue(
  file: string,
  dir: string,
  force: boolean,
  trustedFolders: readonly string[],
  timeoutMs: number,
): Promise<WidgetRunState> {
  let source: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_WIDGET_BYTES)
      return {
        ran: false,
        ok: false,
        at: null,
        error: "widget file is too large",
      };
    source = await readFile(file, "utf8");
  } catch (cause) {
    return {
      ran: false,
      ok: false,
      at: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const refresh = parseWidget(source).refresh;
  const run = refresh?.run ?? null;
  const last = lastRuns.get(file);
  if (refresh === null || run === null) return stateOf(last, false);
  if (!force && last !== undefined && Date.now() - last.finishedAt < refresh.everyMs * 0.9) {
    return stateOf(last, false);
  }

  const fail = (error: string): WidgetRunState => {
    const record: RunRecord = {
      ok: false,
      at: new Date().toISOString(),
      finishedAt: Date.now(),
      error,
    };
    lastRuns.set(file, record);
    return stateOf(record, true);
  };
  if (!(await trustedRoot(file, trustedFolders))) {
    return fail(
      "refresh scripts only run for widgets in a trusted folder; add its folder under Settings → Plugins → Generative UI → Widget folders",
    );
  }
  const script = path.resolve(dir, expandHome(run.command));
  let realScript: string;
  try {
    realScript = await realpath(script);
  } catch {
    return fail(`${run.command} not found next to the widget`);
  }
  if (!inside(dir, realScript)) return fail(`${run.command} must be in the widget's folder`);
  try {
    if (!(await stat(realScript)).isFile()) return fail(`${run.command} is not a file`);
    await access(realScript, constants.X_OK);
  } catch {
    return fail(`${run.command} is not executable (chmod +x, with a #! line)`);
  }
  const result = await exec(realScript, run.args, dir, timeoutMs);
  const record: RunRecord = {
    ok: result.ok,
    at: new Date().toISOString(),
    finishedAt: Date.now(),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.output !== "" ? { output: result.output } : {}),
  };
  lastRuns.set(file, record);
  return stateOf(record, true);
}

/** For tests. */
export function forgetWidgetRuns(): void {
  lastRuns.clear();
  running.clear();
}
