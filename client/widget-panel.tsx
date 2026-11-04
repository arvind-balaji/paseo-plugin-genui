import { type PluginFilePanelProps, useFileText, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { widgetRefreshRpc, type WidgetRunState } from "../shared/rpc";
import { formatAge, parseWidget } from "../shared/widget";
import { SpecBlockView } from "./live-ui";
import type { UiRuntime } from "./runtime";
import { openWorkspaceFile } from "./web";

/** A widget file (`*.ui`): a ui spec kept on disk, shown as its own tab and refreshed by its `@refresh`. */
export function WidgetPanel({
  file,
  theme,
  layout,
  workspaceId,
  playAudio,
}: PluginFilePanelProps & { playAudio: UiRuntime["playAudio"] }) {
  const paseo = usePaseo();
  const runRefresh = useRpc(widgetRefreshRpc);
  const text = useFileText(file);
  const source = text.status === "ready" ? text.text : null;
  const parsed = useMemo(() => (source === null ? null : parseWidget(source)), [source]);
  const refresh = parsed?.refresh ?? null;
  const hasScript = refresh?.run != null;

  const [generation, setGeneration] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [run, setRun] = useState<WidgetRunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const inFlight = useRef(false);

  const reload = useCallback(
    async (force: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        if (hasScript) {
          try {
            setRun(await runRefresh({ widget: file.path, force }));
          } catch (cause) {
            const error = cause instanceof Error ? cause.message : String(cause);
            setRun({ ran: false, ok: false, at: null, error });
          }
        }
        setGeneration((value) => value + 1);
        setLoadedAt(Date.now());
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [file.path, hasScript, runRefresh],
  );

  // Refresh on open (the daemon skips a script that ran recently) and then every interval.
  const everyMs = refresh?.everyMs ?? null;
  useEffect(() => {
    if (everyMs === null) return;
    void reload(false);
    const timer = setInterval(() => void reload(false), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, reload]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Send() goes to the most recently active agent in this workspace.
  const send = useCallback(
    async (message: string) => {
      const { entries } = await paseo.agents.list({
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: 100 },
      });
      const target = entries.find(
        ({ agent }) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.internal,
      );
      if (target === undefined) throw new Error("Open an agent in this workspace to send this");
      await paseo.agents.ref(target.agent.id).send(message);
    },
    [paseo, workspaceId],
  );

  const scope = useMemo(() => ({ widget: file.path, generation }), [file.path, generation]);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const updatedAt = run?.at ? Date.parse(run.at) : loadedAt;

  if (text.status === "loading" || parsed === null) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.surface0 }]}>
        <Loading />
      </View>
    );
  }
  if (text.status === "error") {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.surface0 }]}>
        <Text style={{ color: theme.colors.statusDanger }}>{text.error.message}</Text>
      </View>
    );
  }

  const status = [
    hasScript && run?.at == null && !busy ? "Not run yet" : `Updated ${formatAge(Date.now() - updatedAt)}`,
    refresh ? `every ${refresh.every}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 10 }}
    >
      <View style={styles.bar}>
        <Text style={[muted, { flex: 1 }]} numberOfLines={1}>
          {status}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasScript ? "Run the refresh script and reload" : "Reload the widget's data"}
          disabled={busy}
          onPress={() => void reload(true)}
          style={({ pressed }) => [
            styles.button,
            { borderColor: theme.colors.border, opacity: busy ? 0.5 : pressed ? 0.7 : 1 },
          ]}
        >
          <Icon name="RefreshCw" size={13} color={theme.colors.foregroundMuted} />
          <Text style={muted}>{busy ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>

      {parsed.errors.length > 0 || (run !== null && !run.ok) ? (
        <View
          style={[styles.notice, { borderColor: theme.colors.statusDanger, backgroundColor: theme.colors.surface1 }]}
        >
          {parsed.errors.map((error) => (
            <Text key={error.line} style={{ color: theme.colors.statusDanger, fontSize: 12.5 }}>
              Line {error.line}: {error.message}
            </Text>
          ))}
          {run !== null && !run.ok ? (
            <>
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12.5 }}>
                Refresh failed: {run.error ?? "unknown error"}
              </Text>
              {run.output ? (
                <Text style={[muted, { fontFamily: "monospace", fontSize: 11 }]} numberOfLines={8}>
                  {run.output}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      <SpecBlockView
        code={parsed.code}
        complete={true}
        stateKey={`paseo.genui.widget:${file.path}`}
        scope={scope}
        send={send}
        openFile={layout.platform === "web" ? openWorkspaceFile : null}
        playAudio={playAudio}
        theme={theme}
        compact={layout.compact}
        platform={layout.platform}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  bar: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
  },
  notice: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
});
