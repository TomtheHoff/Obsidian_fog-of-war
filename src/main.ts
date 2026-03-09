import {
  ItemView,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import { DEFAULT_SETTINGS, MyPluginSettings } from "./settings";

const VIEW_TYPE_FOG_CONTROLLER = "fog-of-war-controller";
const VIEW_TYPE_FOG_PLAYER = "fog-of-war-player";

type FogViewState = {
  mapPath?: string;
};

type ExportFormat = { ext: string; mime: string; quality?: number; warn?: string };

/**
 * Shared renderer: image + canvas fog overlay + brush interaction (optionally disabled).
 */
class FogCanvasPane {
  private plugin: FogOfWarPlugin;
  private view: ItemView;

  wrapperEl?: HTMLDivElement;
  pathInputEl?: HTMLInputElement;
  imgEl?: HTMLImageElement;
  canvasEl?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  resizeObserver?: ResizeObserver;

  mapPath = "";

  // Brush
  brushRadius = 35;
  fogOpacityGm = 0.45;
  brushMode: "reveal" | "cover" = "reveal";
  isDrawing = false;
  activeTool: "reveal" | "cover" = "reveal";

  // Brush preview
  brushPreviewEl?: HTMLDivElement;
  lastPointerX: number = 0;
  lastPointerY: number = 0;

  // Mode
  isPlayerMode = false;

  publishTimer: number | null = null;
  resizeTimer: number | null = null;

  constructor(plugin: FogOfWarPlugin, view: ItemView) {
    this.plugin = plugin;
    this.view = view;
  }

  destroy() {
    this.pathInputEl = undefined;
    this.brushPreviewEl = undefined;

    try {
      if (this.resizeObserver && this.wrapperEl) this.resizeObserver.unobserve(this.wrapperEl);
    } catch {
      // ignore
    }

    if (this.publishTimer) {
      window.clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    if (this.resizeTimer) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }

    this.resizeObserver = undefined;
    this.wrapperEl = undefined;
    this.imgEl = undefined;
    this.canvasEl = undefined;
    this.ctx = undefined;
  }

  render(contentEl: HTMLElement, opts: { showControls: boolean; showSendToPlayer: boolean }) {
    const showControls = opts.showControls;

    if (showControls) {
      contentEl.createEl("h2", { text: "Fog of War" });

      const controls = contentEl.createDiv({ cls: "fog-controls" });
      // Layout: spacing between rows
      controls.style.display = "flex";
      controls.style.flexDirection = "column";
      controls.style.gap = "10px";
      controls.style.marginBottom = "10px";

      // --- Path row ---
      const pathRow = controls.createDiv({ cls: "fog-row" });
      // Layout: spacing inside the row
      pathRow.style.display = "flex";
      pathRow.style.alignItems = "center";
      pathRow.style.gap = "8px";
      pathRow.style.flexWrap = "wrap";
      pathRow.createEl("span", { text: "Map path:" });

      const pathInput = pathRow.createEl("input", {
        attr: { type: "text", placeholder: "folder/picture.jpg" },
      });
      pathInput.style.width = "420px";
      this.pathInputEl = pathInput;

      // Drop onto input: accept Obsidian-internal drags
      pathInput.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      });
      pathInput.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (this.isPlayerMode) return;
        const dt = ev.dataTransfer;
        if (!dt) return;

        const mapPath = this.extractVaultPathFromDataTransfer(dt);
        if (!mapPath) {
          new Notice("Fog of War: Konnte keinen gültigen Vault-Pfad aus dem Drop lesen.");
          return;
        }

        pathInput.value = mapPath;
        this.mapPath = mapPath;
        await this.loadMap(mapPath);
      });

      const loadBtn = pathRow.createEl("button", { text: "Load" });
      loadBtn.onclick = async () => {
        const mapPath = pathInput.value.trim();
        if (!mapPath) {
          new Notice("Fog of War: Bitte einen Map-Pfad eingeben.");
          return;
        }
        this.mapPath = normalizePath(mapPath);
        await this.loadMap(this.mapPath);
      };

      // --- Actions row ---
      const actionRow = controls.createDiv({ cls: "fog-row" });
      actionRow.style.display = "flex";
      actionRow.style.alignItems = "center";
      actionRow.style.gap = "8px";
      actionRow.style.flexWrap = "wrap";

      const exportBtn = actionRow.createEl("button", { text: "Export current Image" });
      exportBtn.onclick = async () => {
        const out = await this.exportAndCopy();
        if (!out) return;
      };

      if (opts.showSendToPlayer) {
        const sendBtn = actionRow.createEl("button", { text: "Open Player View" });
        sendBtn.onclick = async () => {
          if (!this.mapPath) {
            new Notice("Fog of War: Bitte zuerst eine Karte laden.");
            return;
          }
          await this.plugin.openOrUpdatePlayerWindow(this.mapPath);
        };
      }

      // --- Brush row ---
      const brushRow = controls.createDiv({ cls: "fog-row" });
      brushRow.style.display = "flex";
      brushRow.style.alignItems = "center";
      brushRow.style.gap = "8px";
      brushRow.style.flexWrap = "wrap";
      const brushModeBtn = brushRow.createEl("button", { text: "Tool: Reveal" });
      brushRow.createEl("span", { text: "Brush radius:" });

      const radiusInput = brushRow.createEl("input", {
        attr: { type: "range", min: "5", max: "200", value: String(this.brushRadius) },
      });
      radiusInput.style.width = "260px";

      const radiusLabel = brushRow.createEl("span", { text: `${this.brushRadius}px` });

      brushModeBtn.onclick = () => {
        this.brushMode = this.brushMode === "reveal" ? "cover" : "reveal";
        brushModeBtn.textContent = this.brushMode === "reveal" ? "Tool: Reveal" : "Tool: Cover";
        this.updateBrushPreviewStyle();
      };

      radiusInput.oninput = () => {
        this.brushRadius = Number(radiusInput.value);
        radiusLabel.textContent = `${this.brushRadius}px`;
        this.updateBrushPreviewSize();
      };
    }

    // --- Stage ---
    const stage = contentEl.createDiv({ cls: "fog-stage" });
    if (!this.isPlayerMode) {
      stage.style.border = "1px solid var(--background-modifier-border)";
      stage.style.borderRadius = "10px";
      stage.style.padding = "10px";
    }

    this.wrapperEl = stage.createDiv({ cls: "fog-wrapper" });
    this.wrapperEl.style.position = "relative";
    this.wrapperEl.style.width = "100%";
    this.wrapperEl.style.maxWidth = this.isPlayerMode ? "100%" : "1200px";

    // Image
    this.imgEl = this.wrapperEl.createEl("img");
    this.imgEl.style.display = "block";
    this.imgEl.style.width = "100%";
    this.imgEl.style.height = "auto";
    this.imgEl.style.borderRadius = "8px";

    // Canvas overlay
    this.canvasEl = this.wrapperEl.createEl("canvas");
    this.canvasEl.style.position = "absolute";
    this.canvasEl.style.left = "0";
    this.canvasEl.style.top = "0";
    this.canvasEl.style.width = "100%";
    this.canvasEl.style.height = "100%";
    this.canvasEl.style.borderRadius = "8px";

    // Brush preview (controller only)
    if (!this.isPlayerMode) {
      this.brushPreviewEl = this.wrapperEl.createDiv({ cls: "fog-brush-preview" });
      this.brushPreviewEl.style.position = "absolute";
      this.brushPreviewEl.style.left = "0";
      this.brushPreviewEl.style.top = "0";
      this.brushPreviewEl.style.width = "0";
      this.brushPreviewEl.style.height = "0";
      this.brushPreviewEl.style.border = "2px solid var(--text-muted)";
      this.brushPreviewEl.style.borderRadius = "9999px";
      this.brushPreviewEl.style.pointerEvents = "none";
      this.brushPreviewEl.style.opacity = "0";
      this.brushPreviewEl.style.transform = "translate(-9999px, -9999px)";
    }

    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) {
      new Notice("Fog of War: Canvas context konnte nicht erstellt werden.");
      return;
    }
    this.ctx = ctx;

    this.applyModeToCanvas();
    this.applyFogOpacity();

    // Init brush preview
    this.updateBrushPreviewSize();
    this.updateBrushPreviewStyle();

    // --- Drag & Drop on map area ---
    const addDnD = (el: HTMLElement) => {
      el.addEventListener(
        "dragover",
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
          this.wrapperEl?.classList.add("fog-dragover");
        },
        { capture: true }
      );

      el.addEventListener(
        "drop",
        async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.wrapperEl?.classList.remove("fog-dragover");
          if (this.isPlayerMode) return;

          const dt = ev.dataTransfer;
          if (!dt) return;

          const mapPath = this.extractVaultPathFromDataTransfer(dt);
          if (!mapPath) {
            new Notice("Fog of War: Konnte keinen gültigen Vault-Pfad aus dem Drop lesen.");
            return;
          }

          if (this.pathInputEl) this.pathInputEl.value = mapPath;
          this.mapPath = mapPath;
          await this.loadMap(mapPath);
        },
        { capture: true }
      );

      el.addEventListener(
        "dragleave",
        () => this.wrapperEl?.classList.remove("fog-dragover"),
        { capture: true }
      );
    };

    addDnD(this.wrapperEl);
    addDnD(this.imgEl);
    addDnD(this.canvasEl);

    // --- Brush drawing ---
    this.canvasEl.addEventListener("contextmenu", (e) => e.preventDefault());

    // Brush preview tracking
    this.canvasEl.addEventListener("pointerenter", () => {
      if (this.isPlayerMode) return;
      this.showBrushPreview(true);
    });
    this.canvasEl.addEventListener("pointerleave", () => {
      if (this.isPlayerMode) return;
      this.showBrushPreview(false);
    });
    this.canvasEl.addEventListener("pointermove", (ev) => {
      if (this.isPlayerMode) return;
      this.updateBrushPreviewPosition(ev);
    });

    this.canvasEl.addEventListener("pointerdown", (ev) => {
      if (this.isPlayerMode) return;
      this.isDrawing = true;
      this.activeTool = ev.button === 2 || (ev.buttons & 2) === 2 ? "cover" : this.brushMode;

      try {
        (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      this.applyBrushAtPointer(ev, this.activeTool);
      this.updateBrushPreviewPosition(ev);
      this.schedulePublish();
    });

    this.canvasEl.addEventListener("pointermove", (ev) => {
      if (this.isPlayerMode) return;
      if (!this.isDrawing) return;
      this.applyBrushAtPointer(ev, this.activeTool);
      this.schedulePublish();
    });

    const endDraw = (ev: PointerEvent) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      try {
        (ev.currentTarget as Element).releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      this.schedulePublish();
    };

    this.canvasEl.addEventListener("pointerup", endDraw);
    this.canvasEl.addEventListener("pointercancel", endDraw);

    // --- Resize handling ---
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        this.handleResize();
      }, 60);
    });
    this.resizeObserver.observe(this.wrapperEl);
  }

  applyModeToCanvas() {
    if (!this.canvasEl) return;
    this.canvasEl.style.pointerEvents = this.isPlayerMode ? "none" : "auto";
  }

  applyFogOpacity() {
    if (!this.canvasEl) return;
    this.canvasEl.style.opacity = this.isPlayerMode ? "1" : String(this.fogOpacityGm);
  }

  async loadMap(mapPathRaw: string) {
    if (!this.imgEl || !this.canvasEl || !this.ctx) return;

    const mapPath = normalizePath(mapPathRaw);

    const af = this.plugin.app.vault.getAbstractFileByPath(mapPath);
    if (!af || !(af instanceof TFile)) {
      new Notice(`Fog of War: Datei nicht gefunden: ${mapPath}`);
      return;
    }

    const url = this.plugin.app.vault.getResourcePath(af);

    let ok = true;
    const alreadyLoaded = this.imgEl.src === url && (this.imgEl as any).complete;
    if (!alreadyLoaded) {
      ok = await new Promise<boolean>((resolve) => {
        this.imgEl!.onload = () => resolve(true);
        this.imgEl!.onerror = () => resolve(false);
        this.imgEl!.src = url;
      });
    }

    if (!ok) {
      new Notice("Fog of War: Bild konnte nicht geladen werden.");
      return;
    }

    this.mapPath = mapPath;

    this.resizeCanvasToImage();

    const existing = this.plugin.getFogDataUrl(mapPath);
    if (existing) {
      await this.applyFogFromDataUrl(existing);
    } else {
      this.fillFog();
      this.publishNow();
    }

    this.applyFogOpacity();
  }

  private resizeCanvasToImage() {
    if (!this.imgEl || !this.canvasEl || !this.ctx) return;

    const rect = this.imgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    this.canvasEl.width = Math.round(rect.width * dpr);
    this.canvasEl.height = Math.round(rect.height * dpr);

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  private async handleResize() {
    if (!this.mapPath) return;

    this.resizeCanvasToImage();

    const existing = this.plugin.getFogDataUrl(this.mapPath);
    if (existing) {
      await this.applyFogFromDataUrl(existing);
    } else {
      this.fillFog();
    }

    this.applyFogOpacity();
  }

  private fillFog() {
    if (!this.imgEl || !this.canvasEl || !this.ctx) return;
    const rect = this.imgEl.getBoundingClientRect();
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, rect.width, rect.height);
  }

  async applyFogFromDataUrl(dataUrl: string) {
    if (!this.imgEl || !this.canvasEl || !this.ctx) return;
    const rect = this.imgEl.getBoundingClientRect();

    const img = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });

    if (!ok) {
      this.fillFog();
      return;
    }

    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.ctx.drawImage(img, 0, 0, rect.width, rect.height);
  }

  private schedulePublish() {
    if (!this.mapPath) return;
    if (this.publishTimer) window.clearTimeout(this.publishTimer);
    this.publishTimer = window.setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, 90);
  }

  private publishNow() {
    if (!this.canvasEl || !this.mapPath) return;
    try {
      const dataUrl = this.canvasEl.toDataURL("image/png");
      this.plugin.setFogDataUrl(this.mapPath, dataUrl);
    } catch {
      // ignore
    }
  }

  private applyBrushAtPointer(ev: PointerEvent, tool: "reveal" | "cover") {
    if (!this.canvasEl || !this.ctx) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    this.ctx.save();
    if (tool === "reveal") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.fillStyle = "black";
      this.ctx.beginPath();
      this.ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  private showBrushPreview(show: boolean) {
    if (!this.brushPreviewEl) return;
    this.brushPreviewEl.style.opacity = show ? "1" : "0";
  }

  private updateBrushPreviewSize() {
    if (!this.brushPreviewEl) return;
    const d = Math.max(1, this.brushRadius * 2);
    this.brushPreviewEl.style.width = `${d}px`;
    this.brushPreviewEl.style.height = `${d}px`;
  }

  private updateBrushPreviewStyle() {
    if (!this.brushPreviewEl) return;
    // Slightly different dash style for cover vs reveal
    this.brushPreviewEl.style.borderStyle = this.brushMode === "cover" ? "dashed" : "solid";
  }

  private updateBrushPreviewPosition(ev: PointerEvent) {
    if (!this.canvasEl || !this.brushPreviewEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    this.lastPointerX = x;
    this.lastPointerY = y;

    const d = Math.max(1, this.brushRadius * 2);
    const left = x - d / 2;
    const top = y - d / 2;

    this.brushPreviewEl.style.transform = `translate(${left}px, ${top}px)`;
  }

  private extractVaultPathFromDataTransfer(dt: DataTransfer): string | null {
    const candidates = [dt.getData("text/plain"), dt.getData("text/uri-list")].filter(Boolean) as string[];
    if (!candidates.length) return null;

    let raw = candidates[0]!.trim();

    // Strip markdown embeds: ![[path]] or [[path]]
    raw = raw.replace(/^!\[\[/, "").replace(/^\[\[/, "").replace(/\]\]$/, "");

    // obsidian://open?vault=...&file=PATH OR obsidian://open?path=PATH
    if (raw.startsWith("obsidian://")) {
      try {
        const u = new URL(raw);
        const fileParam = u.searchParams.get("file");
        const pathParam = u.searchParams.get("path");
        const candidate = fileParam ?? pathParam;
        if (candidate) raw = decodeURIComponent(candidate);
      } catch {
        // ignore
      }
    }

    // We do NOT support external OS file drops yet
    if (raw.startsWith("file://")) return null;

    // FIX: normalize backslashes (Windows) to slashes
    raw = raw.replace(/^"|"$/g, "").replace(/\\/g, "/");

    const mapPath = normalizePath(raw);
    const af = this.plugin.app.vault.getAbstractFileByPath(mapPath);
    if (!af || !(af instanceof TFile)) return null;

    return mapPath;
  }

  async exportAndCopy(): Promise<string | null> {
    if (!this.mapPath) {
      new Notice("Fog of War: Bitte zuerst eine Karte laden.");
      return null;
    }

    const outPath = await this.exportPlayerSnapshot();
    if (outPath) {
      new Notice(`Player image updated: ${outPath}`);
      await this.copyExportNameToClipboard(outPath);
    }
    return outPath;
  }

  private async exportPlayerSnapshot(): Promise<string | null> {
    if (!this.mapPath || !this.imgEl || !this.canvasEl) return null;

    const fmt = this.plugin.getExportFormatForMap(this.mapPath);
    if (fmt.warn) new Notice(fmt.warn);

    // Overwrite file (you changed back from counter)
    const outPath = this.plugin.nextPlayerExportPath(this.mapPath, fmt.ext);

    const w = this.imgEl.naturalWidth || this.imgEl.width;
    const h = this.imgEl.naturalHeight || this.imgEl.height;
    if (!w || !h) {
      new Notice("Fog of War: Bildgröße konnte nicht bestimmt werden.");
      return null;
    }

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d");
    if (!offCtx) return null;

    offCtx.drawImage(this.imgEl, 0, 0, w, h);

    const fogUrl = this.canvasEl.toDataURL("image/png");
    const fogImg = new Image();
    const ok = await new Promise<boolean>((resolve) => {
      fogImg.onload = () => resolve(true);
      fogImg.onerror = () => resolve(false);
      fogImg.src = fogUrl;
    });
    if (ok) offCtx.drawImage(fogImg, 0, 0, w, h);

    const blob: Blob | null = await new Promise((resolve) => off.toBlob(resolve, fmt.mime, fmt.quality));
    if (!blob) return null;

    const buf = await blob.arrayBuffer();

    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(outPath);
    if (existing && existing instanceof TFile) {
      // @ts-ignore
      await (vault as any).modifyBinary(existing, buf);
    } else {
      // @ts-ignore
      await (vault as any).createBinary(outPath, buf);
    }

    return outPath;
  }

  private async copyExportNameToClipboard(exportPath: string) {
    const filename = exportPath.split("/").pop() ?? exportPath;
    const dot = filename.lastIndexOf(".");
    const baseName = dot >= 0 ? filename.slice(0, dot) : filename;

    try {
      await navigator.clipboard.writeText(baseName);
      new Notice(`Copied to clipboard: ${baseName}`);
    } catch {
      if (this.pathInputEl) {
        this.pathInputEl.value = baseName;
        this.pathInputEl.focus();
        this.pathInputEl.select();
      }
      new Notice("Fog of War: Konnte nicht direkt in die Zwischenablage kopieren. Name ist markiert im Feld.");
    }
  }
}

class FogControllerView extends ItemView {
  private plugin: FogOfWarPlugin;
  private pane: FogCanvasPane;

  constructor(leaf: WorkspaceLeaf, plugin: FogOfWarPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.pane = new FogCanvasPane(plugin, this);
    this.pane.isPlayerMode = false;
  }

  getViewType(): string {
    return VIEW_TYPE_FOG_CONTROLLER;
  }

  getDisplayText(): string {
    return "Fog of War";
  }

  async onOpen() {
    this.plugin.registerController(this);
    this.contentEl.empty();
    this.pane.render(this.contentEl, { showControls: true, showSendToPlayer: true });

    // If there is a last map, try to load it
    const last = this.plugin.getLastMapPath();
    if (last) {
      this.pane.mapPath = last;
      if (this.pane.pathInputEl) this.pane.pathInputEl.value = last;
      await this.pane.loadMap(last);
    }
  }

  async onClose() {
    this.pane.destroy();
    this.plugin.unregisterController(this);
  }

  getState(): FogViewState {
    return { mapPath: this.pane.mapPath };
  }

  async setState(state: FogViewState, _result: any): Promise<void> {
    if (typeof state?.mapPath === "string") {
      this.pane.mapPath = normalizePath(state.mapPath);
      if (this.pane.pathInputEl) this.pane.pathInputEl.value = this.pane.mapPath;
      await this.pane.loadMap(this.pane.mapPath);
    }
  }

  async exportAndCopy(): Promise<string | null> {
    return this.pane.exportAndCopy();
  }

  getMapPath(): string {
    return this.pane.mapPath;
  }
}

class FogPlayerView extends ItemView {
  private plugin: FogOfWarPlugin;
  private pane: FogCanvasPane;

  constructor(leaf: WorkspaceLeaf, plugin: FogOfWarPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.pane = new FogCanvasPane(plugin, this);
    this.pane.isPlayerMode = true;
  }

  getViewType(): string {
    return VIEW_TYPE_FOG_PLAYER;
  }

  getDisplayText(): string {
    return "Player View";
  }

  async onOpen() {
    this.plugin.registerPlayer(this);
    this.contentEl.empty();

    // No controls in player view
    this.pane.render(this.contentEl, { showControls: false, showSendToPlayer: false });

    // If we already have a mapPath (state), load it
    const mp = this.pane.mapPath || this.plugin.getLastMapPath();
    if (mp) {
      this.pane.mapPath = mp;
      await this.pane.loadMap(mp);
    }
  }

  async onClose() {
    this.pane.destroy();
    this.plugin.unregisterPlayer(this);
  }

  async setState(state: FogViewState, _result: any): Promise<void> {
    if (typeof state?.mapPath === "string") {
      this.pane.mapPath = normalizePath(state.mapPath);
      await this.pane.loadMap(this.pane.mapPath);
    }
  }

  async applyFog(dataUrl: string) {
    await this.pane.applyFogFromDataUrl(dataUrl);
  }

  getMapPath(): string {
    return this.pane.mapPath;
  }
}

export default class FogOfWarPlugin extends Plugin {
  settings: MyPluginSettings;

  private fogByMapPath = new Map<string, string>();
  private lastMapPath: string = "";

  private controllers = new Set<FogControllerView>();
  private players = new Set<FogPlayerView>();

  private playerLeaf: WorkspaceLeaf | null = null;

  async onload() {
    await this.loadSettings();

    // Context menu entries
    // 1) File explorer / file context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.isSupportedImage(file)) return;

        menu.addItem((item) => {
          item
            .setTitle("Open in Fog of War")
            .setIcon("eye")
            .onClick(async () => {
              await this.openControllerWithMap(file.path);
            });
        });
      }) as any
    );

    // 2) Editor context menu fallback: if the active file is an image
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu) => {
        const af = this.app.workspace.getActiveFile();
        if (!af) return;
        if (!this.isSupportedImage(af)) return;

        menu.addItem((item) => {
          item
            .setTitle("Open active image in Fog of War")
            .setIcon("eye")
            .onClick(async () => {
              await this.openControllerWithMap(af.path);
            });
        });
      }) as any
    );

    this.registerView(VIEW_TYPE_FOG_CONTROLLER, (leaf) => new FogControllerView(leaf, this));
    this.registerView(VIEW_TYPE_FOG_PLAYER, (leaf) => new FogPlayerView(leaf, this));

    // Command: open controller
    this.addCommand({
      id: "open-fog-controller",
      name: "Open Fog of War",
      callback: async () => {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.setViewState({ type: VIEW_TYPE_FOG_CONTROLLER, active: true });
        this.app.workspace.revealLeaf(leaf);
      },
    });

    // Command: open/update player view
    this.addCommand({
      id: "open-or-update-player-view",
      name: "Open/Update Player View",
      callback: async () => {
        const controller = this.getActiveController();
        const mapPath = controller?.getMapPath() || this.lastMapPath;
        if (!mapPath) {
          new Notice("Fog of War: Bitte zuerst eine Karte laden.");
          return;
        }
        await this.openOrUpdatePlayerWindow(mapPath);
      },
    });

    // Command: export
    this.addCommand({
      id: "export-player-image",
      name: "Export Player Image",
      callback: async () => {
        const controller = this.getActiveController();
        if (!controller) {
          new Notice("Fog of War: Keine Fog-of-War View aktiv.");
          return;
        }
        await controller.exportAndCopy();
      },
    });

    // Ribbon icon
    this.addRibbonIcon("eye", "Open Fog of War", async () => {
      await this.openControllerWithMap(this.lastMapPath || "");
    });
  }

  onunload() {
    // nothing
  }

  registerController(v: FogControllerView) {
    this.controllers.add(v);
  }

  unregisterController(v: FogControllerView) {
    this.controllers.delete(v);
  }

  registerPlayer(v: FogPlayerView) {
    this.players.add(v);
  }

  unregisterPlayer(v: FogPlayerView) {
    this.players.delete(v);
    // If our singleton leaf got closed, forget it
    if (this.playerLeaf && this.playerLeaf.view === v) {
      this.playerLeaf = null;
    }
  }

  private isSupportedImage(file: TFile): boolean {
    const ext = (file.extension || "").toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return true;
    // Fallback by filename (just in case extension is missing)
    return /\.(png|jpe?g|webp|gif)$/i.test(file.path);
  }

  /**
   * Opens (or reuses) a controller view and optionally loads a given map.
   */
  async openControllerWithMap(mapPath: string) {
    const leaf = this.app.workspace.getLeaf(false);
    const state: FogViewState = mapPath ? { mapPath: normalizePath(mapPath) } : {};

    await leaf.setViewState({
      type: VIEW_TYPE_FOG_CONTROLLER,
      active: true,
      state,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  getLastMapPath(): string {
    return this.lastMapPath;
  }

  getFogDataUrl(mapPath: string): string | undefined {
    return this.fogByMapPath.get(normalizePath(mapPath));
  }

  setFogDataUrl(mapPath: string, dataUrl: string) {
    const key = normalizePath(mapPath);
    this.lastMapPath = key;
    this.fogByMapPath.set(key, dataUrl);

    // Push live update to any open player views showing the same map
    for (const p of this.players) {
      if (normalizePath(p.getMapPath()) === key) {
        p.applyFog(dataUrl);
      }
    }
  }

  private getActiveController(): FogControllerView | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view;
    if (view && (view as any).getViewType?.() === VIEW_TYPE_FOG_CONTROLLER) {
      return view as FogControllerView;
    }
    for (const c of this.controllers) return c;
    return null;
  }

  /**
   * Opens (or reuses) a singleton Player popout window and loads the given map.
   */
  async openOrUpdatePlayerWindow(mapPath: string) {
    const mp = normalizePath(mapPath);
    this.lastMapPath = mp;

    // Reuse existing player leaf if possible
    if (!this.playerLeaf) {
      this.playerLeaf = this.app.workspace.openPopoutLeaf();
      await this.playerLeaf.setViewState({
        type: VIEW_TYPE_FOG_PLAYER,
        active: true,
        state: { mapPath: mp },
      });
      this.app.workspace.revealLeaf(this.playerLeaf);
    } else {
      await this.playerLeaf.setViewState({
        type: VIEW_TYPE_FOG_PLAYER,
        active: true,
        state: { mapPath: mp },
      });
      this.app.workspace.revealLeaf(this.playerLeaf);
    }

    // If we already have fog for this map, push it immediately
    const fog = this.getFogDataUrl(mp);
    if (fog) {
      const v = this.playerLeaf.view;
      if (v && (v as any).getViewType?.() === VIEW_TYPE_FOG_PLAYER) {
        await (v as FogPlayerView).applyFog(fog);
      }
    }
  }

  getExportFormatForMap(mapPath: string): ExportFormat {
    const norm = normalizePath(mapPath);
    const dot = norm.lastIndexOf(".");
    const ext = dot >= 0 ? norm.slice(dot + 1).toLowerCase() : "";

    switch (ext) {
      case "jpg":
      case "jpeg":
        return { ext: "jpg", mime: "image/jpeg", quality: 0.92 };
      case "webp":
        return { ext: "webp", mime: "image/webp", quality: 0.92 };
      case "png":
        return { ext: "png", mime: "image/png" };
      case "gif":
        return {
          ext: "png",
          mime: "image/png",
          warn:
            "Fog of War: GIF erkannt – Export wird als statisches PNG erstellt (animierte GIF-Exports mit Overlay sind deutlich komplexer).",
        };
      default:
        return { ext: "png", mime: "image/png" };
    }
  }

  nextPlayerExportPath(mapPath: string, ext: string = "png"): string {
    const norm = normalizePath(mapPath);
    const dot = norm.lastIndexOf(".");
    const base = dot >= 0 ? norm.slice(0, dot) : norm;
    return normalizePath(`${base}.player.${ext}`);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<MyPluginSettings>
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
