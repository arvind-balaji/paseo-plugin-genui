import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Text, View } from "react-native";
import { genuiSettings } from "../shared/settings";

export function GenUiSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(genuiSettings);
  const [folders, setFolders] = React.useState<string | null>(null);
  const [widgetFolders, setWidgetFolders] = React.useState<string | null>(null);

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading settings…</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      </View>
    );
  }

  const { values, revision, save } = settings;

  return (
    <View style={{ gap: 16 }}>
      <SettingsSection title="Agent instructions">
        <SettingsCard>
          <SettingsSwitch
            label="Automatically teach new agents Generative UI"
            hint="Appends the 86-component ```ui and ```app reference to new agents' system prompt on creation."
            value={values.autoInstructions}
            onValueChange={(autoInstructions) => {
              void save({ ...values, autoInstructions }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Network and web lookups">
        <SettingsCard>
          <SettingsSwitch
            label="Web lookups"
            hint="Lets ImageSearch (Wikimedia Commons), Map (Photon geocoding and OpenStreetMap tiles), and https Image links fetch through the Paseo daemon with private-IP protection and caching."
            value={values.webLookups}
            onValueChange={(webLookups) => {
              void save({ ...values, webLookups }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Files">
        <SettingsCard>
          <SettingsInput
            label="Extra folders"
            hint="Comma-separated folders, besides the workspace, thread storage and /tmp, that Load, Snippet and Image can read."
            initialValue={values.extraFolders}
            placeholder="~/dev/scratch"
            onChangeText={setFolders}
          />
          <SettingsAction
            label="Apply folder changes"
            actionLabel="Save"
            disabled={folders === null || folders === values.extraFolders}
            onPress={() => {
              if (folders !== null) void save({ ...values, extraFolders: folders }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Widgets">
        <SettingsCard>
          <SettingsInput
            label="Widget folders"
            hint="Comma-separated folders whose widget files (*.ui) may run the script in their @refresh line. Scripts run on the Paseo host as the daemon's user, so list only folders you trust."
            initialValue={values.widgetFolders}
            placeholder="~/widgets"
            onChangeText={setWidgetFolders}
          />
          <SettingsAction
            label="Apply widget folder changes"
            actionLabel="Save"
            disabled={widgetFolders === null || widgetFolders === values.widgetFolders}
            onPress={() => {
              if (widgetFolders !== null) void save({ ...values, widgetFolders }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
