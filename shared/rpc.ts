import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { EnvironmentDetailResult } from "./core/environments";
import {
  MAX_PATH_FILTERS,
  MAX_THREAD_IDS,
  type ChangesResult,
  type CommitsResult,
  type EnvironmentsResult,
  type PatchesResult,
  type PullRequestResult,
  type ThreadsResult,
} from "./core/project";
import type { Value } from "./core/types";

export const MAX_TILE_ZOOM = 19;

export const foundImageSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
  title: z.string(),
  creator: z.string(),
  license: z.string(),
  licenseUrl: z.string().nullable(),
  sourceUrl: z.string(),
});

export type FoundImage = z.infer<typeof foundImageSchema>;

export const locatedSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export type Located = z.infer<typeof locatedSchema>;

const filePath = z.string().min(1).max(1024);
const agentIdSchema = z.string().min(1).max(128);
const blockKeySchema = z.string().min(1).max(512).nullable();

const loadedDataSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.custom<Value>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const loadedImageSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dataUrl: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), off: z.boolean().optional() }),
]);

const webFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  off: z.boolean().optional(),
});

const webImageSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dataUrl: z.string() }),
  webFailureSchema,
]);

export const loadDataRpc = defineRpc({
  name: "genui.load_data",
  input: z.object({ agentId: agentIdSchema, path: filePath, raw: z.boolean().optional() }),
  output: loadedDataSchema,
});

export const loadImageRpc = defineRpc({
  name: "genui.load_image",
  input: z.object({ agentId: agentIdSchema, path: filePath }),
  output: loadedImageSchema,
});

export const loadAudioRpc = defineRpc({
  name: "genui.load_audio",
  input: z.object({ agentId: agentIdSchema, path: filePath }),
  output: loadedImageSchema,
});

export const renderMarkdownRpc = defineRpc({
  name: "genui.render_markdown",
  input: z.object({ agentId: agentIdSchema, text: z.string() }),
  output: z.object({ markdown: z.string() }),
});

export const checkUiRpc = defineRpc({
  name: "genui.check_ui",
  input: z.object({ agentId: agentIdSchema, spec: z.string().min(1).max(20_000) }),
  output: z.object({ ok: z.boolean(), report: z.string() }),
});

export const uiExamplesRpc = defineRpc({
  name: "genui.ui_examples",
  input: z.object({ components: z.array(z.string().min(1).max(40)).min(1).max(6) }),
  output: z.object({ ok: z.boolean(), text: z.string() }),
});

export const galleryListRpc = defineRpc({
  name: "genui.gallery_list",
  input: z.object({}),
  output: z.object({ names: z.array(z.string()) }),
});

export const galleryGetRpc = defineRpc({
  name: "genui.gallery_get",
  input: z.object({ name: z.string().min(1).max(200) }),
  output: z.object({ source: z.string() }),
});

export const galleryDataRpc = defineRpc({
  name: "genui.gallery_data",
  input: z.object({ path: filePath, raw: z.boolean().optional() }),
  output: loadedDataSchema,
});

export const galleryImageRpc = defineRpc({
  name: "genui.gallery_image",
  input: z.object({ path: filePath }),
  output: loadedImageSchema,
});

export const galleryAudioRpc = defineRpc({
  name: "genui.gallery_audio",
  input: z.object({ path: filePath }),
  output: loadedImageSchema,
});

/** A widget file (`*.ui`) reads relative to its own folder; `widget` is its absolute path. */
const widgetInput = z.object({ widget: filePath, path: filePath });

export const widgetDataRpc = defineRpc({
  name: "genui.widget_data",
  input: widgetInput.extend({ raw: z.boolean().optional() }),
  output: loadedDataSchema,
});

export const widgetImageRpc = defineRpc({
  name: "genui.widget_image",
  input: widgetInput,
  output: loadedImageSchema,
});

export const widgetAudioRpc = defineRpc({
  name: "genui.widget_audio",
  input: widgetInput,
  output: loadedImageSchema,
});

