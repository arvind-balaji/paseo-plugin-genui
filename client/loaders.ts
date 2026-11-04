import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collectLoads, dataKey, type DataRequest, type LoadedData, type Program } from "../shared/core";
import type { EnvironmentDetailResult } from "../shared/core/environments";
import type {
  ChangesResult,
  CommitsResult,
  EnvironmentsResult,
  PatchesResult,
  PullRequestResult,
  ThreadsResult,
} from "../shared/core/project";
import {
  galleryAudioRpc,
  galleryDataRpc,
  galleryImageRpc,
  loadAudioRpc,
  loadDataRpc,
  loadImageRpc,
  projectChangesRpc,
  projectCommitsRpc,
  projectEnvironmentRpc,
  projectEnvironmentsRpc,
  projectPatchesRpc,
  projectPullRequestRpc,
  projectThreadsRpc,
  webGeocodeRpc,
  webImageRpc,
  webSearchRpc,
  webTileRpc,
  widgetAudioRpc,
  widgetDataRpc,
  widgetImageRpc,
  type FoundImage,
  type Located,
} from "../shared/rpc";
import type { ImageUrl, TextFile } from "./runtime";

/**
 * Where a UI's files come from: an agent's workspace, a widget file's folder, or the gallery.
 * A widget's `generation` goes up when it refreshes, so its loads are fetched again.
 */
export type FileScope =
  | { readonly agentId: string }
  | { readonly widget: string; readonly generation: number }
  | "gallery";

export function scopeKeyOf(scope: FileScope): string {
  if (scope === "gallery") return "gallery";
  if ("widget" in scope) return `widget:${scope.widget}:${scope.generation}`;
  return scope.agentId;
}

type LoadedMedia = { ok: true; dataUrl: string } | { ok: false; error: string; off?: boolean };

interface Loaders {
  data(path: string, raw: boolean | undefined): Promise<LoadedData>;
  image(path: string): Promise<LoadedMedia>;
  audio(path: string): Promise<LoadedMedia>;
}

const LOADED_CACHE = new Map<string, LoadedData>();
const MAX_LOADED = 200;

function rememberLoaded(key: string, loaded: LoadedData): void {
  if (!loaded.ok) return;
  LOADED_CACHE.delete(key);
  LOADED_CACHE.set(key, loaded);
  if (LOADED_CACHE.size > MAX_LOADED) {
    const first = LOADED_CACHE.keys().next().value;
    if (first !== undefined) LOADED_CACHE.delete(first);
  }
}

