// tests/deploy-stages.test.mjs — JOBBY-BL-079, SCN-DF-004: dev, stage, and
// production are named deploy stages, and Kubernetes manifests are not
// required to close #84.
//
// The stage table lives in .cursor/skills/docker-deploy/SKILL.md (loaded from
// .cursor/rules/47-docker-first.mdc). A doc naming three prose headings is not
// itself proof they mean the same thing everywhere, so this also pins the
// per-stage commands: dev is deploy/docker-compose.yml, stage is
// deploy/docker-compose.qa.yml (or a remote host running the same compose
// file), and production explicitly defers Kubernetes manifests rather than
// requiring them for this issue.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\ndeploy stages — dev/stage/production named (JOBBY-BL-079, SCN-DF-004)');

const skillPath = join(ROOT, '.cursor', 'skills', 'docker-deploy', 'SKILL.md');
const rulePath = join(ROOT, '.cursor', 'rules', '47-docker-first.mdc');
const skill = readFileSync(skillPath, 'utf-8');
const rule = readFileSync(rulePath, 'utf-8');

// ── REQ-DF-004: dev, stage, and production are named ────────────────────────
{
  const namesStage = (text) => /\*\*dev\*\*/.test(text) && /\*\*stage\*\*/.test(text) && /\*\*production\*\*/.test(text);
  if (namesStage(skill)) {
    pass('docker-deploy/SKILL.md names dev, stage, and production stages');
  } else {
    fail('docker-deploy/SKILL.md does not name all three stages (dev, stage, production)');
  }
  if (namesStage(rule)) {
    pass('47-docker-first.mdc names dev, stage, and production stages');
  } else {
    fail('47-docker-first.mdc does not name all three stages (dev, stage, production)');
  }
}

// ── dev = local compose (deploy/docker-compose.yml) ─────────────────────────
{
  if (skill.includes('deploy/docker-compose.yml') && existsSync(join(ROOT, 'deploy', 'docker-compose.yml'))) {
    pass('dev stage points at deploy/docker-compose.yml, and the file exists');
  } else {
    fail('dev stage is not tied to an existing deploy/docker-compose.yml');
  }
}

// ── stage = compose.qa or a remote compose host ─────────────────────────────
{
  const staged = /stage.*docker-compose\.qa\.yml|docker-compose\.qa\.yml.*stage/is.test(skill);
  if (staged && existsSync(join(ROOT, 'deploy', 'docker-compose.qa.yml'))) {
    pass('stage points at deploy/docker-compose.qa.yml (or a remote compose host), and the file exists');
  } else {
    fail('stage is not tied to deploy/docker-compose.qa.yml');
  }
}

// ── production = same Dockerfiles; Kubernetes explicitly deferred ──────────
{
  if (/production/i.test(skill) && /[Ss]ame Dockerfiles/.test(skill)) {
    pass('production reuses the same Dockerfiles (no separate production image path)');
  } else {
    fail('production stage does not state it reuses the same Dockerfiles');
  }
}

{
  const defersK8s = /Kubernetes later/i.test(skill) && /not in this issue/i.test(skill);
  if (defersK8s) {
    pass('Kubernetes is explicitly deferred ("Kubernetes later ... not in this issue")');
  } else {
    fail('Kubernetes deferral is not stated — production stage must not require cluster manifests for this issue');
  }
}

// ── Kubernetes manifests are not required to close #84 ──────────────────────
{
  const k8sDir = join(ROOT, 'deploy', 'k8s');
  if (!existsSync(k8sDir)) {
    pass('no deploy/k8s manifests exist — Kubernetes is not required to close #84');
  } else {
    fail('deploy/k8s exists — this issue does not require cluster manifests, so none should have been added here');
  }
}
