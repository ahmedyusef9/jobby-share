import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as yamlModule from 'js-yaml';

const yaml = yamlModule.default || yamlModule;
const adapter = yaml.load(readFileSync('qa/project.yml', 'utf8'));

test('QA project adapter points at real portable-agent inputs', () => {
  assert.equal(adapter.version, 1);
  assert.equal(adapter.product, 'jobby');
  for (const file of [
    adapter.requirements.manifest,
    adapter.requirements.performance_budgets,
    adapter.browser.mcp_config,
    adapter.automation.config,
    adapter.credentials.contract,
    '.agents/skills/qa-manual-automation/SKILL.md',
  ]) {
    assert.ok(existsSync(file), `${file} should exist`);
  }
});

test('attended exploration and permanent automation are separate execution paths', () => {
  assert.equal(adapter.browser.attended_mcp, 'playwright');
  assert.equal(adapter.browser.attended_mode, 'extension');
  assert.equal(adapter.automation.runner, 'playwright');
  assert.match(adapter.automation.commands.test, /test:e2e/);
  assert.match(adapter.automation.commands.coverage, /qa:coverage/);
});

test('portable templates keep project-specific values explicit', () => {
  const template = readFileSync('qa/templates/project.yml', 'utf8');
  assert.match(template, /<product-name>/);
  assert.match(template, /<BASE_URL_ENV>/);
  assert.ok(existsSync('qa/templates/features.yml'));
});