export function useLoaders(scope: FileScope): Loaders {
  const loadData = useRpc(loadDataRpc);
  const loadImage = useRpc(loadImageRpc);
  const loadAudio = useRpc(loadAudioRpc);
  const galleryData = useRpc(galleryDataRpc);
  const galleryImage = useRpc(galleryImageRpc);
  const galleryAudio = useRpc(galleryAudioRpc);
  const webImage = useRpc(webImageRpc);
  const widgetData = useRpc(widgetDataRpc);
  const widgetImage = useRpc(widgetImageRpc);
  const widgetAudio = useRpc(widgetAudioRpc);

  const agentId = scope !== "gallery" && "agentId" in scope ? scope.agentId : null;
  const widget = scope !== "gallery" && "widget" in scope ? scope.widget : null;

  return useMemo(() => {
    const files: Omit<Loaders, "image"> & { image: Loaders["image"] } =
      widget !== null
        ? {
            data: (path, raw) => widgetData({ widget, path, raw }),
            image: (path) => widgetImage({ widget, path }),
            audio: (path) => widgetAudio({ widget, path }),
          }
        : agentId !== null
          ? {
              data: (path, raw) => loadData({ agentId, path, raw }),
              image: (path) => loadImage({ agentId, path }),
              audio: (path) => loadAudio({ agentId, path }),
            }
          : {
              data: (path, raw) => galleryData({ path, raw }),
              image: (path) => galleryImage({ path }),
              audio: (path) => galleryAudio({ path }),
            };
    return {
      data: files.data,
      image: (src) => (/^https?:\/\//i.test(src) ? webImage({ url: src }) : files.image(src)),
      audio: files.audio,
    };
  }, [
    agentId,
    widget,
    galleryAudio,
    galleryData,
    galleryImage,
    loadAudio,
    loadData,
    loadImage,
    webImage,
    widgetAudio,
    widgetData,
    widgetImage,
  ]);
}

export function useLoadedData(scope: FileScope, program: Program | null): ReadonlyMap<string, LoadedData> {
  const loaders = useLoaders(scope);
  const scopeKey = scopeKeyOf(scope);
  const requestsKey = useMemo(
    () => (program === null ? "[]" : JSON.stringify(collectLoads(program))),
    [program],
  );
  const [data, setData] = useState<ReadonlyMap<string, LoadedData>>(() => {
    const found = new Map<string, LoadedData>();
    for (const request of JSON.parse(requestsKey) as DataRequest[]) {
      const hit = LOADED_CACHE.get(`${scopeKey}|${dataKey(request)}`);
      if (hit !== undefined) found.set(dataKey(request), hit);
    }
    return found;
  });

  // Keys loaded for the current scope. A new scope (a widget's refresh) loads everything again,
  // while the previous values stay on screen until the new ones arrive.
  const fresh = useRef({ scopeKey, keys: new Set<string>(data.keys()) });
  if (fresh.current.scopeKey !== scopeKey) fresh.current = { scopeKey, keys: new Set() };

  useEffect(() => {
    const requests = JSON.parse(requestsKey) as DataRequest[];
    const missing = requests.filter((request) => !fresh.current.keys.has(dataKey(request)));
    if (missing.length === 0) return;
    for (const request of missing) fresh.current.keys.add(dataKey(request));
    const settled = new Set<string>();
    let live = true;
    for (const request of missing) {
      const key = dataKey(request);
      loaders.data(request.path, request.raw).then(
        (loaded) => {
          settled.add(key);
          rememberLoaded(`${scopeKey}|${key}`, loaded);
          if (live) setData((previous) => new Map(previous).set(key, loaded));
        },
        (cause: unknown) => {
          settled.add(key);
          const error = cause instanceof Error ? cause.message : String(cause);
          if (live) setData((previous) => new Map(previous).set(key, { ok: false, error }));
        },
      );
    }
    return () => {
      live = false;
      // Requests cut short are asked for again by the next run of this effect.
      for (const request of missing) {
        if (!settled.has(dataKey(request))) fresh.current.keys.delete(dataKey(request));
      }
    };
  }, [loaders, requestsKey, scopeKey]);

  return data;
}

export function useImageLoader(scope: FileScope): (src: string) => Promise<ImageUrl> {
  const loaders = useLoaders(scope);
  const images = useRef(new Map<string, Promise<ImageUrl>>());
  const scopeKey = scopeKeyOf(scope);
  return useCallback(
    (src: string) => {
      const key = `${scopeKey}|${src}`;
      const cached = images.current.get(key);
      if (cached !== undefined) return cached;
      const pending = loaders.image(src).then(
        (loaded): ImageUrl => (loaded.ok ? { ok: true, url: loaded.dataUrl } : loaded),
        (cause: unknown): ImageUrl => ({
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      images.current.set(key, pending);
      void pending.then((image) => {
        if (!image.ok) images.current.delete(key);
      });
      return pending;
    },
    [loaders, scopeKey],
  );
}

export function useAudioLoader(scope: FileScope): (src: string) => Promise<ImageUrl> {
  const loaders = useLoaders(scope);
  const audios = useRef(new Map<string, Promise<ImageUrl>>());
  const scopeKey = scopeKeyOf(scope);
  return useCallback(
    (src: string) => {
      const key = `${scopeKey}|${src}`;
      const cached = audios.current.get(key);
      if (cached !== undefined) return cached;
      const pending = loaders.audio(src).then(
        (loaded): ImageUrl => (loaded.ok ? { ok: true, url: loaded.dataUrl } : loaded),
        (cause: unknown): ImageUrl => ({
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      audios.current.set(key, pending);
      void pending.then((audio) => {
        if (!audio.ok) audios.current.delete(key);
      });
      return pending;
    },
    [loaders, scopeKey],
  );
}

export function useTextLoader(scope: FileScope): (path: string) => Promise<TextFile> {
  const loaders = useLoaders(scope);
  const scopeKey = scopeKeyOf(scope);
  return useCallback(
    async (path: string): Promise<TextFile> => {
      const key = `${scopeKey}|${dataKey({ path, raw: true })}`;
      const toText = (loaded: LoadedData): TextFile =>
        !loaded.ok
          ? loaded
          : typeof loaded.value === "string"
            ? { ok: true, text: loaded.value }
            : { ok: false, error: `${path} is not a text file` };
      const cached = LOADED_CACHE.get(key);
      if (cached !== undefined) return toText(cached);
      try {
        const loaded = await loaders.data(path, true);
        rememberLoaded(key, loaded);
        return toText(loaded);
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    [loaders, scopeKey],
  );
}

export type SearchResult =
  | { readonly ok: true; readonly image: FoundImage }
  | { readonly ok: false; readonly error: string; readonly off?: boolean };

const searchCache = new Map<string, Promise<SearchResult>>();

export function useImageSearch(query: string): SearchResult | null {
  const webSearch = useRpc(webSearchRpc);
  const key = query.trim().replace(/\s+/g, " ").toLowerCase();
  const [result, setResult] = useState<{ readonly key: string; readonly result: SearchResult } | null>(null);

  useEffect(() => {
    if (key === "") return;
    let live = true;
    let pending = searchCache.get(key);
    if (!pending) {
      pending = webSearch({ query: key }).catch((cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
      searchCache.set(key, pending);
      void pending.then((res) => {
        if (!res.ok) searchCache.delete(key);
      });
    }
    void pending.then((found) => {
      if (live) setResult({ key, result: found });
    });
    return () => {
      live = false;
    };
  }, [webSearch, key]);

  return result !== null && result.key === key ? result.result : null;
}

export type PlaceResult =
  | { readonly ok: true; readonly lat: number; readonly lng: number }
  | { readonly ok: false; readonly error: string; readonly off?: boolean };

const placeCache = new Map<string, Promise<PlaceResult>>();

export function useGeocodePlace() {
  const webGeocode = useRpc(webGeocodeRpc);
  return useCallback(
    (name: string, near: Located | null): Promise<PlaceResult> => {
      const bias = near === null ? "" : `${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
      const key = `${name.trim().toLowerCase()}|${bias}`;
      const existing = placeCache.get(key);
      if (existing !== undefined) return existing;
      const pending = webGeocode({ name: name.trim(), near }).catch((cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
      placeCache.set(key, pending);
      void pending.then((res) => {
        if (!res.ok) placeCache.delete(key);
      });
      return pending;
    },
    [webGeocode],
  );
}

const tileCache = new Map<string, string>();
const tileRequests = new Map<string, Promise<{ readonly ok: true; readonly dataUrl: string } | { readonly ok: false; readonly error: string; readonly off?: boolean }>>();

export function useMapTileLoader() {
  const webTile = useRpc(webTileRpc);
  return useCallback(
    async (z: number, x: number, y: number) => {
      const key = `${z}/${x}/${y}`;
      const known = tileCache.get(key);
      if (known !== undefined) return { ok: true as const, dataUrl: known };
      let pending = tileRequests.get(key);
      if (!pending) {
        pending = webTile({ z, x, y }).catch((cause: unknown) => ({
          ok: false as const,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
        tileRequests.set(key, pending);
      }
      const res = await pending;
      tileRequests.delete(key);
      if (res.ok) {
        tileCache.set(key, res.dataUrl);
        if (tileCache.size > 400) {
          const oldest = tileCache.keys().next().value;
          if (oldest !== undefined) tileCache.delete(oldest);
        }
      }
      return res;
    },
    [webTile],
  );
}

export function useProjectRpc() {
  const changes = useRpc(projectChangesRpc);
  const patches = useRpc(projectPatchesRpc);
  const commits = useRpc(projectCommitsRpc);
  const pullRequest = useRpc(projectPullRequestRpc);
  const threads = useRpc(projectThreadsRpc);
  const environments = useRpc(projectEnvironmentsRpc);
  const environment = useRpc(projectEnvironmentRpc);

  return useMemo(
    () => ({
      changes: (input: {
        agentId: string;
        target: string | null;
        paths: string[] | null;
        blockKey: string | null;
        refresh: boolean;
      }): Promise<ChangesResult> => changes(input),
      patches: (input: {
        agentId: string;
        target: string | null;
        paths: string[];
      }): Promise<PatchesResult> => patches(input),
      commits: (input: {
        agentId: string;
        blockKey: string | null;
        refresh: boolean;
      }): Promise<CommitsResult> => commits(input),
      pullRequest: (input: { agentId: string }): Promise<PullRequestResult> => pullRequest(input),
      threads: (input: { agentId: string; ids: string[] | null }): Promise<ThreadsResult> =>
        threads(input),
      environments: (input: { agentId: string }): Promise<EnvironmentsResult> =>
        environments(input),
      environment: (input: {
        agentId: string;
        environmentId: string;
      }): Promise<EnvironmentDetailResult> => environment(input),
    }),
    [changes, commits, environment, environments, patches, pullRequest, threads],
  );
}
