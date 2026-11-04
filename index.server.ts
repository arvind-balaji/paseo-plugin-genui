import { mkdir } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkSpec, renderReplyMarkdown, repairRequest, REPAIR_MARKER } from "./shared/fallback";
import { buildFullInstructions, GENUI_MARKER } from "./shared/instructions";
import {
  appendDemoRpc,
  checkUiRpc,
  galleryAudioRpc,
  galleryDataRpc,
  galleryGetRpc,
  galleryImageRpc,
  galleryListRpc,
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
  renderMarkdownRpc,
  sketchFontRpc,
  uiExamplesRpc,
  webGeocodeRpc,
  webImageRpc,
  webSearchRpc,
  webTileRpc,
  widgetAudioRpc,
  widgetDataRpc,
  widgetImageRpc,
  widgetRefreshRpc,
} from "./shared/rpc";
import { GENUI_BLOCK_KIND } from "./shared/segment";
import { genuiSettings, parseFolders } from "./shared/settings";
import {
  agentStorageDir,
  examplesReport,
  listGallery,
  loadAgentAudio,
  loadAgentFile,
  loadAgentImage,
  loadGalleryAudio,
  loadGalleryFile,
  loadGalleryImage,
  readGallerySpec,
  setExtraLoadFolders,
  sketchFontDataUrl,
  loadRootedAudio,
  loadRootedFile,
  loadRootedImage,
} from "./server/data-source";
import {
  createProjectReader,
  readProjectChanges,
  readProjectCommits,
  readProjectEnvironment,
  readProjectEnvironments,
  readProjectPatches,
  readProjectPullRequest,
  readProjectThreads,
} from "./server/project";
import { renderUiTool } from "./server/render-tool";
import { refreshWidget, resolveWidget } from "./server/widgets";
import { createWebLookups } from "./server/web/lookups";

