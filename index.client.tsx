import type { PluginClientContext } from "@getpaseo/plugin/client";
import React from "react";
import { buildFullInstructions } from "./shared/instructions";
import {
  appendDemoRpc,
  genuiBlockDataSchema,
  genuiTextDataSchema,
} from "./shared/rpc";
import {
  GENUI_BLOCK_KIND,
  GENUI_TEXT_KIND,
  splitTimelineMessage,
} from "./shared/segment";
import {
  GalleryScreen,
  GallerySidebarItem,
  GalleryWorkspacePanel,
} from "./client/gallery";
import { TimelineBlockItem, TimelineTextItem } from "./client/live-ui";
import { registerQueuePills } from "./client/queue-pill";
import { GenUiSettingsScreen } from "./client/settings";
import { WidgetPanel } from "./client/widget-panel";

export default function contribute(client: PluginClientContext) {
  const playAudio = async (dataUrl: string) => {
    const comma = dataUrl.indexOf(",");
    if (comma === -1) return;
    const header = dataUrl.slice(0, comma);
    const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
    const mimeType = mimeMatch?.[1] ?? "audio/wav";
    const base64 = dataUrl.slice(comma + 1);
    await client.playAudio({ base64, mimeType });
  };

  const removeQueuePills = registerQueuePills(client);

  client.addTimelineTransformer({
    id: "genui-assistant",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      return splitTimelineMessage(item.text, phase, item.messageId);
    },
  });

  client.addTimelineRenderer({
    kind: GENUI_BLOCK_KIND,
    version: 1,
    schema: genuiBlockDataSchema,
    Component: (props) => <TimelineBlockItem {...props} playAudio={playAudio} />,
  });

  client.addTimelineRenderer({
    kind: GENUI_TEXT_KIND,
    version: 1,
    schema: genuiTextDataSchema,
    Component: TimelineTextItem,
  });

  client.addScreen({
    id: "gallery",
    title: "Gen-UI Gallery",
    Component: (props) => <GalleryScreen {...props} playAudio={playAudio} />,
  });

  client.addSidebarHeaderItem({
    id: "gallery",
    title: "Gen-UI Gallery",
    Component: GallerySidebarItem,
  });

  client.addWorkspacePanel({
    id: "gallery",
    title: "Gen-UI Gallery",
    icon: "LayoutGrid",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: (props) => <GalleryWorkspacePanel {...props} playAudio={playAudio} />,
  });

  client.addFilePanel({
    id: "widget",
    title: "Widget",
    icon: "LayoutDashboard",
    files: { extensions: ["ui"] },
    Component: (props) => <WidgetPanel {...props} playAudio={playAudio} />,
  });
  client.addSettingsScreen({
    id: "preferences",
    title: "Generative UI",
    icon: "LayoutGrid",
    Component: GenUiSettingsScreen,
  });

  client.addSlashCommand({
    name: "genui",
    description: "Enable Generative UI inline components for this agent",
    argumentHint: "[prompt]",
    context: "agent",
    async onSubmit({ args, paseo, agent }) {
      const prompt = args.trim()
        ? `${buildFullInstructions(true)}\n\n${args.trim()}`
        : `${buildFullInstructions(true)}\n\nAcknowledge briefly and use \`\`\`ui blocks in your replies from now on.`;
      await paseo.agents.ref(agent.id).send(prompt);
    },
  });

  client.addSlashCommand({
    name: "genui-demo",
    description: "Insert a live interactive Gen-UI block into this chat",
    argumentHint: "[ComponentName]",
    context: "agent",
    async onSubmit({ args, rpc, agent }) {
      await rpc(appendDemoRpc, {
        agentId: agent.id,
        ...(args.trim() ? { component: args.trim() } : {}),
      });
    },
  });

  client.addSlashCommand({
    name: "genui-gallery",
    description: "Open the Gen-UI Gallery (86 components, 170+ examples)",
    argumentHint: "",
    context: "workspace",
    onSubmit({ openScreen }) {
      openScreen({ screenId: "gallery" });
    },
  });

  client.addCommandCenterItem({
    id: "open-gallery",
    title: "Gen-UI: Open Component Gallery",
    icon: "LayoutGrid",
    keywords: ["genui", "gallery", "charts", "diagrams", "ui"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "gallery" });
    },
  });

  client.addCommandCenterItem({
    id: "open-workspace-gallery",
    title: "Gen-UI: Open Gallery Panel in Workspace",
    icon: "LayoutGrid",
    keywords: ["genui", "panel", "playground"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("gallery");
    },
  });

  client.addCommandCenterItem({
    id: "insert-demo",
    title: "Gen-UI: Insert Interactive Demo Block",
    icon: "Sparkles",
    keywords: ["genui", "demo", "ui"],
    context: "agent",
    async onSelect({ rpc, agent }) {
      await rpc(appendDemoRpc, { agentId: agent.id });
    },
  });

  client.addCommandCenterItem({
    id: "open-settings",
    title: "Gen-UI: Open Settings",
    icon: "Settings",
    keywords: ["genui", "settings", "web lookups"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("preferences");
    },
  });

  return () => {
    removeQueuePills();
  };
}
