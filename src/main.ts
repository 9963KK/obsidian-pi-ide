import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { exec } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const AUTH_HEADER = "x-pi-ide-authorization";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { TEXT: 1, CLOSE: 8, PING: 9, PONG: 10 } as const;
const DEFAULT_LOCK_DIR = path.join(os.homedir(), ".pi", "ide");
const PI_IDE_PACKAGE = "npm:@ldelossa/pi-ide";

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
type WebSocketClient = { socket: any; buffer: Buffer; alive: boolean };
type SelectionState = {
  text: string;
  filePath: string;
  fileUrl: string;
  cursor: { line: number; character: number };
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
};

type PiIdeSettings = {
  lockDir: string;
  autoAcceptChanges: boolean;
  checkPiIdeOnStartup: boolean;
  showStartupNotice: boolean;
};

const DEFAULT_SETTINGS: PiIdeSettings = {
  lockDir: DEFAULT_LOCK_DIR,
  autoAcceptChanges: false,
  checkPiIdeOnStartup: true,
  showStartupNotice: true,
};

function getAcceptValue(secWebSocketKey: string): string {
  return crypto.createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

function toFileUrl(filePath: string): string {
  return `file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function parseFrame(buffer: Buffer): null | { fin: boolean; opcode: number; payload: Buffer; totalLength: number } {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    const maskOffset = offset;
    const payloadOffset = maskOffset + 4;
    if (buffer.length < payloadOffset + length) return null;
    const mask = buffer.subarray(maskOffset, payloadOffset);
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) payload[i] = buffer[payloadOffset + i] ^ mask[i % 4];
    return { fin, opcode, payload, totalLength: payloadOffset + length };
  }

  if (buffer.length < offset + length) return null;
  return { fin, opcode, payload: buffer.subarray(offset, offset + length), totalLength: offset + length };
}

function makeFrame(opcode: number, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data) : data;
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

class JsonRpcWebSocketServer {
  private server: http.Server | null = null;
  private clients = new Set<WebSocketClient>();
  private pingTimer: number | null = null;

  constructor(
    private readonly authToken: string,
    private readonly onRequest: (message: JsonRpcMessage) => Promise<any>,
    private readonly onConnect?: () => void,
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((_req, res) => {
        res.writeHead(400);
        res.end("WebSocket endpoint only");
      });
      this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (typeof address === "object" && address) {
          this.pingTimer = activeWindow.setInterval(() => this.pingClients(), 30_000);
          resolve(address.port);
        } else {
          reject(new Error("Could not bind WebSocket server"));
        }
      });
    });
  }

  stop(): void {
    if (this.pingTimer !== null) {
      activeWindow.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  broadcast(method: string, params: any): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = makeFrame(OPCODE.TEXT, payload);
    for (const client of this.clients) {
      if (client.socket.writable) client.socket.write(frame);
    }
  }

  private handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): void {
    if (req.headers[AUTH_HEADER] !== this.authToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const protocol = req.headers["sec-websocket-protocol"];
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${getAcceptValue(key)}`,
      typeof protocol === "string" ? `Sec-WebSocket-Protocol: ${protocol}` : null,
      "",
      "",
    ].filter((line): line is string => line !== null);
    socket.write(lines.join("\r\n"));
    if (head?.length) socket.unshift(head);

    const client: WebSocketClient = { socket, buffer: Buffer.alloc(0), alive: true };
    this.clients.add(client);
    socket.on("data", (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.consumeFrames(client);
    });
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
    this.onConnect?.();
  }

  private consumeFrames(client: WebSocketClient): void {
    while (client.socket.writable) {
      const frame = parseFrame(client.buffer);
      if (!frame) break;
      client.buffer = client.buffer.subarray(frame.totalLength);
      if (frame.opcode === OPCODE.PING) client.socket.write(makeFrame(OPCODE.PONG, frame.payload));
      else if (frame.opcode === OPCODE.PONG) client.alive = true;
      else if (frame.opcode === OPCODE.CLOSE) {
        client.socket.write(makeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
        client.socket.destroy();
        this.clients.delete(client);
      } else if (frame.opcode === OPCODE.TEXT && frame.fin) {
        void this.handleText(client, frame.payload.toString());
      }
    }
  }

  private async handleText(client: WebSocketClient, text: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text);
    } catch {
      client.socket.write(makeFrame(OPCODE.TEXT, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })));
      return;
    }
    if (message.id === undefined || message.id === null) return;
    try {
      const response = await this.onRequest(message);
      if (client.socket.writable) client.socket.write(makeFrame(OPCODE.TEXT, JSON.stringify(response)));
    } catch (err: any) {
      const response = { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: err?.message || String(err) } };
      if (client.socket.writable) client.socket.write(makeFrame(OPCODE.TEXT, JSON.stringify(response)));
    }
  }

  private pingClients(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.destroy();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      if (client.socket.writable) client.socket.write(makeFrame(OPCODE.PING, Buffer.alloc(0)));
    }
  }
}