const DEFAULT_DEMO_SPEC = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats), note: $seats + " seats on " + $plan),
  Button("Go with " + $plan, Send("Go with " + $plan + " (" + $seats + " seats)"), variant: "primary")
])`;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(genuiSettings);
  let webLookupsEnabled = true;

  let widgetFolders: string[] = [];

  void settings.read().then((state) => {
    if (state.status !== "ready") return;
    webLookupsEnabled = state.values.webLookups;
    setExtraLoadFolders(parseFolders(state.values.extraFolders));
    widgetFolders = parseFolders(state.values.widgetFolders);
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status !== "ready") return;
    webLookupsEnabled = state.values.webLookups;
    setExtraLoadFolders(parseFolders(state.values.extraFolders));
    widgetFolders = parseFolders(state.values.widgetFolders);
  });

  const web = createWebLookups(
    async () => {
      const current = await settings.read();
      return current.status === "ready" ? current.values.webLookups : true;
    },
    () => webLookupsEnabled,
  );

  const findImage = async (query: string) => {
    const found = await web.search(query);
    return found.ok ? found.image : null;
  };

  server.before("agent.create", async ({ request }) => {
    const current = await settings.read();
    if (current.status === "ready" && !current.values.autoInstructions) return;
    const webOn = current.status === "ready" ? current.values.webLookups : true;
    const extraFolders = current.status === "ready" ? parseFolders(current.values.extraFolders) : [];
    const existing = request.config.systemPrompt ?? "";
    if (existing.includes(GENUI_MARKER)) return;
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: [existing, buildFullInstructions(webOn, extraFolders)].filter(Boolean).join("\n\n"),
      },
    };
  });

  // A ```ui block that fails shows the user an error box. Send the errors back so the
  // agent rewrites the block; one attempt per user message, so a failed fix cannot loop.
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (event.outcome.kind !== "completed" || event.agent.parentAgentId) return;
    const current = await settings.read();
    if (current.status === "ready" && !current.values.autoInstructions) return;
    const agent = paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 40 });
    if (page.error) return;
    const items = page.entries.map((entry) => entry.item);
    const lastUser = items.findLastIndex((item) => item.type === "user_message");
    if (lastUser >= 0 && items[lastUser].type === "user_message" && items[lastUser].text.startsWith(REPAIR_MARKER)) return;
    const reply = items
      .slice(lastUser + 1)
      .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
      .join("\n\n");
    const request = await repairRequest(reply, (req) => loadAgentFile(paseo, event.agent.id, req.path, req));
    if (request !== null) await agent.send(request);
  });

  // render_ui only reads files the plugin may already read and adds UI to the chat, so it needs no prompt.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    if (!/^(mcp__paseo__|paseo\.)render_ui$/.test(request.name)) return;
    await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  server.before("agent.session_open", async ({ request }) => {
    const current = await settings.read();
    const renderTool = current.status !== "ready" || current.values.autoInstructions;
    const storageDir = agentStorageDir(request.agentId);
    await mkdir(storageDir, { recursive: true }).catch(() => undefined);
    return {
      ...request,
      tools: renderTool ? [...request.tools, renderUiTool] : request.tools,
      env: {
        ...request.env,
        BB_THREAD_STORAGE: storageDir,
        PASEO_THREAD_STORAGE: storageDir,
      },
    };
  });

  server.handle(loadDataRpc, ({ agentId, path, raw }, { paseo }) =>
    loadAgentFile(paseo, agentId, path, { raw }),
  );
  server.handle(loadImageRpc, ({ agentId, path }, { paseo }) =>
    loadAgentImage(paseo, agentId, path),
  );
  server.handle(loadAudioRpc, ({ agentId, path }, { paseo }) =>
    loadAgentAudio(paseo, agentId, path),
  );

  server.handle(renderMarkdownRpc, async ({ agentId, text }, { paseo }) => {
    const markdown = await renderReplyMarkdown(
      text,
      (req) => loadAgentFile(paseo, agentId, req.path, req),
      findImage,
      createProjectReader(paseo, agentId),
    );
    return { markdown };
  });

  server.handle(checkUiRpc, ({ agentId, spec }, { paseo }) =>
    checkSpec(
      spec,
      (req) => loadAgentFile(paseo, agentId, req.path, req),
      findImage,
      createProjectReader(paseo, agentId),
    ),
  );

  server.handle(uiExamplesRpc, ({ components }) => examplesReport(components));

  server.handle(galleryListRpc, async () => ({ names: await listGallery() }));
  server.handle(galleryGetRpc, async ({ name }) => ({ source: await readGallerySpec(name) }));
  server.handle(galleryDataRpc, ({ path, raw }) => loadGalleryFile(path, { raw }));
  server.handle(galleryImageRpc, ({ path }) => loadGalleryImage(path));
  server.handle(galleryAudioRpc, ({ path }) => loadGalleryAudio(path));

  const inWidget = async <T>(
    widget: string,
    load: (dir: string) => Promise<T>,
  ): Promise<T | { ok: false; error: string }> => {
    const resolved = await resolveWidget(widget);
    return resolved.ok ? load(resolved.dir) : { ok: false, error: resolved.error };
  };
  server.handle(widgetDataRpc, ({ widget, path, raw }) =>
    inWidget(widget, (dir) => loadRootedFile(dir, path, { raw: raw ?? false })),
  );
  server.handle(widgetImageRpc, ({ widget, path }) => inWidget(widget, (dir) => loadRootedImage(dir, path)));
  server.handle(widgetAudioRpc, ({ widget, path }) => inWidget(widget, (dir) => loadRootedAudio(dir, path)));
  server.handle(widgetRefreshRpc, async ({ widget, force }) => {
    const current = await settings.read();
    const trusted = current.status === "ready" ? parseFolders(current.values.widgetFolders) : widgetFolders;
    return refreshWidget(widget, { force, trustedFolders: trusted });
  });
  server.handle(sketchFontRpc, async () => ({ dataUrl: await sketchFontDataUrl() }));

  server.handle(webImageRpc, ({ url }) => web.image(url));
  server.handle(webSearchRpc, ({ query }) => web.search(query));
  server.handle(webGeocodeRpc, ({ name, near }) => web.geocode(name, near));
  server.handle(webTileRpc, ({ z, x, y }) => web.tile(z, x, y));

  server.handle(projectChangesRpc, ({ agentId, target, paths }, { paseo }) =>
    readProjectChanges(paseo, agentId, target, paths),
  );
  server.handle(projectPatchesRpc, ({ agentId, target, paths }, { paseo }) =>
    readProjectPatches(paseo, agentId, target, paths),
  );
  server.handle(projectCommitsRpc, ({ agentId }, { paseo }) =>
    readProjectCommits(paseo, agentId),
  );
  server.handle(projectPullRequestRpc, ({ agentId }, { paseo }) =>
    readProjectPullRequest(paseo, agentId),
  );
  server.handle(projectThreadsRpc, ({ agentId, ids }, { paseo }) =>
    readProjectThreads(paseo, agentId, ids),
  );
  server.handle(projectEnvironmentsRpc, ({ agentId }, { paseo }) =>
    readProjectEnvironments(paseo, agentId, false),
  );
  server.handle(projectEnvironmentRpc, ({ agentId, environmentId }, { paseo }) =>
    readProjectEnvironment(paseo, agentId, environmentId),
  );

  let demoSeq = 0;
  server.handle(appendDemoRpc, async ({ agentId, component }, { paseo }) => {
    let code = DEFAULT_DEMO_SPEC;
    let name = "Estimate";
    if (component && component.trim() !== "") {
      try {
        code = await readGallerySpec(component.trim());
        name = component.trim();
      } catch {
        // Fall back to default demo spec if the named gallery file doesn't exist
      }
    }
    const id = `genui-demo-${Date.now()}-${++demoSeq}`;
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id,
      kind: GENUI_BLOCK_KIND,
      version: 1,
      data: {
        language: "ui",
        code,
        complete: true,
        fenceIndex: 0,
        messageId: id,
      },
    });
    return { appended: true, name };
  });

  return () => {
    unsubscribeSettings();
  };
}
