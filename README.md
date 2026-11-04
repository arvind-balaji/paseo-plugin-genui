# Generative UI for Paseo

**Agents answer with charts, diagrams, maps, plans, and forms rendered inline in the Paseo chat timeline.**

![A Kyoto route on a Map with metrics and reply buttons in Paseo chat](assets/screenshot-map.png)

![A Plan with a comment, a queued choice and the reply pill in Paseo chat](assets/screenshot-chat.png)

![Gen-UI Gallery with 88 components and 176 live examples](assets/screenshot-gallery.png)

![Interactive Playground in Paseo](assets/screenshot-playground.png)

Ported from [ComicBit/bb-plugin-genui](https://github.com/ComicBit/bb-plugin-genui) (Apache-2.0) to Paseo's native timeline transformer, React Native surface, and daemon RPC architecture.

## Install

```bash
paseo plugin add git:anh-chu/paseo-plugin-genui
```

Or from npm:

```bash
paseo plugin add npm:paseo-plugin-genui
```

Requires Paseo 0.14.0 or later.

## What an answer looks like

The agent writes a UI spec as a ```ui block in its reply, after a plain answer sentence. If a block fails, the plugin asks the agent once to fix it. Agents can also pass a spec and a one-sentence answer to the optional `render_ui` tool, which checks the spec first and adds the card only when it renders; the plugin shows the answer as text above the card. Agents used UI far more often with blocks than with the tool, so blocks are the default.

A spec looks like this:

~~~
```ui
$seats = 12
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Go with " + $plan, Send("Go with " + $plan), variant: "primary")
])
```
~~~

Paseo renders a card with a plan switch, a seat slider, and a live total. Moving the slider recomputes the total in place without another model call. Clicking the button sends your choice back to the agent.

## Replies you build

Cards can collect a reply before anything is sent. A button with `Queue(text)` adds its text to your reply instead of sending it. `comments: true` adds a Comment action to each item of a Plan, Steps, List, Table, Findings, Decision or OptionCards, and `editable: true` lets you rewrite an item's text. `Other()` opens a box for anything the agent did not offer. A pill in the composer shows what is queued; the next Send, or Send now in the pill, sends it all as one message.

## Widgets you keep

Save a spec to a `<name>.ui` file and it opens as its own tab: a dashboard, tracker or status board you check on, instead of a card that scrolls away in a chat. The tab re-renders when the file changes. `Load`, `Image` and `Snippet` read relative to the widget's folder, `/tmp`, or the extra folders in settings. `Send()` buttons go to the most recently active agent in the workspace.

A widget can refresh itself with a first line:

```
@refresh 5m                     reload its data every 5 minutes while open
@refresh 1h run ./update.sh     run ./update.sh first, then reload
```

The script must be an executable file in the widget's folder (with a `#!` line). It runs on the Paseo host as the daemon's user, in the widget's folder, with a 2-minute limit, at most once per interval however many tabs are open, and only for widgets in the folders listed under **Settings -> Plugins -> Generative UI -> Widget folders**. Refresh runs while a widget is open; opening one that is overdue refreshes it at once. The **Refresh** button runs it immediately. A failed run shows its error and last output above the widget, which keeps the last good data.

## Components (88 across 10 groups)

| Group | Components |
| --- | --- |
| **Layout** | `Card` · `Row` · `Stack` · `Grid` · `Tabs` · `Details` · `Divider` · `Carousel` |
| **Content** | `Text` · `Callout` · `Draft` · `Metric` · `Badge` · `Icon` · `KeyValue` · `Image` · `File` · `Entity` · `Sources` · `List` |
| **Data** | `Table` · `Chart` (bar, line, area, pie, scatter, radar, funnel, heatmap) · `Sparkline` · `Progress` · `Gauge` · `SegmentedBar` · `Steps` · `Timeline` · `Calendar` · `CalendarHeatmap` · `Tree` · `Code` · `Snippet` · `Diff` · `Diagram` |
| **Media** | `ImageSearch` · `Gallery` · `Map` · `Hotspots` |
| **Inputs** | `Slider` · `Stepper` · `Toggle` · `Choice` · `Radio` · `Select` · `Checklist` · `ListEditor` · `Input` · `TextArea` · `DateInput` · `Rating` · `OptionCards` · `Swatches` · `EditableTable` · `Button` · `Form` · `FollowUps` · `Other` |
| **Widgets** | `Timer` · `Quiz` · `Flashcards` · `Walkthrough` |
| **Project** | `Changes` · `Commits` · `PullRequest` · `Threads` · `Tests` · `Json` |
| **Dev** | `Logs` · `StackTrace` · `Findings` · `Coverage` · `Dependencies` · `Pipeline` · `Benchmark` · `Waterfall` · `Treemap` |
| **Manage** | `Board` · `Roadmap` · `Status` · `Plan` · `Decision` · `Estimate` · `Environments` |
| **Evidence** | `Acceptance` · `Compare` · `Transcript` · `Provenance` |

## Slash commands & surfaces

- `/genui [prompt]` — Teach an existing agent the Generative UI component language.
- `/genui-demo [ComponentName]` — Insert a live interactive Gen-UI block into the current chat (e.g. `/genui-demo Decision` or `/genui-demo Map`).
- `/genui-gallery` — Open the **Gen-UI Gallery** screen (176 examples across all 88 components, plus a live spec Playground).

## Develop

```bash
npm install
npm run typecheck && npm test
paseo plugin install .
paseo plugin reload genui
```

## License

[Apache-2.0](LICENSE). Original DSL, component catalog, and gallery examples by [ComicBit](https://github.com/ComicBit/bb-plugin-genui). Excalifont is under the SIL Open Font License (`assets/fonts/Excalifont-OFL.txt`).
