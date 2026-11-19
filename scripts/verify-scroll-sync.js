// End-to-end check for two-way scroll sync and cursor anchoring.
//
// Starts a support session from the sample app, accepts it in the agent
// console, then exercises:
//   * customer -> agent scroll
//   * agent "Scroll down" button
//   * agent mouse wheel
//   * wobble: the mirror must hold still after the gesture settles
//   * cursor dot stays under the agent's pointer while the document scrolls
//
// Run with both servers up (see README). Exit code is non-zero on failure.
//
//   npm install            # once, in scripts/
//   node verify-scroll-sync.js
//
// Environment:
//   APP_URL        default http://100.69.0.1:5010
//   AGENT_URL      default http://100.69.0.1:5232/agent
//   SERVICE_URL    default derived from AGENT_URL (origin)
//   TENANT_ID      default demo
//   TENANT_KEY     default dev-tenant-key
//   CHROMIUM_PATH  optional explicit Chromium binary
//   HEADLESS       "false" to watch it run
//
// The scenarios use different viewport sizes on purpose: the mirror is
// rendered at the customer's native size (no scaling), so a size mismatch
// must not affect scroll mapping.

const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://100.69.0.1:5010';
const AGENT_URL = process.env.AGENT_URL ?? 'http://100.69.0.1:5232/agent';
const SERVICE_URL = process.env.SERVICE_URL ?? new URL(AGENT_URL).origin;
const TENANT_ID = process.env.TENANT_ID ?? 'demo';
const TENANT_KEY = process.env.TENANT_KEY ?? 'dev-tenant-key';
const HEADLESS = process.env.HEADLESS !== 'false';
const TOLERANCE = 4;

const failures = [];
const results = [];

