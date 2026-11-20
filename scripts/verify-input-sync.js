// End-to-end check for agent -> customer input sync.
//
// Starts a support session, types into the mirror, and asserts that the
// customer's real fields receive focus, caret movement and text:
//
//   * clicking a mirror field focuses it on the customer and rings it
//   * printable keys and live binding
//   * arrow keys and mid-field insertion
//   * Ctrl+A and replacement
//   * Backspace
//   * Enter blurs a single-line field, inserts a newline in a textarea
//   * the mirror shows the same value
//   * clicking or focusing does not scroll the customer's page
//
// Run with both servers up (see README). Exit code is non-zero on failure.
//
//   npm install            # once, in scripts/
//   node verify-input-sync.js
//
// Environment: same as verify-scroll-sync.js.

const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://100.69.0.1:5010';
const AGENT_URL = process.env.AGENT_URL ?? 'http://100.69.0.1:5232/';
const SERVICE_URL = process.env.SERVICE_URL ?? new URL(AGENT_URL).origin;
const TENANT_ID = process.env.TENANT_ID ?? 'demo';
const TENANT_KEY = process.env.TENANT_KEY ?? 'dev-tenant-key';
const HEADLESS = process.env.HEADLESS !== 'false';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;

const failures = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
}

async function cancelLiveRequests() {
  const queue = await fetch(`${SERVICE_URL}/api/v1/agent/queue`).then((r) => r.json());
  const live = [...(queue.pending ?? []), ...(queue.active ?? [])];
  for (const request of live) {
    await fetch(`${SERVICE_URL}/api/v1/support-requests/${request.requestId}/cancel`, {
      method: 'POST',
      headers: {
        'X-Cobrowse-Tenant': TENANT_ID,
        'X-Cobrowse-Key': TENANT_KEY
      }
    });
  }
}

// rrweb replay of inline <script> in a sandboxed mirror is blocked by design.
const isKnownNoise = (text) =>
  /Blocked script execution .* sandboxed/.test(text) ||
  // dotnet watch's browser-refresh socket is local to the dev server.
  /WebSocket connection to 'wss?:\/\/localhost:\d+\//.test(text) ||
  /ERR_CERT_AUTHORITY_INVALID/.test(text);

async function startSession(browser) {
  const customerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const agentContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const customer = await customerContext.newPage();
  const agent = await agentContext.newPage();
  const errors = [];

  customer.on('console', (m) => {
    if (m.type() === 'error' && !isKnownNoise(m.text())) errors.push('customer: ' + m.text());
  });
  agent.on('console', (m) => {
    if (m.type() === 'error' && !isKnownNoise(m.text())) errors.push('agent: ' + m.text());
  });
  customer.on('pageerror', (e) => errors.push('customer pageerror: ' + e.message));
  agent.on('pageerror', (e) => errors.push('agent pageerror: ' + e.message));

  await customer.goto(APP_URL + '/', { waitUntil: 'networkidle' });
  await customer.waitForSelector('button.cbx-support-button', { timeout: 20000 });
  await customer.click('button.cbx-support-button');
  await customer.waitForFunction(
    () => document.querySelector('button.cbx-support-button')?.textContent.includes('Waiting'),
    null, { timeout: 20000 });

  await agent.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await agent.waitForSelector('aside.cb-sessions', { timeout: 20000 });
  await agent.locator('md-filled-tonal-button.cb-accept').first().click();
  await agent.waitForSelector('#cb-mirror', { timeout: 20000 });
  await customer.waitForFunction(
    () => document.querySelector('button.cbx-support-button')?.textContent.includes('connected'),
    null, { timeout: 25000 });

  const frame = agent.frameLocator('#cb-mirror iframe');
  await frame.locator('#sample-name').waitFor({ timeout: 20000 });
  await agent.waitForTimeout(1500);

  return { customerContext, agentContext, customer, agent, frame, errors };
}

async function endSession(customer, agent) {
  await agent.bringToFront();
  const end = agent.locator('md-outlined-button.cb-end').first();
  if (await end.count()) {
    await end.click().catch(() => {});
    await agent.waitForTimeout(900);
  }
  await cancelLiveRequests();
}

const field = (customer, id) => customer.evaluate((fieldId) => {
  const el = document.getElementById(fieldId);
  return {
    value: el?.value ?? null,
    active: document.activeElement?.id ?? '',
    start: el?.selectionStart ?? null
  };
}, id);

