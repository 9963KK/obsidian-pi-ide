# Obsidian Pi IDE

Connect Obsidian to [Pi Coding Agent](https://pi.dev) through the `pi-ide` protocol.

This plugin lets Pi see Obsidian's current file, cursor, and selected text via `/ide`. It can also route Pi `write` / `edit` tool calls through an Obsidian confirmation dialog before Pi applies the change.

## Features

- Exposes Obsidian as an IDE target for Pi's `/ide` command
- Sends current file, cursor, and selection to Pi as ambient editor context
- Updates Pi when selection/cursor/file changes
- Handles `openDiff` from Pi-side `@ldelossa/pi-ide`
- Optional auto-accept mode for trusted local workflows
- Startup check for the Pi-side package `npm:@ldelossa/pi-ide`
- One-click install for the Pi-side package from Obsidian

## Requirements

- Obsidian desktop
- Pi Coding Agent installed and available as `pi` in PATH
- Pi-side package:

```bash
pi install npm:@ldelossa/pi-ide
```

The plugin checks this on startup. If missing, it shows an install dialog and can run the command for you.

## Installation for local development

Clone/copy this repository, then build:

```bash
npm install
npm run build
```

Copy these files into your vault:

```text
<vault>/.obsidian/plugins/pi-ide/
  main.js
  manifest.json
  styles.css
```

Enable **Pi IDE** in Obsidian Community Plugins.

Then in Pi:

```text
/reload
/ide
```

Select `Obsidian`.

## BRAT installation

This plugin is structured for BRAT. Add the GitHub repository URL in BRAT, then enable **Pi IDE**.

## Settings

- **Pi-side package check on startup**: detects `npm:@ldelossa/pi-ide` and prompts to install if absent.
- **Auto-accept Pi edits**: skip the preview dialog and let Pi apply edits directly. Disabled by default for safety.
- **Startup notice**: show the local bridge port when Obsidian starts.
- **Lock directory**: where `<port>.lock` files are written. Defaults to `~/.pi/ide`.

## How it works

1. Obsidian starts a local WebSocket server on `127.0.0.1:<port>`.
2. The plugin writes a lockfile to `~/.pi/ide/<port>.lock` with workspace folders and an auth token.
3. Pi-side `@ldelossa/pi-ide` discovers the lockfile and connects with `/ide`.
4. Obsidian pushes `selection_changed` notifications.
5. Pi injects current editor context into agent turns.
6. When Pi edits a vault file, the plugin handles `openDiff` and either confirms or rejects the proposed final contents.


## Disclosures for Obsidian Community review

- **Network use:** The plugin starts a local-only WebSocket server on `127.0.0.1` so Pi can connect to Obsidian. It does not connect to any remote service by itself. If the user chooses **Install now**, the plugin runs `pi install npm:@ldelossa/pi-ide`, and Pi/npm may access the network to install that package.
- **Files outside the vault:** The plugin writes a lockfile to `~/.pi/ide/<port>.lock` so Pi can discover the running Obsidian bridge. It also checks `~/.pi/agent/npm/node_modules/@ldelossa/pi-ide/package.json` and may run `pi list` to detect whether the Pi-side package is installed.
- **Shell command execution:** The plugin can run `pi list` for detection and, only after explicit user action, `pi install npm:@ldelossa/pi-ide` to install the Pi-side package.
- **Telemetry:** The plugin does not collect telemetry.
- **Data scope:** The plugin sends the active Markdown file path, cursor, and selected text only to a locally connected Pi process authenticated by the generated lockfile token.

## Security notes

- This plugin is desktop-only because it uses Node APIs and a local WebSocket server.
- The WebSocket server only listens on `127.0.0.1`.
- Connections must provide the generated auth token from the lockfile.
- Edits outside the current vault are rejected.
- Auto-accept edits is disabled by default.

## Release checklist

For a GitHub release / BRAT build, attach:

- `main.js`
- `manifest.json`
- `styles.css`

For Obsidian Community Plugins, also maintain `versions.json` and submit the repository to `obsidianmd/obsidian-releases` after testing.
