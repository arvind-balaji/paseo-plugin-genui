import { constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { collectLoads, compile, parseDataFile, type LoadedData } from "../shared/core";
import { COMPONENTS, componentSignature, type ComponentName } from "../shared/core/catalog";

type PaseoApi = PluginHandlerContext["paseo"];

export const MAX_DATA_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const BB_STORAGE_PREFIX = "$BB_THREAD_STORAGE/";
const PASEO_STORAGE_PREFIX = "$PASEO_THREAD_STORAGE/";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  caf: "audio/x-caf",
};

export type LoadedImage =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly error: string; readonly off?: boolean };

type FileContent =
  | { ok: true; content: string; encoding: "utf8" | "base64" }
  | { ok: false; error: string };

type FileReader = (requested: string, maxBytes: number) => Promise<FileContent>;

const AGENT_REFUSAL =
  "only files in this agent's workspace, its thread storage, /tmp or a folder added in Generative UI settings can be loaded; copy the file to $BB_THREAD_STORAGE to show it";

let extraRoots: readonly string[] = [];

/** Folders, besides the workspace, thread storage and /tmp, that agents may load files from. */
export function setExtraLoadFolders(folders: readonly string[]): void {
  extraRoots = folders.map(expandHome).filter((folder) => path.isAbsolute(folder));
}

function expandHome(requested: string): string {
  return requested === "~" || requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(1)) : requested;
}

const GALLERY_REFUSAL = "gallery specs can only load files in gallery/";

function contains(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedRoot === resolvedTarget) return false;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function agentStorageDir(agentId: string): string {
  const safeId = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join("/tmp/opencode/genui-storage", safeId);
}

const cwdCache = new Map<string, { at: number; cwd: string | null }>();
const CWD_CACHE_MS = 60_000;

export async function resolveAgentCwd(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const cached = cwdCache.get(agentId);
  if (cached !== undefined && Date.now() - cached.at < CWD_CACHE_MS) return cached.cwd;
  try {
    const handle = paseo.agents.ref(agentId);
    const current = handle.current();
    if (current?.cwd) {
      cwdCache.set(agentId, { at: Date.now(), cwd: current.cwd });
      return current.cwd;
    }
    const refreshed = await handle.refresh();
    const cwd = refreshed?.agent.cwd ?? null;
    cwdCache.set(agentId, { at: Date.now(), cwd });
    return cwd;
  } catch {
    return null;
  }
}

interface Attempt {
  readonly root: string;
  readonly target: string;
}

type AttemptOutcome =
  | { ok: true; content: string; encoding: "utf8" | "base64" }
  | { ok: false; error: string; outsideRoot?: boolean };

/**
 * Resolves both `root` and `target` with `realpath` before checking containment,
 * rejects any symlink or intermediate directory link that escapes `realRoot`,
 * and reads from the validated canonical path with `O_NOFOLLOW`.
 */
