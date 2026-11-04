/**
 * Widget files (`*.ui`) are a ui spec saved to disk, opened as their own tab and kept. Lines at the
 * top that start with `@` are directives for the widget, not part of the spec:
 *
 *   @refresh 5m                    reload the widget's Load/Image/Audio data every 5 minutes
 *   @refresh 1h run ./update.sh a  run ./update.sh (beside the widget) first, then reload
 *
 * Blank lines may sit between directives. The spec starts at the first other line.
 */

export const MIN_REFRESH_MS = 10_000;

export interface WidgetRun {
  /** Path of the script, as written; resolved against the widget's folder by the daemon. */
  readonly command: string;
  readonly args: readonly string[];
}

export interface WidgetRefresh {
  readonly everyMs: number;
  readonly every: string;
  readonly run: WidgetRun | null;
}

export interface WidgetDirectiveError {
  readonly line: number;
  readonly message: string;
}

export interface ParsedWidget {
  /** The spec with directive lines blanked, so diagnostics keep the file's line numbers. */
  readonly code: string;
  readonly refresh: WidgetRefresh | null;
  readonly errors: readonly WidgetDirectiveError[];
}

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseInterval(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(text.trim());
  if (match === null) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2]!.toLowerCase()]!;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** Splits on whitespace; double or single quotes keep spaces inside one argument. */
export function splitArgs(text: string): string[] | null {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let match: RegExpExecArray | null;
  let consumed = "";
  while ((match = pattern.exec(text)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]!);
    consumed += match[0];
  }
  const stray = text.replace(/\s+/g, "").length !== consumed.replace(/\s+/g, "").length;
  return stray ? null : args;
}

function parseRefresh(rest: string): WidgetRefresh | string {
  const [every = "", ...tail] = rest.trim().split(/\s+/);
  const everyMs = parseInterval(every);
  if (everyMs === null) return `"${every}" is not an interval; use a number with s, m, h or d, like 5m`;
  if (everyMs < MIN_REFRESH_MS) return `refresh at most every ${MIN_REFRESH_MS / 1000}s`;
  if (tail.length === 0) return { everyMs, every, run: null };
  if (tail[0] !== "run") return `expected "run <script>" after the interval, got "${tail.join(" ")}"`;
  const words = splitArgs(rest.trim().slice(rest.trim().indexOf("run") + 3));
  if (words === null || words.length === 0) return `"run" needs a script, like run ./update.sh`;
  const [command, ...args] = words;
  return { everyMs, every, run: { command: command!, args } };
}

export function parseWidget(source: string): ParsedWidget {
  const lines = source.replace(/^﻿/, "").split("\n");
  const errors: WidgetDirectiveError[] = [];
  let refresh: WidgetRefresh | null = null;
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    if (!line.startsWith("@")) break;
    const [, name = "", rest = ""] = /^@(\S*)\s*(.*)$/.exec(line) ?? [];
    if (name === "refresh") {
      const parsed = parseRefresh(rest);
      if (typeof parsed === "string") errors.push({ line: index + 1, message: parsed });
      else if (refresh !== null)
        errors.push({
          line: index + 1,
          message: "only one @refresh per widget",
        });
      else refresh = parsed;
    } else {
      errors.push({
        line: index + 1,
        message: `unknown directive @${name}; widgets know @refresh`,
      });
    }
    lines[index] = "";
  }
  return { code: lines.join("\n"), refresh, errors };
}

export function formatAge(ms: number): string {
  if (ms < 45_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