(async () => {
  await cancelLiveRequests();
  const launchOptions = { headless: HEADLESS };
  if (CHROMIUM_PATH) launchOptions.executablePath = CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);
  let session;

  try {
    session = await startSession(browser);
    const { customer, agent, frame, errors } = session;

    const placeholderGone = await agent.evaluate(() => !document.querySelector('#cb-mirror > .cb-empty'));
    check('consent placeholder is removed when the replay starts', placeholderGone, true);

    // Click the mirror field. The customer must focus it and show the ring.
    await frame.locator('#sample-name').click();
    await agent.waitForTimeout(400);
    let state = await field(customer, 'sample-name');
    check('click focuses the customer field', state.active, 'sample-name');
    const ring = await customer.evaluate(() => !!document.querySelector('.cbx-focus-ring'));
    check('focus ring is drawn', ring, true);

    // Typing goes through as keystrokes.
    await agent.keyboard.type('Hi!');
    await agent.waitForTimeout(700);
    state = await field(customer, 'sample-name');
    check('typed text reaches the customer', state.value, 'Hi!');
    const greeting = await customer.evaluate(
      () => document.body.innerText.match(/Hello,[^!]*!/)?.[0] ?? '');
    check('live binding follows typing', greeting, 'Hello, Hi!');

    // Arrows move the customer's caret; the next character inserts there.
    await agent.keyboard.press('ArrowLeft');
    await agent.keyboard.press('ArrowLeft');
    await agent.keyboard.type('X');
    await agent.waitForTimeout(700);
    state = await field(customer, 'sample-name');
    check('arrow keys move the caret', state.value, 'HXi!');

    // Ctrl+A and replacement.
    await agent.keyboard.press('Control+a');
    await agent.keyboard.type('Z');
    await agent.waitForTimeout(700);
    state = await field(customer, 'sample-name');
    check('Ctrl+A selects all', state.value, 'Z');

    // Backspace deletes at the customer's caret.
    await agent.keyboard.press('Backspace');
    await agent.waitForTimeout(700);
    state = await field(customer, 'sample-name');
    check('Backspace deletes', state.value, '');

    // Enter blurs a single-line field.
    await agent.keyboard.press('Enter');
    await agent.waitForTimeout(500);
    state = await field(customer, 'sample-name');
    check('Enter blurs the field', state.active === 'sample-name', false);

    // Textarea: Enter inserts a newline and stays focused.
    await frame.locator('#sample-notes').click();
    await agent.waitForTimeout(300);
    await agent.keyboard.type('a');
    await agent.keyboard.press('Enter');
    await agent.keyboard.type('b');
    await agent.waitForTimeout(700);
    const notes = await field(customer, 'sample-notes');
    check('textarea newline is inserted', notes.value, 'a\nb');
    check('textarea keeps focus after Enter', notes.active, 'sample-notes');

    // The mirror shows the same value.
    const mirrorValue = await frame.locator('#sample-notes').inputValue();
    check('mirror value follows', mirrorValue, 'a\nb');

    // The native dropdown opens in the mirror; the chosen option is forwarded.
    await frame.locator('#sample-color').selectOption('danger');
    await agent.waitForTimeout(800);
    const color = await customer.evaluate(() => ({
      value: document.getElementById('sample-color').value,
      label: document.body.innerText.match(/Selected:\s*\w+/)?.[0] ?? ''
    }));
    check('select change reaches the customer', color.value, 'danger');
    check('select label follows', color.label, 'Selected: danger');

    // Focusing a field must not move the customer's page.
    await customer.evaluate(() => window.scrollTo(0, 500));
    await agent.waitForTimeout(500);
    await frame.locator('#sample-name').click();
    await agent.waitForTimeout(500);
    const scrollAfterClick = await customer.evaluate(() => Math.round(scrollY));
    check('click/focus does not auto-scroll the customer', scrollAfterClick, 500);

    // Ending the session releases the agent's focus and ring on the customer.
    await agent.locator('md-outlined-button.cb-end').first().click();
    await agent.waitForTimeout(1000);
    const afterEnd = await customer.evaluate(() => ({
      active: document.activeElement?.id ?? '',
      ring: !!document.querySelector('.cbx-focus-ring')
    }));
    check('focus is released when the session ends', afterEnd.active, '');
    check('focus ring is removed when the session ends', afterEnd.ring, false);

    check('no console errors', errors.join(' | '), '');
  } catch (error) {
    failures.push(error.stack ?? String(error));
    console.error(error);
  } finally {
    if (session) await endSession(session.customer, session.agent);
    await session?.customerContext.close();
    await session?.agentContext.close();
    await browser.close();
    await cancelLiveRequests();
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.error('  ' + failure);
    process.exit(1);
  }
  console.log('All input-sync checks passed.');
})();