class DiffConfirmModal extends Modal {
  private textarea!: HTMLTextAreaElement;
  private result: { accepted: boolean; contents: string } | null = null;
  private resolveDecision?: (result: { accepted: boolean; contents: string }) => void;

  constructor(
    app: App,
    private readonly oldFilePath: string,
    private readonly newFilePath: string,
    private readonly newFileContents: string,
    private readonly tabName: string,
  ) {
    super(app);
    this.setTitle("Pi IDE change preview");
  }

  waitForDecision(): Promise<{ accepted: boolean; contents: string }> {
    return new Promise((resolve) => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-ide-modal");
    contentEl.createEl("p", { text: "Pi wants to change this Obsidian vault file. Review/edit the proposed final contents, then accept or reject." });
    const meta = contentEl.createEl("div", { cls: "pi-ide-meta" });
    meta.createEl("div", { text: `File: ${this.newFilePath}` });
    if (this.oldFilePath !== this.newFilePath) meta.createEl("div", { text: `Original: ${this.oldFilePath}` });
    meta.createEl("div", { text: `Change: ${this.tabName}` });

    this.textarea = contentEl.createEl("textarea", { cls: "pi-ide-textarea" });
    this.textarea.value = this.newFileContents;
    this.textarea.spellcheck = false;

    const buttons = contentEl.createEl("div", { cls: "pi-ide-buttons" });
    const accept = buttons.createEl("button", { text: "Accept" });
    accept.addClass("mod-cta");
    const reject = buttons.createEl("button", { text: "Reject" });
    accept.addEventListener("click", () => {
      this.result = { accepted: true, contents: this.textarea.value };
      this.close();
    });
    reject.addEventListener("click", () => {
      this.result = { accepted: false, contents: "" };
      this.close();
    });
  }

  onClose(): void {
    const result = this.result || { accepted: false, contents: "" };
    this.contentEl.empty();
    this.resolveDecision?.(result);
  }
}

class PiIdeInstallModal extends Modal {
  private outputEl!: HTMLElement;