function check(name, actual, expected, tolerance = TOLERANCE) {
  const delta = Math.abs(actual - expected);
  const ok = delta <= tolerance;
  results.push({ name, actual, expected, delta, ok });
  if (!ok) failures.push(`${name}: expected ${expected} ±${tolerance}, got ${actual} (Δ${delta})`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual} (expected ${expected}, Δ${delta})`);
}

// The service enforces one live request per user. A request left behind by a
// crashed run reuses its id for the next customer, so the agent console shows
// "Open" instead of "Accept" and the next scenario cannot start. Cancel
// anything live through the tenant API before and after each scenario.
async function cancelLiveRequests() {
  const queue = await fetch(`${SERVICE_URL}/api/v1/agent/queue`).then((r) => r.json());
  const live = [...(queue.pending ?? []), ...(queue.active ?? [])];
  for (const request of live) {
    const response = await fetch(
      `${SERVICE_URL}/api/v1/support-requests/${request.requestId}/cancel`,
      {
        method: 'POST',
        headers: {
          'X-Cobrowse-Tenant': TENANT_ID,
          'X-Cobrowse-Key': TENANT_KEY
        }
      });
    console.log(`  cleanup: cancelled ${request.requestId} (${response.status})`);
  }
}

async function startSession(browser, scenario) {
  const customerContext = await browser.newContext({ viewport: scenario.customer });
  const agentContext = await browser.newContext({ viewport: scenario.agent });
  const customer = await customerContext.newPage();
  const agent = await agentContext.newPage();
  const errors = [];

  customer.on('console', (m) => { if (m.type() === 'error') errors.push('customer: ' + m.text()); });
  agent.on('console', (m) => { if (m.type() === 'error') errors.push('agent: ' + m.text()); });
  customer.on('pageerror', (e) => errors.push('customer pageerror: ' + e.message));
  agent.on('pageerror', (e) => errors.push('agent pageerror: ' + e.message));

  await customer.goto(APP_URL + '/', { waitUntil: 'networkidle' });
  await customer.waitForSelector('button.cbx-support-button', { timeout: 20000 });
  await customer.click('button.cbx-support-button');
  await customer.waitForFunction(
    () => document.querySelector('button.cbx-support-button')?.textContent.includes('Waiting'),
    null, { timeout: 20000 });

  await agent.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await agent.waitForSelector('table.cb-table', { timeout: 20000 });
  await agent.locator('button.cb-btn.primary', { hasText: 'Accept' }).first().click();
  await agent.waitForSelector('#cb-mirror', { timeout: 20000 });
  await customer.waitForFunction(
    () => document.querySelector('button.cbx-support-button')?.textContent.includes('connected'),
    null, { timeout: 25000 });
  await agent.waitForTimeout(2500);

  return { customerContext, agentContext, customer, agent, errors };
}

async function endSession(customer, agent) {
  // End through the console so the real UI path is exercised.
  await agent.bringToFront();
  const end = agent.locator('button.cb-btn.danger', { hasText: 'End session' }).first();
  if (await end.count()) {
    await end.click().catch(() => {});
    await agent.waitForTimeout(900);
  }
  // Fall back to the tenant API if the hub call did not land (for example the
  // page was already disconnected).
  await cancelLiveRequests();
}

// A point that is over the mirror iframe and inside the viewport. The agent
// page may need scrolling first: at small viewports the mirror card sits below
// the fold, and a wheel event outside the viewport goes nowhere.
//
// Use the iframe element, not the wrapper: rrweb's wrapper fills the shell,
// while the iframe keeps the customer's native width. With a narrow customer
// page the wrapper is much wider than the iframe, so a point near the wrapper's
// right edge lands on empty space and no wheel/mousemove reaches the mirror.
async function pointOverMirror(agent) {
  await agent.locator('.cb-mirror-shell').scrollIntoViewIfNeeded().catch(() => {});
  await agent.waitForTimeout(150);
  const viewport = agent.viewportSize();
  const shell = await agent.locator('.cb-mirror-shell').boundingBox();
  const iframe = await agent.locator('#cb-mirror iframe').boundingBox();
  const mirror = iframe ?? await agent.locator('#cb-mirror').boundingBox();
  if (!shell || !mirror) throw new Error('mirror not laid out');

  const left = Math.max(shell.x, mirror.x, 0);
  const top = Math.max(shell.y, mirror.y, 0);
  const right = Math.min(shell.x + shell.width, mirror.x + mirror.width, viewport.width);
  const bottom = Math.min(shell.y + shell.height, mirror.y + mirror.height, viewport.height);
  if (right <= left || bottom <= top) throw new Error('mirror not visible');

  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function mirrorHelpers(agent) {
  const frame = () => {
    const child = agent.frames().find((f) => f !== agent.mainFrame());
    if (!child) throw new Error('mirror iframe not found');
    return child;
  };
  return {
    frame,
    scroll: () => frame().evaluate(() => ({
      top: document.scrollingElement.scrollTop,
      left: document.scrollingElement.scrollLeft,
      max: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight
    })),
    size: () => frame().evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight
    }))
  };
}

async function runScenario(browser, scenario) {
  console.log(`\n=== ${scenario.name} (customer ${scenario.customer.width}x${scenario.customer.height}, agent ${scenario.agent.width}x${scenario.agent.height}) ===`);
  await cancelLiveRequests();
  const { customerContext, agentContext, customer, agent, errors } = await startSession(browser, scenario);
  const mirror = mirrorHelpers(agent);

  const custScroll = () => customer.evaluate(() => window.scrollY);
  const dot = () => customer.evaluate(() => {
    const el = document.querySelector('.cbx-remote-cursor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { docTop: parseFloat(el.style.top), screenTop: r.top, scrollY: window.scrollY };
  });

  try {
    // 1. Customer -> agent. This is the baseline replay path.
    await customer.bringToFront();
    await customer.evaluate(() => window.scrollTo(0, 300));
    await customer.waitForTimeout(600);
    await agent.bringToFront();
    await agent.waitForTimeout(900);
    check('customer->agent scroll', (await mirror.scroll()).top, 300);

    // 2. Agent "Scroll down" button.
    const beforeButton = (await mirror.scroll()).top;
    await agent.locator('button.cb-btn', { hasText: 'Scroll down' }).click();
    await agent.waitForTimeout(900);
    const afterButton = (await mirror.scroll()).top;
    const step = afterButton - beforeButton;
    check('scroll-down moved the mirror', step > 0 ? 1 : 0, 1, 0);
    await customer.bringToFront();
    await customer.waitForTimeout(700);
    check('scroll-down reached the customer', await custScroll(), afterButton);

    // 3. Agent wheel. Move the pointer over the mirror first so the cursor
    //    dot is sent, then scroll up. The mirror is already below the top, so
    //    an upward wheel has room to move.
    await agent.bringToFront();
    const point = await pointOverMirror(agent);
    await agent.mouse.move(point.x, point.y);
    await agent.waitForTimeout(400);
    const beforeWheel = (await mirror.scroll()).top;
    const dotBefore = await dot();
    await agent.mouse.wheel(0, -300);
    await agent.waitForTimeout(1200);
    const afterWheel = (await mirror.scroll()).top;
    check('wheel moved the mirror', beforeWheel - afterWheel, 300, 12);

    // The dot hides 2.5 s after the last cursor message, so read it now,
    // before the wobble sampling below.
    const dotAfter = await dot();

    // 4. Wobble: the mirror must settle and stay put. A replay echo pushing
    //    the mirror back would show up as movement here.
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push((await mirror.scroll()).top);
      await agent.waitForTimeout(150);
    }
    const spread = Math.max(...samples) - Math.min(...samples);
    check('mirror holds still after wheel', spread, 0, 3);

    await customer.bringToFront();
    await customer.waitForTimeout(800);
    check('wheel reached the customer', await custScroll(), afterWheel);

    // 5. Cursor dot. The agent's pointer did not move, so its document
    //    position must follow the scroll while its screen position stays
    //    under the pointer.
    if (dotBefore && dotAfter) {
      check('cursor document position followed the scroll',
        dotBefore.docTop - dotAfter.docTop, beforeWheel - afterWheel, 12);
      check('cursor screen position stayed put',
        dotAfter.screenTop - dotBefore.screenTop, 0, 6);
    } else {
      results.push({ name: 'cursor dot present', actual: 0, expected: 1, delta: 1, ok: false });
      failures.push('cursor dot was not rendered on the customer page');
      console.log('FAIL cursor dot was not rendered on the customer page');
    }

    // 6. The mirror must be the customer's native size. This is the decision
    //    that removed the scale mismatch.
    const size = await mirror.size();
    check('mirror width matches customer viewport', size.width, scenario.customer.width, 2);
    check('mirror height matches customer viewport', size.height, scenario.customer.height, 2);

    check('no console errors', errors.length, 0, 0);
    if (errors.length) console.log('   errors:', errors);
  } finally {
    await endSession(customer, agent);
    await customerContext.close();
    await agentContext.close();
  }
}

(async () => {
  const launchOptions = { headless: HEADLESS };
  if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);

  try {
    const scenarios = [
      {
        name: 'same size',
        customer: { width: 1280, height: 900 },
        agent: { width: 1280, height: 900 }
      },
      {
        name: 'agent smaller than customer',
        customer: { width: 1280, height: 900 },
        agent: { width: 800, height: 600 }
      },
      {
        name: 'agent larger than customer',
        customer: { width: 390, height: 844 },
        agent: { width: 1280, height: 900 }
      }
    ];

    for (const scenario of scenarios) {
      await runScenario(browser, scenario);
    }
  } finally {
    await browser.close();
  }

  console.log('\n--- summary ---');
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\nall checks passed');
})().catch((error) => {
  console.error('FAILED', error);
  process.exit(1);
});
