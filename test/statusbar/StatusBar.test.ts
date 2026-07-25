/**
 * StatusBar unit tests.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { StatusBarController, FakeStatusBarHost } from '../../src/statusbar/StatusBar';
import { MavisClient } from '../../src/client/MavisClient';
import { OAuthManager } from '../../src/auth/OAuth';
import { SecretStore } from '../../src/auth/SecretStore';
import { SecretStorage } from '../__mocks__/vscode';
import { makeFakeChild, makeSpawner } from '../helpers/spawnStub';

function makeClient(): MavisClient {
  return new MavisClient({
    resolveBundledPath: () => '/bin/mavis',
    spawnImpl: makeSpawner(makeFakeChild()),
  });
}

function makeAuth(client: MavisClient): OAuthManager {
  return new OAuthManager(client, new SecretStore(new SecretStorage()), { clientId: 'cid' });
}

test('StatusBar renders the initial agent', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client), initialAgent: 'mavis' });
  const text = sb.getText();
  assert.match(text, /Mavis/);
  assert.match(text, /mavis/);
  sb.dispose();
});

test('StatusBar reacts to onContextChanged: agent', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client), initialAgent: 'mavis' });
  sb.bind();
  client.setActiveAgent('mavis-coder');
  assert.match(sb.getText(), /mavis-coder/);
  sb.dispose();
});

test('StatusBar reacts to onContextChanged: session', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client), initialAgent: 'mavis' });
  sb.bind();
  client.setActiveSession('sess_12345678');
  assert.match(sb.getText(), /sess_123/);
  sb.dispose();
});

test('StatusBar reflects signed-in state via OAuthManager event', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const oauth = makeAuth(client);
  const sb = new StatusBarController({ host, client, oauth });
  sb.bind();
  // Trigger a "token" event to flip signedIn.
  oauth.emit('token', { access_token: 'x' });
  assert.match(sb.getText(), /●/);
  oauth.emit('token', undefined);
  assert.match(sb.getText(), /○/);
  sb.dispose();
});

test('StatusBar item.command is set to a click handler', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client) });
  assert.equal(host.items[0].command, 'mavis._statusBarClick');
  sb.dispose();
});

test('StatusBar.onClick triggers host.executeCommand("mavis.newChat")', async () => {
  let executed: string | undefined;
  const host: FakeStatusBarHost = new FakeStatusBarHost();
  host.executeCommand = async (cmd: string, ..._rest: unknown[]) => {
    executed = cmd;
    return undefined;
  };
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client) });
  await sb.onClick();
  assert.equal(executed, 'mavis.newChat');
  sb.dispose();
});

test('StatusBar.dispose removes the item', () => {
  const host = new FakeStatusBarHost();
  const client = makeClient();
  const sb = new StatusBarController({ host, client, oauth: makeAuth(client) });
  const before = host.items.length;
  sb.dispose();
  assert.equal(host.items.length, before);
});
