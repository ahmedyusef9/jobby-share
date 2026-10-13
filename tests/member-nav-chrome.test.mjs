// tests/member-nav-chrome.test.mjs — JOBBY-BL-094: member primary nav is
// Today, Explore, Pipeline, CV, Rules, MCP; Workers/Portals/Profiles/
// Analytics/Config/Admin/Access are operator-only, and the operator-only
// *routes* (not just the nav links) 404 for a member.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, finish, ROOT } from './helpers.mjs';

console.log('\nmember nav chrome — source contract (JOBBY-BL-094)');

const navItems = readFileSync(join(ROOT, 'web/src/lib/nav-items.ts'), 'utf8');
const appShell = readFileSync(join(ROOT, 'web/src/components/app-shell.tsx'), 'utf8');
const mobileNav = readFileSync(join(ROOT, 'web/src/components/mobile-nav.tsx'), 'utf8');
const jobsList = readFileSync(join(ROOT, 'web/src/app/jobs/page.tsx'), 'utf8');
const jobDetail = readFileSync(join(ROOT, 'web/src/app/jobs/[id]/page.tsx'), 'utf8');
const portals = readFileSync(join(ROOT, 'web/src/app/portals/page.tsx'), 'utf8');
const admin = readFileSync(join(ROOT, 'web/src/app/admin/page.tsx'), 'utf8');
const adminRbac = readFileSync(join(ROOT, 'web/src/app/admin/rbac/page.tsx'), 'utf8');
const configPage = readFileSync(join(ROOT, 'web/src/app/config/page.tsx'), 'utf8');

// REQ-NV-001 / SCN-NV-001: member primary nav hides exactly the operator-only
// set (Workers/jobs, Portals, Profiles/search-profiles, Analytics, Config).
{
  const hiddenSetMatch = navItems.match(/MEMBER_HIDDEN_HREFS = new Set<string>\(\[([^\]]+)\]\)/);
  const hidden = hiddenSetMatch ? hiddenSetMatch[1] : '';
  const mustHide = ['/jobs', '/portals', '/search-profiles', '/analytics', '/config'];
  const allHidden = mustHide.every((h) => hidden.includes(`"${h}"`));
  const bothConsumers = /useVisibleNavItems/.test(appShell) && /useVisibleNavItems/.test(mobileNav);
  if (allHidden && bothConsumers) {
    pass('member nav hides Workers/Portals/Profiles/Analytics/Config; both shells consume useVisibleNavItems');
  } else {
    fail('useVisibleNavItems must hide the full operator-only set, and both nav shells must use it (REQ-NV-001)');
  }
}

// REQ-NV-001 / SCN-NV-004: the hook defaults to the restricted list until
// operator is confirmed — never flashes operator chrome to a member.
{
  if (/useState\(false\)/.test(navItems.slice(navItems.indexOf('useVisibleNavItems')))) {
    pass('useVisibleNavItems fails closed (restricted by default) until operator is confirmed');
  } else {
    fail('useVisibleNavItems must default to the restricted nav, not fail open (REQ-NV-001)');
  }
}

// REQ-NV-002 / SCN-NV-002: /portals and /admin* 404 (not 403) for non-operators.
for (const [name, src] of [['portals', portals], ['admin', admin], ['admin/rbac', adminRbac]]) {
  if (/notFound\(\)/.test(src) && (/isOperator\(/.test(src) || /CAP\.ADMIN/.test(src))) {
    pass(`${name} 404s for non-operators server-side`);
  } else {
    fail(`${name}/page.tsx must notFound() a non-operator before rendering (REQ-NV-002)`);
  }
}

// REQ-NV-002: /jobs (Workers list) 404s for a member — client-side gate,
// fails closed (renders nothing) while the check is in flight.
{
  if (
    /access === "loading"\) return null/.test(jobsList) &&
    /access === "member"\) notFound\(\)/.test(jobsList) &&
    /setAccess\("member"\)/.test(jobsList)
  ) {
    pass('/jobs list gates on confirmed operator, fails closed while loading and on fetch error');
  } else {
    fail('/jobs must 404 a member client-side without flashing the list (REQ-NV-002)');
  }
}

// REQ-NS-002 follow-up (found while building this issue): /jobs/[id] stays
// reachable for a member's own pdf/research jobs, but Retry must not
// resurrect a legacy evaluate-kind job for a non-operator.
{
  if (/job\.kind === "evaluate" && isOperator/.test(jobDetail)) {
    pass('/jobs/[id] Retry excludes evaluate-kind jobs for non-operators');
  } else {
    fail('/jobs/[id] canRetry must require isOperator for kind === "evaluate" (REQ-NS-002 follow-up)');
  }
}

// D-036(2): /config stays a reachable degraded page for members, not a 404 —
// only the nav *link* is operator-only. Confirms this deliberate divergence
// from REQ-NV-002's literal text wasn't silently reverted.
{
  if (!/notFound\(\)/.test(configPage)) {
    pass('/config route itself is not 404-gated (D-036/2 keeps it a keyless page for members)');
  } else {
    fail('/config must stay reachable and degraded for members, not 404 (D-036/2 supersedes REQ-NV-002 here)');
  }
}

finish();