  constructor(app: App, private readonly plugin: PiIdePlugin) {
    super(app);
    this.setTitle("Install Pi IDE support");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-ide-install-modal");
    contentEl.createEl("p", { text: "This Obsidian plugin needs the Pi-side package @ldelossa/pi-ide so Pi can detect and connect to Obsidian with /ide." });
    contentEl.createEl("code", { text: `pi install ${PI_IDE_PACKAGE}` });
    this.outputEl = contentEl.createEl("pre", { cls: "pi-ide-command-output" });
    this.outputEl.hide();
    const buttons = contentEl.createEl("div", { cls: "pi-ide-buttons" });
    const install = buttons.createEl("button", { text: "Install now" });
    install.addClass("mod-cta");
    const copy = buttons.createEl("button", { text: "Copy command" });
    const later = buttons.createEl("button", { text: "Later" });

    install.addEventListener("click", async () => {
      install.disabled = true;
      this.outputEl.show();
      this.outputEl.setText("Installing...");
      const result = await this.plugin.installPiIdePackage();
      this.outputEl.setText(result.output);
      install.disabled = false;
      if (result.ok) {
        new Notice("Pi IDE package installed. Restart or /reload Pi, then run /ide.");
      }
    });
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(`pi install ${PI_IDE_PACKAGE}`);
      new Notice("Install command copied");
    });
    later.addEventListener("click", () => this.close());
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function removeLockfile(lockDir: string, port: number): void {
  try { fs.unlinkSync(path.join(lockDir, `${port}.lock`)); } catch {}
}

function cleanupStaleLockfiles(lockDir: string): void {
  let entries: string[] = [];
  try { entries = fs.readdirSync(lockDir).filter((name) => name.endsWith(".lock")); } catch { return; }
  for (const entry of entries) {
    const file = path.join(lockDir, entry);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.ideName && data.ideName !== "Obsidian") continue;
      if (data.pid === process.pid) throw new Error("own stale lock");
      process.kill(data.pid, 0);
    } catch {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function getVaultBasePath(app: App): string {
  return (app.vault.adapter as any).getBasePath?.() || "";
}

function toAbsoluteVaultPath(app: App, vaultPath: string): string {
  return path.join(getVaultBasePath(app), vaultPath);
}

function toVaultRelativePath(app: App, maybeAbsolutePath: string): string | null {
  const base = path.resolve(getVaultBasePath(app));
  const file = path.resolve(maybeAbsolutePath);
  const rel = path.relative(base, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function getCurrentSelection(app: App): SelectionState | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file || !view.editor) return null;
  const editor = view.editor;
  const cursor = editor.getCursor();
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const text = editor.getSelection() || "";
  const filePath = toAbsoluteVaultPath(app, view.file.path);
  return {
    text,
    filePath,
    fileUrl: toFileUrl(filePath),
    cursor: { line: cursor.line, character: cursor.ch },
    selection: {
      start: { line: from.line, character: from.ch },
      end: { line: to.line, character: to.ch },
      isEmpty: text === "",
    },
  };
}

function toolResultText(text: string): any {
  return { content: [{ type: "text", text }] };
}

function toolResultJson(value: any): any {
  return toolResultText(JSON.stringify(value));
}

const tools = [
  {
    name: "openDiff",
    description: "Open an interactive confirmation for proposed file contents.",
    inputSchema: {
      type: "object",
      properties: {
        old_file_path: { type: "string" },
        new_file_path: { type: "string" },
        new_file_contents: { type: "string" },
        tab_name: { type: "string" },
      },
      required: ["old_file_path", "new_file_path", "new_file_contents", "tab_name"],
    },
  },
  { name: "close_tab", description: "Close a previously opened diff tab. No-op in Obsidian.", inputSchema: { type: "object", properties: { tab_name: { type: "string" } } } },
  { name: "getDiagnostics", description: "Return diagnostics by file URI. Obsidian currently returns none.", inputSchema: { type: "object", properties: {} } },
];

export default class PiIdePlugin extends Plugin {
  declare settings: PiIdeSettings;
  private server: JsonRpcWebSocketServer | null = null;
  private port = 0;
  private authToken = "";
  private lockfilePath: string | null = null;
  private latestSelection: SelectionState | null = null;
  private prevStateKey: string | null = null;
  private broadcastTimer: number | null = null;
  private broadcastTimerWindow: Window | null = null;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new PiIdeSettingTab(this.app, this));
    await this.startBridge();

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleBroadcast(true)));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleBroadcast(true)));
    this.registerDomEvent(activeWindow, "focus", () => this.scheduleBroadcast(true));
    this.registerEditorExtension(EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged || update.focusChanged) this.scheduleBroadcast(false);
    }));

    this.addCommand({ id: "broadcast-selection", name: "Broadcast current selection to Pi", callback: () => this.broadcastSelection(true) });
    this.addCommand({ id: "install-pi-side-package", name: "Install Pi-side package", callback: () => new PiIdeInstallModal(this.app, this).open() });
    this.addCommand({ id: "copy-lockfile-path", name: "Copy lockfile path", callback: async () => {
      await navigator.clipboard.writeText(this.lockfilePath || "");
      new Notice("Pi IDE lockfile path copied");
    }});

    this.statusEl = this.addStatusBarItem();
    this.updateStatus();
    this.scheduleBroadcast(true);

    if (this.settings.checkPiIdeOnStartup) {
      void this.checkPiIdePackageOnStartup();
    }
    if (this.settings.showStartupNotice) {
      new Notice(`Pi IDE listening on 127.0.0.1:${this.port}`);
    }
  }

  onunload(): void {
    if (this.broadcastTimer !== null) {
      this.broadcastTimerWindow?.clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.server?.stop();
    if (this.port) removeLockfile(this.settings.lockDir, this.port);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async restartBridge(): Promise<void> {
    this.server?.stop();
    if (this.port) removeLockfile(this.settings.lockDir, this.port);
    this.port = 0;
    await this.startBridge();
    this.updateStatus();
    this.scheduleBroadcast(true);
  }

  async startBridge(): Promise<void> {
    ensureDir(this.settings.lockDir);
    cleanupStaleLockfiles(this.settings.lockDir);
    this.authToken = crypto.randomUUID();
    this.server = new JsonRpcWebSocketServer(this.authToken, (message) => this.handleRequest(message), () => this.scheduleBroadcast(true));
    this.port = await this.server.start();
    this.lockfilePath = this.writeLockfile();
    console.log(`[obsidian-pi-ide] listening on 127.0.0.1:${this.port}; lockfile ${this.lockfilePath}`);
  }

  writeLockfile(): string {
    const file = path.join(this.settings.lockDir, `${this.port}.lock`);
    const tmp = `${file}.tmp`;
    const body = JSON.stringify({
      pid: process.pid,
      workspaceFolders: [getVaultBasePath(this.app)],
      ideName: "Obsidian",
      transport: "ws",
      authToken: this.authToken,
    });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }

  updateStatus(): void {
    this.statusEl?.setText(`π IDE ${this.port}`);
  }

  scheduleBroadcast(force: boolean): void {
    if (this.broadcastTimer !== null) this.broadcastTimerWindow?.clearTimeout(this.broadcastTimer);
    const win = activeWindow;
    this.broadcastTimerWindow = win;
    this.broadcastTimer = win.setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastTimerWindow = null;
      this.broadcastSelection(force);
    }, 100);
  }

  broadcastSelection(force: boolean): void {
    const state = getCurrentSelection(this.app);
    if (!state) return;
    this.latestSelection = state;
    const stateKey = JSON.stringify({ filePath: state.filePath, cursor: state.cursor, selection: state.selection, text: state.text });
    if (!force && stateKey === this.prevStateKey) return;
    this.prevStateKey = stateKey;
    this.server?.broadcast("selection_changed", {
      text: state.text,
      filePath: state.filePath,
      fileUrl: state.fileUrl,
      selection: state.selection,
    });
  }

  async handleRequest(message: JsonRpcMessage): Promise<any> {
    switch (message.method) {
      case "initialize":
        return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "obsidian-pi-ide", version: this.manifest.version } } };
      case "notifications/initialized":
        this.scheduleBroadcast(true);
        return { jsonrpc: "2.0", id: message.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: message.id, result: { tools } };
      case "tools/call": {
        const result = await this.callTool(message.params?.name, message.params?.arguments || {});
        return { jsonrpc: "2.0", id: message.id, result };
      }
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  async callTool(name: string, args: any): Promise<any> {
    switch (name) {
      case "openDiff": return this.openDiff(args);
      case "close_tab": return toolResultText("TAB_CLOSED");
      case "getDiagnostics": return toolResultJson({});
      default: throw new Error(`Tool not found: ${name}`);
    }
  }

  async openDiff(args: any): Promise<any> {
    const newFilePath = String(args.new_file_path || "");
    const oldFilePath = String(args.old_file_path || newFilePath);
    const newFileContents = String(args.new_file_contents ?? "");
    const tabName = String(args.tab_name || "pi-change");
    const relative = toVaultRelativePath(this.app, newFilePath);
    if (!relative) {
      new Notice("Pi IDE rejected change outside this vault");
      return { content: [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: tabName }] };
    }

    if (this.settings.autoAcceptChanges) {
      new Notice(`Pi change accepted: ${relative}`);
      return { content: [{ type: "text", text: "FILE_SAVED" }, { type: "text", text: newFileContents }] };
    }

    const modal = new DiffConfirmModal(this.app, oldFilePath, newFilePath, newFileContents, tabName);
    const decision = await modal.waitForDecision();
    if (!decision.accepted) {
      new Notice("Pi change rejected");
      return { content: [{ type: "text", text: "DIFF_REJECTED" }, { type: "text", text: tabName }] };
    }
    new Notice(`Pi change accepted: ${relative}`);
    return { content: [{ type: "text", text: "FILE_SAVED" }, { type: "text", text: decision.contents }] };
  }

  async isPiIdePackageInstalled(): Promise<boolean> {
    const packagePath = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@ldelossa", "pi-ide", "package.json");
    if (fs.existsSync(packagePath)) return true;
    try {
      const { stdout } = await execAsync("pi list", { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return stdout.includes("npm:@ldelossa/pi-ide") || stdout.includes("@ldelossa/pi-ide");
    } catch {
      return false;
    }
  }

  async installPiIdePackage(): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync(`pi install ${PI_IDE_PACKAGE}`, { timeout: 120_000, maxBuffer: 1024 * 1024 * 4 });
      return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n") || "Installed." };
    } catch (err: any) {
      return { ok: false, output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n") };
    }
  }

  async checkPiIdePackageOnStartup(): Promise<void> {
    const installed = await this.isPiIdePackageInstalled();
    if (!installed) new PiIdeInstallModal(this.app, this).open();
  }
}

class PiIdeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PiIdePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Pi IDE" });

    new Setting(containerEl)
      .setName("Pi-side package")
      .setDesc("Check whether npm:@ldelossa/pi-ide is installed, or install it automatically for the user.")
      .addButton((button) => button.setButtonText("Check").onClick(async () => {
        const installed = await this.plugin.isPiIdePackageInstalled();
        new Notice(installed ? "Pi-side package is installed" : "Pi-side package is not installed");
      }))
      .addButton((button) => button.setButtonText("Install").setCta().onClick(() => new PiIdeInstallModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName("Check Pi-side package on startup")
      .setDesc("If @ldelossa/pi-ide is missing, show an install dialog when Obsidian starts.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.checkPiIdeOnStartup).onChange(async (value) => {
        this.plugin.settings.checkPiIdeOnStartup = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Auto-accept Pi edits")
      .setDesc("Skip the Obsidian preview dialog and let Pi apply accepted conversation edits directly. Keep disabled for safer public/default use.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoAcceptChanges).onChange(async (value) => {
        this.plugin.settings.autoAcceptChanges = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Startup notice")
      .setDesc("Show a notice with the local bridge port when the plugin starts.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showStartupNotice).onChange(async (value) => {
        this.plugin.settings.showStartupNotice = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Lock directory")
      .setDesc("Directory where the plugin writes <port>.lock files. Pi-side @ldelossa/pi-ide reads ~/.pi/ide by default.")
      .addText((text) => text.setPlaceholder(DEFAULT_LOCK_DIR).setValue(this.plugin.settings.lockDir).onChange(async (value) => {
        this.plugin.settings.lockDir = value.trim() || DEFAULT_LOCK_DIR;
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText("Restart bridge").onClick(async () => {
        await this.plugin.restartBridge();
        new Notice("Pi IDE bridge restarted");
      }));
  }
}
