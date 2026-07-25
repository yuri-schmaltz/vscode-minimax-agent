/**
 * DriveViewProvider — the sidebar tree view for the Mavis Drive.
 *
 * The tree is structured as:
 *   - root: 7 {@link DriveCategory} nodes (only categories with items
 *     are exposed, in the canonical display order).
 *   - child of a category: {@link DriveTreeItem} wrappers around each
 *     {@link DriveItem}, exposing name, size, createdAt and a
 *     `vscode.open` command on click.
 *
 * Refreshes are driven by the provider's own `refresh()` and by
 * MavisClient `onDriveChanged` events (list/get/delete).
 *
 * Drag-and-drop is supported via a `DragAndDropController` that mints a
 * custom `application/x-mavis-drive-item` MIME payload of the form
 * `{file:<id>:<name>}`. The chat webview recognises this payload when a
 * user drags a Drive row into the chat textarea.
 */
import {
  Command,
  EventEmitter as VSCodeEventEmitter,
  ProviderResult,
  ThemeIcon,
  TreeDataProvider,
  TreeDragAndDropController,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  commands,
} from 'vscode';
import { MavisClient } from '../client/MavisClient';
import { DRIVE_CATEGORIES, DriveCategory, DriveItem } from '../client/types';

/** Custom MIME type for dragged Drive items. */
export const DRIVE_MIME = 'application/x-mavis-drive-item';

/** Compose the drag payload that the chat accepts. */
export function encodeDrivePayload(item: { id: string; name: string }): string {
  return `{file:${item.id}:${item.name}}`;
}

/** A node in the Drive tree. Either a category (folder) or a leaf item. */
export type DriveNode =
  | { kind: 'category'; category: DriveCategory; count: number }
  | { kind: 'item'; item: DriveItem };

/** Type-guard for category nodes. */
export function isCategoryNode(node: DriveNode | undefined | null): node is { kind: 'category'; category: DriveCategory; count: number } {
  return Boolean(node && node.kind === 'category');
}

/** Type-guard for item nodes. */
export function isItemNode(node: DriveNode | undefined | null): node is { kind: 'item'; item: DriveItem } {
  return Boolean(node && node.kind === 'item');
}

/** Human label for a category. */
export const CATEGORY_LABELS: Record<DriveCategory, string> = {
  documents: 'Documents',
  excel: 'Spreadsheets',
  ppt: 'Presentations',
  images: 'Images',
  videos: 'Videos',
  audio: 'Audio',
  other: 'Other',
};

export interface DriveViewDeps {
  client: MavisClient;
  /**
   * Called when the user picks a Drive item to open. The host wires this
   * to `vscode.open` (or a download-then-open flow). When omitted, the
   * provider falls back to writing a local temp file and opening it.
   */
  openItem?: (item: DriveItem) => Promise<void>;
  /**
   * Called when the user picks "Attach to chat". The host should
   * inject a `{file:<id>:<name>}` reference into the active chat.
   * When omitted, a no-op stub is used.
   */
  attachToChat?: (item: DriveItem) => Promise<void>;
}

const DEFAULT_CATEGORY_SET: ReadonlySet<DriveCategory> = new Set(DRIVE_CATEGORIES);

/**
 * Drive TreeDataProvider. Re-fetches the entire list when
 * `MavisClient.onDriveChanged` fires (mutations anywhere in the system
 * invalidate the cache).
 */
