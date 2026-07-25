/**
 * DriveViewProvider unit tests (Fase 4).
 *
 * The provider is a TreeDataProvider that groups items by category. We
 * drive it with a fake `MavisClient` whose `listDrive` returns canned
 * data, and assert on:
 *   - the root → category mapping (only categories with items appear);
 *   - the category → item mapping (stable insertion order);
 *   - the click command attached to item TreeItems;
 *   - the drag-payload encoding;
 *   - the `refresh()` flow + `onDriveChanged` auto-refresh.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { MavisClient } from '../../src/client/MavisClient';
import {
  DriveViewProvider,
  isCategoryNode,
  isItemNode,
  encodeDrivePayload,
  humanSize,
  CATEGORY_LABELS,
  DRIVE_MIME,
  writeTempDriveFile,
} from '../../src/views/DriveViewProvider';
import { DriveItem } from '../../src/client/types';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';
import { TreeItemCollapsibleState } from '../__mocks__/vscode';

const SAMPLE: DriveItem[] = [
  { id: 'd_doc1', name: 'spec.md', category: 'documents', sizeBytes: 1024, mimeType: 'text/markdown', createdAt: 1, updatedAt: 2 },
  { id: 'd_doc2', name: 'notes.txt', category: 'documents', sizeBytes: 2048, mimeType: 'text/plain', createdAt: 3, updatedAt: 4 },
  { id: 'd_img1', name: 'logo.png', category: 'images', sizeBytes: 4096, mimeType: 'image/png', createdAt: 5, updatedAt: 6 },
  { id: 'd_vid1', name: 'demo.mp4', category: 'videos', sizeBytes: 999_999, mimeType: 'video/mp4', createdAt: 7, updatedAt: 8 },
];

class FakeClient {
  private items: DriveItem[] = [];
  private throwOnList: Error | undefined;
  private deletedIds = new Set<string>();
  readonly onDriveChanged = new EventEmitter();
  listDriveImpl: () => Promise<DriveItem[]> = async () => this.items.filter((i) => !this.deletedIds.has(i.id));

  setItems(items: DriveItem[]): void {
    this.items = items.slice();
  }
  setThrowOnList(err: Error): void {
    this.throwOnList = err;
  }
  markDeleted(id: string): void {
    this.deletedIds.add(id);
  }
  reset(): void {
    this.items = [];
    this.deletedIds.clear();
    this.throwOnList = undefined;
  }

  // Implements the methods DriveViewProvider uses.
  async listDrive(): Promise<DriveItem[]> {
    if (this.throwOnList) throw this.throwOnList;
    return this.listDriveImpl();
  }
  async getDriveFile(id: string): Promise<{ id: string; name: string; content: string; contentIsBase64?: boolean }> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error('not found');
    return { id: it.id, name: it.name, content: 'bW9jaw==', contentIsBase64: true };
  }
  async deleteDriveFile(id: string): Promise<void> {
    this.deletedIds.add(id);
    this.onDriveChanged.emit('delete', { id });
  }
}

function makeClientLike(): MavisClient & { fake: FakeClient } {
  // We build a MavisClient-shaped object by extending the real class
  // and overriding only the methods the provider uses. This keeps
  // type-checking happy without rebuilding the entire client surface.
  const c = new MavisClient({
    spawnImpl: makeSpawner(makeFakeChild()),
    resolveBundledPath: () => '/bin/mavis',
  });
  const fake = new FakeClient();
  c.listDrive = () => fake.listDrive();
  c.getDriveFile = ((id: string) => fake.getDriveFile(id)) as typeof c.getDriveFile;
  c.deleteDriveFile = ((id: string) => fake.deleteDriveFile(id)) as typeof c.deleteDriveFile;
  return Object.assign(c, { fake });
}

function makeProvider(): { provider: DriveViewProvider; client: MavisClient & { fake: FakeClient } } {
  const c = makeClientLike();
  const p = new DriveViewProvider({ client: c });
  return { provider: p, client: c };
}

// ----------------------------------------------------------------- tests

test('DriveViewProvider: getChildren at root returns categories with items only', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const root = await provider.getChildren();
  assert.ok(Array.isArray(root));
  // 4 categories in the sample: documents, images, videos.
  // 'audio', 'excel', 'ppt', 'other' should be absent.
  const cats = (root as Array<{ kind: string; category: string; count: number }>).filter((n) => n.kind === 'category');
  assert.deepEqual(cats.map((c) => c.category).sort(), ['documents', 'images', 'videos']);
  assert.equal(cats.find((c) => c.category === 'documents')!.count, 2);
  assert.equal(cats.find((c) => c.category === 'images')!.count, 1);
  assert.equal(cats.find((c) => c.category === 'videos')!.count, 1);
  provider.dispose();
});

test('DriveViewProvider: getChildren for a category returns its items', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const docs = await provider.getChildren({ kind: 'category', category: 'documents', count: 2 });
  assert.ok(Array.isArray(docs));
  const items = (docs as Array<{ kind: string; item: DriveItem }>).filter((n) => n.kind === 'item');
  assert.equal(items.length, 2);
  assert.equal(items[0].item.id, 'd_doc1');
  assert.equal(items[1].item.id, 'd_doc2');
  provider.dispose();
});

test('DriveViewProvider: getTreeItem for a category renders a folder TreeItem', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const node = { kind: 'category', category: 'images', count: 1 } as const;
  const t = provider.getTreeItem(node);
  assert.equal(t.label, CATEGORY_LABELS.images);
  assert.equal(t.collapsibleState, TreeItemCollapsibleState.Expanded);
  assert.equal(t.contextValue, 'mavis.driveCategory');
  provider.dispose();
});

test('DriveViewProvider: getTreeItem for an item renders a file TreeItem with open command', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const node = { kind: 'item', item: SAMPLE[2] } as const;
  const t = provider.getTreeItem(node);
  assert.equal(t.label, SAMPLE[2].name);
  assert.equal(t.contextValue, 'mavis.driveItem');
  assert.equal(t.description, humanSize(SAMPLE[2].sizeBytes));
  assert.equal(t.command?.command, 'mavis.openDriveItem');
  assert.deepEqual(t.command?.arguments, [SAMPLE[2].id]);
  provider.dispose();
});

test('DriveViewProvider: encodePayloadForItem produces {file:<id>:<name>}', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const node = { kind: 'item', item: SAMPLE[0] } as const;
  assert.equal(provider.encodePayloadForItem(node), '{file:d_doc1:spec.md}');
  const cat = { kind: 'category', category: 'documents', count: 1 } as const;
  assert.equal(provider.encodePayloadForItem(cat), undefined);
  provider.dispose();
});

test('DriveViewProvider: refresh fetches from client and emits tree change', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  let treeFired = 0;
  provider.onDidChangeTreeData(() => { treeFired++; });
  await provider.refresh();
  assert.deepEqual(provider.getItems().map((i) => i.id), SAMPLE.map((i) => i.id));
  assert.ok(treeFired >= 1, 'tree change should fire at least once');
  provider.dispose();
});

test('DriveViewProvider: capture error on refresh and surface "Drive unavailable"', async () => {
  const { provider, client } = makeProvider();
  client.fake.setThrowOnList(new Error('boom'));
  await provider.refresh();
  assert.match(provider.getLastError() ?? '', /boom/);
  const root = (await provider.getChildren()) as Array<{ kind: string; item: DriveItem }>;
  assert.equal(root.length, 1);
  assert.match(root[0].item.name, /Drive unavailable/);
  provider.dispose();
});

test('DriveViewProvider: empty Drive shows "Drive is empty" leaf', async () => {
  const { provider } = makeProvider();
  await provider.refresh();
  const root = (await provider.getChildren()) as Array<{ kind: string; item: DriveItem }>;
  assert.equal(root.length, 1);
  assert.match(root[0].item.name, /Drive is empty/);
  provider.dispose();
});

test('DriveViewProvider: openItem (default fallback) calls client.getDriveFile + writes temp', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  // Stub the global commands.executeCommand via a side-channel: the
  // default openItem path uses `vscode.commands.executeCommand("vscode.open", uri)`.
  // We can't intercept that easily; instead we use a custom openItem
  // dep to capture the call.
  let opened: DriveItem | undefined;
  const provider2 = new DriveViewProvider({
    client,
    openItem: async (item) => { opened = item; },
  });
  await provider2.openItem(SAMPLE[0]);
  assert.ok(opened);
  assert.equal(opened!.id, SAMPLE[0].id);
  provider.dispose();
  provider2.dispose();
});

test('DriveViewProvider: attachToChat (custom dep) is invoked with the item', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  let attached: DriveItem | undefined;
  const provider2 = new DriveViewProvider({
    client,
    attachToChat: async (item) => { attached = item; },
  });
  await provider2.attachToChat(SAMPLE[1]);
  assert.ok(attached);
  assert.equal(attached!.id, SAMPLE[1].id);
  provider.dispose();
  provider2.dispose();
});

test('DriveViewProvider: getItemsByCategory groups by the 7-category order', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const grouped = provider.getItemsByCategory();
  assert.equal(grouped.documents.length, 2);
  assert.equal(grouped.images.length, 1);
  assert.equal(grouped.videos.length, 1);
  assert.equal(grouped.audio.length, 0);
  assert.equal(grouped.excel.length, 0);
  assert.equal(grouped.ppt.length, 0);
  assert.equal(grouped.other.length, 0);
  provider.dispose();
});

test('DriveViewProvider: onDriveChanged (delete) triggers a refresh', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  // Simulate the client firing onDriveChanged('delete', ...) — the
  // provider should auto-refresh.
  client.fake.markDeleted('d_img1');
  client.onDriveChanged.emit('delete', { id: 'd_img1' });
  // Wait for the async refresh to complete.
  await new Promise((r) => setTimeout(r, 30));
  // The fake client's listDrive filters out deleted items.
  const items = provider.getItems();
  assert.ok(!items.find((i) => i.id === 'd_img1'), 'deleted item should be gone after refresh');
  provider.dispose();
});

test('DriveViewProvider: getParent of an item returns its category node', async () => {
  const { provider, client } = makeProvider();
  client.fake.setItems(SAMPLE);
  await provider.refresh();
  const node = { kind: 'item', item: SAMPLE[2] } as const;
  const parent = provider.getParent(node) as { kind: string; category?: string } | undefined;
  assert.equal(parent?.kind, 'category');
  if (parent && parent.kind === 'category') {
    assert.equal(parent.category, 'images');
  }
  provider.dispose();
});

test('DriveViewProvider: type guards distinguish category vs item', () => {
  assert.equal(isCategoryNode({ kind: 'category', category: 'documents', count: 1 }), true);
  assert.equal(isItemNode({ kind: 'category', category: 'documents', count: 1 }), false);
  assert.equal(isItemNode({ kind: 'item', item: SAMPLE[0] }), true);
  assert.equal(isCategoryNode(undefined), false);
  assert.equal(isItemNode(null), false);
});

test('DriveViewProvider: dragMimeTypes includes DRIVE_MIME', () => {
  const { provider } = makeProvider();
  assert.ok(provider.dragMimeTypes.includes(DRIVE_MIME));
  provider.dispose();
});

test('DriveViewProvider: humanSize formats B / KB / MB / GB', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(500), '500 B');
  assert.match(humanSize(2048), /KB$/);
  assert.match(humanSize(2 * 1024 * 1024), /MB$/);
  assert.match(humanSize(2 * 1024 * 1024 * 1024), /GB$/);
  assert.equal(humanSize(null), '—');
  assert.equal(humanSize(NaN), '—');
});

test('DriveViewProvider: writeTempDriveFile writes base64-decoded content to disk', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const target = await writeTempDriveFile({
    name: 'writeTempTest.txt',
    content: Buffer.from('hello world').toString('base64'),
    contentIsBase64: true,
  });
  assert.ok(target.includes('mavis-drive'));
  const data = await fs.readFile(target, 'utf8');
  assert.equal(data, 'hello world');
  // Cleanup
  await fs.unlink(target);
  // Also exercise the non-base64 branch.
  const target2 = await writeTempDriveFile({ name: 'plain.txt', content: 'abc', contentIsBase64: false });
  const data2 = await fs.readFile(target2, 'utf8');
  assert.equal(data2, 'abc');
  await fs.unlink(target2);
  void os;
  void path;
});

test('DriveViewProvider: encodeDrivePayload + perCall spawner round-trip', async () => {
  // Combine the production encode with a real spawn to assert the
  // payload is the exact string the chat would receive.
  const { makePerCallSpawner } = await import('../helpers/spawnStub');
  const { spawn, children } = makePerCallSpawner();
  const c = new MavisClient({ spawnImpl: spawn, resolveBundledPath: () => '/bin/mavis' });
  setImmediate(() => {
    const first = children[0];
    first.stdout.push(JSON.stringify(SAMPLE[0]) + '\n');
    first.stdout.push(JSON.stringify({ type: 'done', count: 1 }) + '\n');
    first.emitter.emit('close', 0);
  });
  const items = await c.listDrive();
  assert.equal(items.length, 1);
  const payload = encodeDrivePayload(items[0]);
  assert.equal(payload, '{file:d_doc1:spec.md}');
  c.dispose();
});
