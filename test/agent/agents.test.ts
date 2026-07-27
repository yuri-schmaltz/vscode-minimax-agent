// Tests for the custom agents module (B.8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentTools,
  agentSystemPrompt,
  resolveAgent,
  AgentDefinition,
} from '../../src/agent/agents';
import { getToolManifest } from '../../src/agent/manifest';

const ALL_TOOLS = getToolManifest('builder');

test('agentTools: "all" returns every tool', () => {
  const out = agentTools({ name: 'a', tools: ['all'] }, ALL_TOOLS);
  assert.equal(out.length, ALL_TOOLS.length);
});

test('agentTools: "read" returns only read tools', () => {
  const out = agentTools({ name: 'a', tools: ['read'] }, ALL_TOOLS);
  const names = out.map((t) => t.name).sort();
  assert.deepEqual(names, ['glob', 'grep', 'list_directory', 'read_file']);
});

test('agentTools: "write" returns only write tools', () => {
  const out = agentTools({ name: 'a', tools: ['write'] }, ALL_TOOLS);
  const names = out.map((t) => t.name).sort();
  assert.deepEqual(names, ['edit_file', 'write_file']);
});

test('agentTools: combined "read" + "bash" returns both groups', () => {
  const out = agentTools({ name: 'a', tools: ['read', 'bash'] }, ALL_TOOLS);
  const names = out.map((t) => t.name).sort();
  assert.ok(names.includes('bash'));
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('write_file'));
});

test('agentSystemPrompt: empty when no systemPrompt', () => {
  assert.equal(agentSystemPrompt({ name: 'a' }), '');
  assert.equal(agentSystemPrompt({ name: 'a', systemPrompt: '   ' }), '');
});

test('agentSystemPrompt: prefixes with the agent name when set', () => {
  const out = agentSystemPrompt({
    name: 'tester',
    systemPrompt: 'Always assert something.',
  });
  assert.match(out, /# Agent: tester/);
  assert.match(out, /Always assert something\./);
});

test('resolveAgent: returns the named agent when it exists', () => {
  const list: AgentDefinition[] = [
    { name: 'a', description: '' },
    { name: 'b', description: '' },
  ];
  assert.equal(resolveAgent(list, 'b').name, 'b');
});

test('resolveAgent: returns the first agent when name not found', () => {
  const list: AgentDefinition[] = [
    { name: 'a', description: '' },
    { name: 'b', description: '' },
  ];
  assert.equal(resolveAgent(list, 'nonexistent').name, 'a');
});

test('resolveAgent: returns a sane default when list is empty', () => {
  const def = resolveAgent([], undefined);
  assert.equal(def.name, 'mavis');
});
