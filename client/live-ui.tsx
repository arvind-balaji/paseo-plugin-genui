import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, usePaseo, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, copyText, useRevealedText, useToast } from "@getpaseo/plugin/client/react-native";
import { Markdown } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  collectLoads,
  compileStreaming,
  dataKey,
  evaluate,
  initialState,
  type LoadedData,
  type Program,
} from "../shared/core";
import type { Action, Diagnostic, Value } from "../shared/core/types";
import type { GenUiBlockData, GenUiTextData } from "../shared/rpc";
import { useAudioLoader, useImageLoader, useLoadedData, useTextLoader, type FileScope } from "./loaders";
import { composeReply } from "../shared/logic/reply";
import { RenderNodes } from "./render";
import { clearQueue, queueOf, setQueued as setQueuedFor, useReplyQueue } from "./reply-queue";
import { UiRuntimeContext, type UiRuntime } from "./runtime";
import { canRenderWebIframe, mountSandboxedAppIframe, openWorkspaceFile, readStorage, writeStorage } from "./web";

function readStoredValues(storageKey: string): Record<string, Value> {
  const raw = readStorage(storageKey);
  if (raw === null) return {};
  try {
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved as Record<string, Value>));
  } catch {
    return {};
  }
}

export function LiveUi({
  program,
  compileDiagnostics,
  source,
  stateKey,
  data,
  send,
  openFile,
  loadImage,
  readText,
  loadAudio,
  playAudio,
  superseded = false,
  agentId,
  blockKey,
  theme,
  compact,
  platform,
  footerLabel,
}: {
  program: Program;
  compileDiagnostics: readonly Diagnostic[];
  source: string;
  stateKey: string;
  data?: ReadonlyMap<string, LoadedData>;
  send(text: string): Promise<void>;
  openFile: UiRuntime["openFile"];
  loadImage: UiRuntime["loadImage"];
  readText: UiRuntime["readText"];
  loadAudio: UiRuntime["loadAudio"];
  playAudio: UiRuntime["playAudio"];
  superseded?: boolean;
  agentId: string | null;
  blockKey: string | null;
  theme: PluginTheme;
  compact: boolean;
  platform: "ios" | "android" | "web";
  footerLabel?: string;
}) {
  const toast = useToast();
  const initial = useMemo(() => initialState(program, data), [program, data]);
  const [changed, setChanged] = useState(() => readStoredValues(stateKey));
  const state = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(initial).map(([name, value]) => [
          name,
          Object.hasOwn(changed, name) ? changed[name]! : value,
        ]),
      ),
    [initial, changed],
  );

  useEffect(() => {
    if (Object.keys(changed).length === 0) return;
    writeStorage(stateKey, JSON.stringify(changed));
  }, [stateKey, changed]);

  const answerKey = `${stateKey}:answer`;
  const [answer, setAnswer] = useState<string | null>(() => readStorage(answerKey));

  const setValue = useCallback(
    (name: string, value: Value) => {
      if (Object.hasOwn(initial, name)) {
        setChanged((prev) => ({ ...prev, [name]: value }));
      }
    },
    [initial],
  );

  // The gallery has no agent; its UIs share one local queue.
  const queueAgent = agentId ?? "local";
  const queue = useReplyQueue(queueAgent);
  const queuePrefix = blockKey ?? stateKey;
  const setQueued = useCallback(
    (id: string, text: string | null) => setQueuedFor(queueAgent, `${queuePrefix}:${id}`, text),
    [queueAgent, queuePrefix],
  );

  const runAction = useCallback(
    async (action: Action) => {
      switch (action.type) {
        case "set":
          setValue(action.name, action.value);
          return;
        case "queue": {
          const id = `queue:${action.text}`;
          const queued = queueOf(queueAgent).some((item) => item.id === `${queuePrefix}:${id}`);
          setQueued(id, queued ? null : action.text);
          return;
        }
        case "send":
          await send(composeReply(queueOf(queueAgent).map((item) => item.text), action.text));
          clearQueue(queueAgent);
          setAnswer(action.text);
          writeStorage(answerKey, action.text);
          return;
        case "openUrl":
          await openExternalUrl(action.url);
          return;
        case "copy":
          await copyText(action.text);
          toast.show("Copied", { variant: "success" });
          return;
      }
    },
    [answerKey, queueAgent, queuePrefix, send, setQueued, setValue, toast],
  );

  const runtime = useMemo<UiRuntime>(
    () => ({
      setValue,
      openFile,
      loadImage,
      readText,
      loadAudio,
      playAudio,
      answer,
      queue,
      setQueued,
      queued: (id) => queue.find((item) => item.id === `${queuePrefix}:${id}`)?.text ?? null,
      superseded,
      agentId,
      blockKey,
      theme,
      compact,
      platform,
      async run(actions) {
        try {
          for (const action of actions) await runAction(action);
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
    [
      setValue,
      openFile,
      loadImage,
      readText,
      loadAudio,
      playAudio,
      answer,
      queue,
      queuePrefix,
      setQueued,
      superseded,
      agentId,
      blockKey,
      theme,
      compact,
      platform,
      runAction,
      toast,
    ],
  );

  const { roots, diagnostics } = useMemo(
    () => evaluate(program, state, data),
    [program, state, data],
  );
  const allDiagnostics = useMemo(
    () => [...compileDiagnostics, ...diagnostics],
    [compileDiagnostics, diagnostics],
  );
  const files = useMemo(() => collectLoads(program), [program]);

  return (
    <UiRuntimeContext.Provider value={runtime}>
      <View style={{ gap: 6, marginVertical: 4 }}>
        <View style={{ gap: compact ? 8 : 10 }}>
          <RenderNodes nodes={roots} isolate />
        </View>
        <SourceFooter
          source={source}
          diagnostics={allDiagnostics}
          fileCount={files.length}
          theme={theme}
          label={footerLabel}
        />
      </View>
    </UiRuntimeContext.Provider>
  );
}

function SourceFooter({
  source,
  diagnostics,
  fileCount,
  theme,
  label,
}: {
  source: string;
  diagnostics: readonly Diagnostic[];
  fileCount: number;
  theme: PluginTheme;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {label ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
            {label}
          </Text>
        ) : (
          <View />
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {diagnostics.length > 0 ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
              {diagnostics.length} warning{diagnostics.length === 1 ? "" : "s"}
            </Text>
          ) : null}
          <Pressable
            onPress={() => setOpen((o) => !o)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Icon name="Code" size={11} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {open ? "Hide source" : "Source"}
              {fileCount > 0 ? ` (${fileCount} file${fileCount === 1 ? "" : "s"})` : ""}
            </Text>
          </Pressable>
        </View>
      </View>
      {open ? (
        <View
          style={{
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            padding: 10,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Spec source</Text>
            <Pressable
              onPress={() => {
                void copyText(source).then(
                  () => toast.show("Source copied", { variant: "success" }),
                  () => toast.error("Could not copy"),
                );
              }}
            >
              <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <Text
            selectable
            style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11.5 }}
          >
            {source}
          </Text>
          {diagnostics.length > 0 ? (
            <View style={{ gap: 2 }}>
              {diagnostics.map((d, i) => (
                <Text
                  key={i}
                  style={{
                    color:
                      d.severity === "error"
                        ? theme.colors.statusDanger
                        : theme.colors.statusWarning,
                    fontFamily: "monospace",
                    fontSize: 11,
                  }}
                >
                  {d.line}:{d.column} {d.severity}: {d.message}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function AppBlockView({
  html,
  complete,
  theme,
}: {
  html: string;
  complete: boolean;
  theme: PluginTheme;
}) {
  const containerRef = useRef<View | null>(null);
  const [height, setHeight] = useState(180);
  const [error, setError] = useState<string | null>(null);
  const webSupported = canRenderWebIframe();

  useEffect(() => {
    if (!complete || !webSupported || !containerRef.current) return;
    setError(null);
    return mountSandboxedAppIframe(containerRef.current, {
      html,
      theme,
      height,
      onHeight: setHeight,
      onError: setError,
    });
  }, [complete, html, theme, webSupported]);

  if (!complete) {
    return (
      <View
        style={{
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          padding: 16,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Building app…</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 6, marginVertical: 4 }}>
      <View
        style={{
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          padding: 12,
          gap: 6,
        }}
      >
        {webSupported ? (
          <View ref={containerRef} style={{ width: "100%", minHeight: height }} />
        ) : (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Interactive HTML app (open on desktop or web to run):
            </Text>
            <Text
              selectable
              style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11.5 }}
            >
              {html}
            </Text>
          </View>
        )}
        {error ? (
          <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5 }}>{error}</Text>
        ) : null}
      </View>
      <SourceFooter source={html} diagnostics={[]} fileCount={0} theme={theme} />
    </View>
  );
}

export function SpecBlockView({
  code,
  complete,
  stateKey,
  scope,
  send,
  openFile,
  playAudio,
  theme,
  compact,
  platform,
  footerLabel,
}: {
  code: string;
  complete: boolean;
  stateKey: string;
  scope: FileScope;
  send(text: string): Promise<void>;
  openFile: UiRuntime["openFile"];
  playAudio: UiRuntime["playAudio"];
  theme: PluginTheme;
  compact: boolean;
  platform: "ios" | "android" | "web";
  footerLabel?: string;
}) {
  const result = useMemo(() => compileStreaming(code), [code]);
  const lastGood = useRef(result.program === null ? null : result);
  if (result.program !== null) lastGood.current = result;
  const shown = lastGood.current;

  const data = useLoadedData(scope, shown?.program ?? null);
  const loadImage = useImageLoader(scope);
  const readText = useTextLoader(scope);
  const loadAudio = useAudioLoader(scope);

  if (!shown?.program) {
    if (!complete) {
      return (
        <View
          style={{
            borderRadius: 12,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            padding: 16,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Building UI…</Text>
        </View>
      );
    }
    return (
      <View
        style={{
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.statusDanger,
          backgroundColor: theme.colors.surface1,
          padding: 12,
          gap: 6,
        }}
      >
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12.5, fontWeight: "600" }}>
          This UI couldn&apos;t be rendered
        </Text>
        {result.diagnostics.map((d, idx) => (
          <Text
            key={idx}
            style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11.5 }}
          >
            {d.line}:{d.column} {d.severity}: {d.message}
          </Text>
        ))}
        <SourceFooter source={code} diagnostics={result.diagnostics} fileCount={0} theme={theme} />
      </View>
    );
  }

  const agentId = scope !== "gallery" && "agentId" in scope ? scope.agentId : null;
  return (
    <LiveUi
      program={shown.program}
      compileDiagnostics={result.complete ? result.diagnostics : []}
      source={code}
      stateKey={stateKey}
      data={data}
      send={send}
      openFile={openFile}
      loadImage={loadImage}
      readText={readText}
      loadAudio={loadAudio}
      playAudio={playAudio}
      agentId={agentId}
      blockKey={scope !== "gallery" && "agentId" in scope ? stateKey : null}
      theme={theme}
      compact={compact}
      platform={platform}
      footerLabel={footerLabel}
    />
  );
}

export function TimelineBlockItem({
  agentId,
  item,
  timestamp,
  theme,
  layout,
  playAudio,
}: PluginTimelineItemProps<GenUiBlockData> & {
  playAudio: UiRuntime["playAudio"];
}) {
  const paseo = usePaseo();
  const { language, code, complete, fenceIndex, messageId } = item.data;
  const stateKey = `paseo.genui:${agentId}:${messageId ?? timestamp.getTime()}:${fenceIndex}`;

  const send = useCallback(
    async (text: string) => {
      await paseo.agents.ref(agentId).send(text);
    },
    [paseo, agentId],
  );

  if (language === "app") {
    return <AppBlockView html={code} complete={complete} theme={theme} />;
  }

  return (
    <SpecBlockView
      code={code}
      complete={complete}
      stateKey={stateKey}
      scope={{ agentId }}
      send={send}
      openFile={layout.platform === "web" ? openWorkspaceFile : null}
      playAudio={playAudio}
      theme={theme}
      compact={layout.compact}
      platform={layout.platform}
    />
  );
}

export function TimelineTextItem({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<GenUiTextData>) {
  const revealed = useRevealedText(item.data.text, item.data.phase ?? "complete");
  // Paseo's own renderer and testID give this text the host's links, selection and copy, and plugin styles such as Chat Polish.
  return (
    <View testID="assistant-message">
      <Markdown>{revealed}</Markdown>
    </View>
  );
}
