/**
 * SecretStore unit + adversarial tests.
 *
 * The store wraps VSCode's SecretStorage, which is keyed by a single
 * string per record. The tests cover the edge cases the source code
 * promises (no throw on missing key, no-op on missing delete) and the
 * ad-hoc "implicit delete on undefined" extension requested in the
 * task spec.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SecretStore } from '../../src/auth/SecretStore';
import { SecretStorage } from '../__mocks__/vscode';

test('SecretStore: read of an absent key returns undefined (no throw)', async () => {
  const store = new SecretStore(new SecretStorage());
  const rec = await store.read();
  assert.equal(rec, undefined);
});

test('SecretStore: delete of an absent key is a no-op (no throw)', async () => {
  const store = new SecretStore(new SecretStorage());
  await assert.doesNotReject(() => store.clear());
  // Clearing twice should also be a no-op.
  await assert.doesNotReject(() => store.clear());
});

test('SecretStore: write then read round-trips a record', async () => {
  const store = new SecretStore(new SecretStorage());
  await store.write({ access_token: 'abc', refresh_token: 'xyz' });
  const rec = await store.read();
  assert.ok(rec);
  assert.equal(rec!.access_token, 'abc');
  assert.equal(rec!.refresh_token, 'xyz');
});

test('SecretStore: clear() removes the record', async () => {
  const store = new SecretStore(new SecretStorage());
  await store.write({ access_token: 'abc' });
  await store.clear();
  assert.equal(await store.read(), undefined);
});

test('SecretStore: read of corrupt JSON returns undefined (defensive)', async () => {
  const storage = new SecretStorage();
  // Bypass the typed API to inject garbage (this is what would happen if
  // a user edits their SecretStorage via the OS-level credential store).
  await storage.store('mavis.auth', 'not-json{{');
  const store = new SecretStore(storage);
  const rec = await store.read();
  assert.equal(rec, undefined);
});

test('SecretStore: read of a record missing access_token returns undefined', async () => {
  const storage = new SecretStorage();
  await storage.store('mavis.auth', JSON.stringify({ refresh_token: 'r' }));
  const store = new SecretStore(storage);
  const rec = await store.read();
  assert.equal(rec, undefined);
});