export const widgetRunStateSchema = z.object({
  /** Whether this call ran the script, rather than reporting the last run. */
  ran: z.boolean(),
  ok: z.boolean(),
  /** ISO time the last run finished, or null before the first run. */
  at: z.string().nullable(),
  error: z.string().optional(),
  /** The last lines the script printed, stdout then stderr. */
  output: z.string().optional(),
});
export type WidgetRunState = z.infer<typeof widgetRunStateSchema>;

/** Runs the widget's `@refresh ... run` script when it is due, or now with `force`. */
export const widgetRefreshRpc = defineRpc({
  name: "genui.widget_refresh",
  input: z.object({ widget: filePath, force: z.boolean() }),
  output: widgetRunStateSchema,
});

export const sketchFontRpc = defineRpc({
  name: "genui.sketch_font",
  input: z.object({}),
  output: z.object({ dataUrl: z.string() }),
});

export const webImageRpc = defineRpc({
  name: "genui.web_image",
  input: z.object({ url: z.string().min(1).max(2048) }),
  output: webImageSchema,
});

export const webSearchRpc = defineRpc({
  name: "genui.web_search",
  input: z.object({ query: z.string().min(1).max(200) }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), image: foundImageSchema }),
    webFailureSchema,
  ]),
});

export const webGeocodeRpc = defineRpc({
  name: "genui.web_geocode",
  input: z.object({ name: z.string().min(1).max(200), near: locatedSchema.nullable() }),
  output: z.discriminatedUnion("ok", [
    locatedSchema.extend({ ok: z.literal(true) }),
    webFailureSchema,
  ]),
});

export const webTileRpc = defineRpc({
  name: "genui.web_tile",
  input: z.object({
    z: z.number().int().min(0).max(MAX_TILE_ZOOM),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }),
  output: webImageSchema,
});

export const projectChangesRpc = defineRpc({
  name: "genui.project_changes",
  input: z.object({
    agentId: agentIdSchema,
    target: z.string().max(64).nullable(),
    paths: z.array(z.string().max(1024)).max(MAX_PATH_FILTERS).nullable(),
    blockKey: blockKeySchema,
    refresh: z.boolean(),
  }),
  output: z.custom<ChangesResult>(),
});

export const projectPatchesRpc = defineRpc({
  name: "genui.project_patches",
  input: z.object({
    agentId: agentIdSchema,
    target: z.string().max(64).nullable(),
    paths: z.array(filePath).min(1).max(25),
  }),
  output: z.custom<PatchesResult>(),
});

export const projectCommitsRpc = defineRpc({
  name: "genui.project_commits",
  input: z.object({
    agentId: agentIdSchema,
    blockKey: blockKeySchema,
    refresh: z.boolean(),
  }),
  output: z.custom<CommitsResult>(),
});

export const projectPullRequestRpc = defineRpc({
  name: "genui.project_pull_request",
  input: z.object({ agentId: agentIdSchema }),
  output: z.custom<PullRequestResult>(),
});

export const projectThreadsRpc = defineRpc({
  name: "genui.project_threads",
  input: z.object({
    agentId: agentIdSchema,
    ids: z.array(z.string().max(128)).max(MAX_THREAD_IDS).nullable(),
  }),
  output: z.custom<ThreadsResult>(),
});

export const projectEnvironmentsRpc = defineRpc({
  name: "genui.project_environments",
  input: z.object({ agentId: agentIdSchema }),
  output: z.custom<EnvironmentsResult>(),
});

export const projectEnvironmentRpc = defineRpc({
  name: "genui.project_environment",
  input: z.object({ agentId: agentIdSchema, environmentId: z.string().min(1).max(128) }),
  output: z.custom<EnvironmentDetailResult>(),
});

export const appendDemoRpc = defineRpc({
  name: "genui.append_demo",
  input: z.object({
    agentId: agentIdSchema,
    component: z.string().max(80).optional(),
  }),
  output: z.object({ appended: z.boolean(), name: z.string() }),
});

export const genuiBlockDataSchema = z.object({
  language: z.enum(["ui", "app"]),
  code: z.string(),
  complete: z.boolean(),
  fenceIndex: z.number(),
  messageId: z.string().optional(),
});

export type GenUiBlockData = z.infer<typeof genuiBlockDataSchema>;

export const genuiTextDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]).optional(),
});

export type GenUiTextData = z.infer<typeof genuiTextDataSchema>;