export class DriveViewProvider implements TreeDataProvider<DriveNode>, TreeDragAndDropController<DriveNode> {
  // Required by the vscode TreeDragAndDropController interface; we don't
  // actually intercept drops — the payload is generated on demand via
  // `encodePayloadForItem`.
  readonly dragMimeTypes: readonly string[] = [DRIVE_MIME];
  readonly dropMimeTypes: readonly string[] = [];
  /** Fired by the provider itself (or by an external call to `refresh()`). */
  readonly onDidChangeTreeData: import('vscode').Event<DriveNode | DriveNode[] | undefined | null>;
  private readonly changeEmitter = new VSCodeEventEmitter<DriveNode | undefined | null>();
  /** Last known list of items by category. */
  private items: DriveItem[] = [];
  /** True while a list is in flight. */
  private loading = false;
  /** Last error message (for the "Drive unavailable" empty state). */
  private lastError: string | undefined;
  /** Bound client listeners (so we can detach on dispose). */
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly deps: DriveViewDeps) {
    this.onDidChangeTreeData = this.changeEmitter.event;
    // Refresh the tree whenever the client reports a mutation.
    const onChange = () => {
      void this.refresh();
    };
    deps.client.onDriveChanged.on('list', onChange);
    deps.client.onDriveChanged.on('get', onChange);
    deps.client.onDriveChanged.on('delete', onChange);
  }

  /** Returns a flat list of all Drive items. Useful for tests / consumers. */
  getItems(): DriveItem[] {
    return this.items.slice();
  }

  /** Returns items grouped by category (preserves the canonical order). */
  getItemsByCategory(): Record<DriveCategory, DriveItem[]> {
    const out = DRIVE_CATEGORIES.reduce((acc, cat) => {
      acc[cat] = [];
      return acc;
    }, {} as Record<DriveCategory, DriveItem[]>);
    for (const it of this.items) {
      if (out[it.category]) out[it.category].push(it);
    }
    return out;
  }

  /** Returns the last error from a failed list, or undefined. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Re-fetches the list from the client. Emits a tree change so the UI
   * re-renders. Errors are captured in `lastError` and surfaced via the
   * "Drive unavailable" empty state.
   */
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.items = await this.deps.client.listDrive();
      this.lastError = undefined;
    } catch (err) {
      this.items = [];
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.changeEmitter.fire(undefined);
    }
  }

  /** Returns the root node (undefined) — children are the categories with items. */
  getTreeItem(element: DriveNode): TreeItem {
    if (isCategoryNode(element)) {
      const t = new TreeItem(CATEGORY_LABELS[element.category], TreeItemCollapsibleState.Expanded);
      t.iconPath = new ThemeIcon('folder');
      t.contextValue = 'mavis.driveCategory';
      t.description = `${element.count}`;
      t.tooltip = `${CATEGORY_LABELS[element.category]} (${element.count} item${element.count === 1 ? '' : 's'})`;
      return t;
    }
    if (isItemNode(element)) {
      const t = new TreeItem(element.item.name);
      t.iconPath = new ThemeIcon('file');
      t.contextValue = 'mavis.driveItem';
      t.description = humanSize(element.item.sizeBytes);
      t.tooltip = `${element.item.name} — ${humanSize(element.item.sizeBytes)} — ${new Date(element.item.createdAt).toISOString()}`;
      t.command = {
        title: 'Open Drive item',
        command: 'mavis.openDriveItem',
        arguments: [element.item.id],
      } as Command;
      return t;
    }
    return new TreeItem('Drive');
  }

  /**
   * Returns the children of a node:
   *   - root (element = undefined): 7 category nodes, skipping the ones
   *     with zero items (unless the list is empty, in which case a single
   *     "Drive is empty" leaf is shown).
   *   - category node: the items in that category, in insertion order.
   *   - item node: no children.
   */
  getChildren(element?: DriveNode): ProviderResult<DriveNode[]> {
    if (!element) {
      if (this.lastError) {
        return [{ kind: 'item', item: emptyDriveItem(`Drive unavailable: ${this.lastError}`) }];
      }
      if (this.items.length === 0) {
        return [{ kind: 'item', item: emptyDriveItem('Drive is empty (press refresh)') }];
      }
      const grouped = this.getItemsByCategory();
      return DRIVE_CATEGORIES
        .filter((c) => grouped[c].length > 0)
        .map<DriveNode>((c) => ({ kind: 'category', category: c, count: grouped[c].length }));
    }
    if (isCategoryNode(element)) {
      return this.getItemsByCategory()[element.category].map<DriveNode>((it) => ({ kind: 'item', item: it }));
    }
    return [];
  }

  /** Returns the parent of a node (for the tree view's reveal() API). */
  getParent(element: DriveNode): ProviderResult<DriveNode | undefined> {
    if (isItemNode(element)) {
      const cat = element.item.category;
      const grouped = this.getItemsByCategory();
      return { kind: 'category', category: cat, count: grouped[cat].length };
    }
    return undefined;
  }

  /**
   * Drag-and-drop support. We don't actually need to inspect the drag
   * event — the leaf is identified via `TreeItem` → `MavisClient`.
   * The {@link encodePayloadForItem} helper is the canonical entry-point
   * for producing the wire format.
   */
  onWillAcceptDrop(): boolean {
    return true;
  }
  onWillDrop(): boolean {
    return true;
  }
  onDidDrop(): void {
    /* noop: payload is generated on demand via encodePayloadForItem */
  }

  /** Returns the wire payload for a node. Called by external drag layers. */
  encodePayloadForItem(node: DriveNode): string | undefined {
    if (isItemNode(node)) {
      return encodeDrivePayload(node.item);
    }
    return undefined;
  }

  /** Public action: open an item by id. */
  async openItem(item: DriveItem): Promise<void> {
    if (this.deps.openItem) {
      await this.deps.openItem(item);
      return;
    }
    // Default fallback: fetch + write a temp file and `vscode.open` it.
    const file = await this.deps.client.getDriveFile(item.id);
    const local = await writeTempDriveFile(file);
    await commands.executeCommand('vscode.open', Uri.file(local));
  }

  /** Public action: attach a Drive item to the active chat. */
  async attachToChat(item: DriveItem): Promise<void> {
    if (this.deps.attachToChat) {
      await this.deps.attachToChat(item);
      return;
    }
    // Default: post a notice. Real host wires this to the chat.
    void commands.executeCommand('mavis._attachToChat', encodeDrivePayload(item));
  }

  /** Detach all listeners. */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.deps.client.onDriveChanged.removeAllListeners();
    this.changeEmitter.dispose();
  }
}

/**
 * Writes the file's content to a temp path under the system temp
 * directory and returns the absolute path. Used by the default
 * `openItem` flow when the host hasn't supplied a custom handler.
 */
export async function writeTempDriveFile(file: { name: string; content: string; contentIsBase64?: boolean }): Promise<string> {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const dir = path.join(os.tmpdir(), 'mavis-drive');
  await fs.mkdir(dir, { recursive: true });
  const safe = file.name.replace(/[\\/:*?"<>|]+/g, '_');
  const target = path.join(dir, safe);
  const data = file.contentIsBase64
    ? Buffer.from(file.content, 'base64')
    : Buffer.from(file.content, 'utf8');
  await fs.writeFile(target, data);
  return target;
}

/** Returns a human-readable size string ("12.3 KB", "1.2 MB", ...). */
export function humanSize(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Returns a synthetic empty-state item for the tree. */
function emptyDriveItem(label: string): DriveItem {
  return {
    id: '_empty',
    name: label,
    category: 'other',
    sizeBytes: 0,
    mimeType: 'text/plain',
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Re-export the constants that other modules might want. */
export { DEFAULT_CATEGORY_SET };
export type { DriveCategory };