async function readConfinedFile(
  root: string,
  target: string,
  requested: string,
  maxBytes: number,
  refusalError: string,
): Promise<AttemptOutcome> {
  if (!contains(root, target)) {
    return { ok: false, error: refusalError, outsideRoot: true };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, error: refusalError };
  }

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, error: "file not found" };
    }
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  if (!contains(realRoot, realTarget)) {
    return { ok: false, error: refusalError, outsideRoot: true };
  }

  const openFlags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(realTarget, openFlags);
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: "not a regular file" };
    if (info.size > maxBytes) {
      return { ok: false, error: `${info.size} bytes is over the ${maxBytes}-byte limit` };
    }
    const extension = /\.([^./\\]+)$/.exec(requested)?.[1]?.toLowerCase() ?? "";
    const binary =
      (Object.hasOwn(IMAGE_TYPES, extension) && extension !== "svg") ||
      Object.hasOwn(AUDIO_TYPES, extension);
    const content = await handle.readFile();
    return binary
      ? { ok: true, content: content.toString("base64"), encoding: "base64" }
      : { ok: true, content: content.toString("utf8"), encoding: "utf8" };
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
    return {
      ok: false,
      error: code === "ENOENT" ? "file not found" : cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function tempAttempts(target: string): Attempt[] {
  if (contains("/private/tmp", target)) return [{ root: "/private/tmp", target }];
  if (!contains("/tmp", target)) return [];
  return [
    { root: "/private/tmp", target: path.join("/private", target) },
    { root: "/tmp", target },
  ];
}

async function readAgentFile(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
  maxBytes: number,
): Promise<FileContent> {
  const storageRoot = agentStorageDir(agentId);
  await mkdir(storageRoot, { recursive: true }).catch(() => undefined);
  const workspaceCwd = await resolveAgentCwd(paseo, agentId);

  const inside = (root: string | null, target: string): Attempt[] =>
    root !== null && contains(root, target) ? [{ root, target }] : [];

  let attempts: Attempt[];
  if (requested.startsWith(BB_STORAGE_PREFIX)) {
    const rel = requested.slice(BB_STORAGE_PREFIX.length);
    attempts = inside(storageRoot, path.resolve(storageRoot, rel));
  } else if (requested.startsWith(PASEO_STORAGE_PREFIX)) {
    const rel = requested.slice(PASEO_STORAGE_PREFIX.length);
    attempts = inside(storageRoot, path.resolve(storageRoot, rel));
  } else if (path.isAbsolute(expandHome(requested))) {
    const target = path.resolve(expandHome(requested));
    attempts = [...inside(storageRoot, target), ...inside(workspaceCwd, target)].slice(0, 1);
    if (attempts.length === 0) attempts = tempAttempts(target);
    if (attempts.length === 0) attempts = extraRoots.flatMap((root) => inside(root, target)).slice(0, 1);
  } else {
    attempts = [
      ...inside(workspaceCwd, workspaceCwd !== null ? path.resolve(workspaceCwd, requested) : ""),
      ...inside(storageRoot, path.resolve(storageRoot, requested)),
    ];
  }

  if (attempts.length === 0) {
    return { ok: false, error: AGENT_REFUSAL };
  }

  let firstFailure: FileContent | undefined;
  for (const attempt of attempts) {
    const result = await readConfinedFile(attempt.root, attempt.target, requested, maxBytes, AGENT_REFUSAL);
    if (result.ok) return result;
    if (result.outsideRoot) return { ok: false, error: AGENT_REFUSAL };
    firstFailure ??= { ok: false, error: result.error };
  }
  return firstFailure!;
}

async function loadWith(read: FileReader, requested: string, raw: boolean): Promise<LoadedData> {
  const file = await read(requested, MAX_DATA_BYTES);
  if (!file.ok) return file;
  if (file.encoding !== "utf8") return { ok: false, error: "not a text file" };
  if (!raw) return parseDataFile(requested, file.content);
  return { ok: true, value: file.content.startsWith("\uFEFF") ? file.content.slice(1) : file.content };
}

async function loadMediaWith(
  read: FileReader,
  requested: string,
  types: Readonly<Record<string, string>>,
  maxBytes: number,
  noun: string,
): Promise<LoadedImage> {
  const extension = /\.([^./\\]+)$/.exec(requested)?.[1]?.toLowerCase();
  if (extension === undefined || !Object.hasOwn(types, extension)) {
    return { ok: false, error: `only ${Object.keys(types).join(", ")} ${noun} can be shown` };
  }
  const file = await read(requested, maxBytes);
  if (!file.ok) return file;
  const base64 =
    file.encoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64");
  return { ok: true, dataUrl: `data:${types[extension]};base64,${base64}` };
}

export function loadAgentFile(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
  { raw = false }: { raw?: boolean } = {},
): Promise<LoadedData> {
  return loadWith((target, maxBytes) => readAgentFile(paseo, agentId, target, maxBytes), requested, raw);
}

export function loadAgentImage(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
): Promise<LoadedImage> {
  return loadMediaWith(
    (target, maxBytes) => readAgentFile(paseo, agentId, target, maxBytes),
    requested,
    IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    "images",
  );
}

export function loadAgentAudio(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
): Promise<LoadedImage> {
  return loadMediaWith(
    (target, maxBytes) => readAgentFile(paseo, agentId, target, maxBytes),
    requested,
    AUDIO_TYPES,
    MAX_AUDIO_BYTES,
    "recordings",
  );
}

const WIDGET_REFUSAL =
  "widgets can only load files in their own folder, /tmp, or the extra folders in Generative UI settings";

/** Reads `requested` relative to `root` (a widget's folder), or an absolute path in /tmp or an extra folder. */
async function readRootedFile(root: string, requested: string, maxBytes: number): Promise<FileContent> {
  const target = path.resolve(root, expandHome(requested));
  let attempts: Attempt[] = contains(root, target) ? [{ root, target }] : [];
  if (attempts.length === 0) attempts = tempAttempts(target);
  if (attempts.length === 0) {
    attempts = extraRoots.flatMap((extra) => (contains(extra, target) ? [{ root: extra, target }] : [])).slice(0, 1);
  }
  if (attempts.length === 0) return { ok: false, error: WIDGET_REFUSAL };

  let firstFailure: FileContent | undefined;
  for (const attempt of attempts) {
    const result = await readConfinedFile(attempt.root, attempt.target, requested, maxBytes, WIDGET_REFUSAL);
    if (result.ok) return result;
    if (result.outsideRoot) return { ok: false, error: WIDGET_REFUSAL };
    firstFailure ??= { ok: false, error: result.error };
  }
  return firstFailure!;
}

export function loadRootedFile(
  root: string,
  requested: string,
  { raw = false }: { raw?: boolean } = {},
): Promise<LoadedData> {
  return loadWith((target, maxBytes) => readRootedFile(root, target, maxBytes), requested, raw);
}

export function loadRootedImage(root: string, requested: string): Promise<LoadedImage> {
  return loadMediaWith(
    (target, maxBytes) => readRootedFile(root, target, maxBytes),
    requested,
    IMAGE_TYPES,
    MAX_IMAGE_BYTES,
    "images",
  );
}

export function loadRootedAudio(root: string, requested: string): Promise<LoadedImage> {
  return loadMediaWith(
    (target, maxBytes) => readRootedFile(root, target, maxBytes),
    requested,
    AUDIO_TYPES,
    MAX_AUDIO_BYTES,
    "recordings",
  );
}

let cachedPluginRoot: string | null = null;

function resolvePluginRoot(): string {
  if (cachedPluginRoot !== null) return cachedPluginRoot;

  const hasGallery = (dir: string): boolean => {
    try {
      return existsSync(path.join(dir, "gallery", "Card.ui"));
    } catch {
      return false;
    }
  };

  try {
    if (typeof import.meta.url === "string" && import.meta.url.startsWith("file:")) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const candidate =
        path.basename(here) === "server" || path.basename(here) === "dist"
          ? path.dirname(here)
          : here;
      if (hasGallery(candidate)) {
        cachedPluginRoot = candidate;
        return candidate;
      }
    }
  } catch {
    // Compiled server bundle has no file:// import.meta.url
  }

  if (hasGallery(process.cwd())) {
    cachedPluginRoot = process.cwd();
    return cachedPluginRoot;
  }

  const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  try {
    const raw = readFileSync(path.join(paseoHome, "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { plugins?: Record<string, { path?: string }> };
    for (const entry of Object.values(cfg.plugins ?? {})) {
      if (typeof entry?.path === "string" && hasGallery(entry.path)) {
        cachedPluginRoot = entry.path;
        return entry.path;
      }
    }
  } catch {
    // Ignore config read failure
  }

  try {
    const pluginsDir = path.join(paseoHome, "plugins");
    for (const idDir of readdirSync(pluginsDir)) {
      const idPath = path.join(pluginsDir, idDir);
      for (const revDir of readdirSync(idPath)) {
        const checkout = path.join(idPath, revDir, "checkout");
        if (hasGallery(checkout)) {
          cachedPluginRoot = checkout;
          return checkout;
        }
        const nm = path.join(idPath, revDir, "node_modules");
        if (existsSync(nm)) {
          for (const pkg of readdirSync(nm)) {
            const pkgPath = path.join(nm, pkg);
            if (hasGallery(pkgPath)) {
              cachedPluginRoot = pkgPath;
              return pkgPath;
            }
          }
        }
      }
    }
  } catch {
    // Ignore scan failure
  }

  return process.cwd();
}

export function packagePath(...parts: string[]): string {
  return path.join(resolvePluginRoot(), ...parts);
}

export function galleryDir(): string {
  return packagePath("gallery");
}

let sketchFont: Promise<string> | null = null;

export function sketchFontDataUrl(): Promise<string> {
  sketchFont ??= readFile(packagePath("assets", "fonts", "Excalifont-Regular-latin.woff2")).then(
    (bytes) => `data:font/woff2;base64,${bytes.toString("base64")}`,
  );
  return sketchFont;
}

const GALLERY_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ui$/;

export async function listGallery(): Promise<string[]> {
  const entries = await readdir(galleryDir(), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && GALLERY_SPEC.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function readGallerySpec(name: string): Promise<string> {
  const normalized = name.endsWith(".ui") ? name : `${name}.ui`;
  if (!GALLERY_SPEC.test(normalized)) throw new Error(`not a gallery spec: ${name}`);
  return readFile(path.join(galleryDir(), normalized), "utf8");
}

async function readGalleryFile(requested: string, maxBytes: number): Promise<FileContent> {
  const root = galleryDir();
  const clean = requested.startsWith(BB_STORAGE_PREFIX)
    ? requested.slice(BB_STORAGE_PREFIX.length)
    : requested;
  const target = path.resolve(root, clean);
  if (path.isAbsolute(clean) || !contains(root, target)) {
    return { ok: false, error: GALLERY_REFUSAL };
  }
  const result = await readConfinedFile(root, target, clean, maxBytes, GALLERY_REFUSAL);
  return result.ok ? result : { ok: false, error: result.error };
}

export function loadGalleryFile(requested: string, { raw = false }: { raw?: boolean } = {}): Promise<LoadedData> {
  return loadWith(readGalleryFile, requested, raw);
}

export function loadGalleryImage(requested: string): Promise<LoadedImage> {
  return loadMediaWith(readGalleryFile, requested, IMAGE_TYPES, MAX_IMAGE_BYTES, "images");
}

export function loadGalleryAudio(requested: string): Promise<LoadedImage> {
  return loadMediaWith(readGalleryFile, requested, AUDIO_TYPES, MAX_AUDIO_BYTES, "recordings");
}

const DATA_PREVIEW_CHARS = 600;

function isComponentName(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENTS, name);
}

function examplesOf(names: readonly string[], component: string): string[] {
  return names
    .filter((name) => name === `${component}.ui` || name.startsWith(`${component}-`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

async function describeExample(name: string): Promise<string> {
  const source = (await readGallerySpec(name)).trimEnd();
  const parts = [`\`\`\`ui\n${source}\n\`\`\``];
  const program = compile(source).program;
  for (const request of program === null ? [] : collectLoads(program)) {
    const loaded = await loadGalleryFile(request.path, { raw: true });
    if (!loaded.ok || typeof loaded.value !== "string") continue;
    const text = loaded.value.trim();
    const shown = text.length > DATA_PREVIEW_CHARS ? `${text.slice(0, DATA_PREVIEW_CHARS)}…` : text;
    parts.push(`"${request.path}" in this example holds:\n${shown}`);
  }
  return parts.join("\n");
}

export async function examplesReport(components: readonly string[]): Promise<{ ok: boolean; text: string }> {
  const names = await listGallery();
  const sections: string[] = [];
  let ok = true;
  for (const component of components) {
    if (!isComponentName(component)) {
      ok = false;
      sections.push(`${component}: not a component.`);
      continue;
    }
    const examples = examplesOf(names, component).slice(0, 3);
    const described = await Promise.all(examples.map(describeExample));
    sections.push(
      [
        `## ${componentSignature(component)}`,
        ...(described.length > 0 ? described : ["No example yet."]),
      ].join("\n"),
    );
  }
  return { ok, text: sections.join("\n\n") };
}
