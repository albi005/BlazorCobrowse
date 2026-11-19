// End-to-end check that every sample-app control replicates in both
// directions:
//
//   agent -> customer: buttons, checkbox, radio, select, range, typing, list
//                      add/remove, submit
//   customer -> agent: value/checked changes mirrored back over rrweb
//
// Run with both servers up (see README). Exit code is non-zero on failure.
//
//   npm install            # once, in scripts/
//   node verify-interactions.js
//
// Environment: same as verify-scroll-sync.js.

const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://100.69.0.1:5010';
const AGENT_URL = process.env.AGENT_URL ?? 'http://100.69.0.1:5232/agent';
const SERVICE_URL = process.env.SERVICE_URL ?? new URL(AGENT_URL).origin;
const TENANT_ID = process.env.TENANT_ID ?? 'demo';
const TENANT_KEY = process.env.TENANT_KEY ?? 'dev-tenant-key';
const HEADLESS = process.env.HEADLESS !== 'false';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;

const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`);
}

async function until(fn, timeout = 6000, interval = 100) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out; last=${JSON.stringify(last)}`);
}

async function cancelLiveRequests() {
  const queue = await fetch(`${SERVICE_URL}/api/v1/agent/queue`).then((r) => r.json());
  const live = [...(queue.pending ?? []), ...(queue.active ?? [])];
  for (const request of live) {
    await fetch(`${SERVICE_URL}/api/v1/support-requests/${request.requestId}/cancel`, {
      method: 'POST',
      headers: { 'X-Cobrowse-Tenant': TENANT_ID, 'X-Cobrowse-Key': TENANT_KEY }
    });
  }
}

const isKnownNoise = (text) => /Blocked script execution .* sandboxed/.test(text);

async function startSession(browser) {
  // A tall viewport keeps the whole mirror visible, including the range.
  const customerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const agentContext = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
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
  await agent.waitForSelector('table.cb-table', { timeout: 20000 });
  await agent.locator('button.cb-btn.primary', { hasText: 'Accept' }).first().click();
  await agent.waitForSelector('#cb-mirror', { timeout: 20000 });
  await customer.waitForFunction(
    () => document.querySelector('button.cbx-support-button')?.textContent.includes('connected'),
    null, { timeout: 25000 });

  const mirrorFrame = await until(() => agent.frames().find((f) => f !== agent.mainFrame()));
  await mirrorFrame.locator('#sample-name').waitFor({ timeout: 20000 });
  await agent.waitForTimeout(1500);

  return { customerContext, agentContext, customer, agent, mirrorFrame, errors };
}

async function endSession(session) {
  const { agent } = session;
  await agent.bringToFront();
  const end = agent.locator('button.cb-btn.danger', { hasText: 'End session' }).first();
  if (await end.count()) {
    await end.click().catch(() => {});
    await agent.waitForTimeout(900);
  }
  await cancelLiveRequests();
}

const customerState = (customer) => customer.evaluate(() => ({
  name: document.getElementById('sample-name').value,
  notes: document.getElementById('sample-notes').value,
  counter: [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '+')?.parentElement.textContent.replace(/\s+/g, ' ').trim(),
  subscribe: document.getElementById('sample-subscribe').checked,
  contact: document.getElementById('contact-phone').checked,
  color: document.getElementById('sample-color').value,
  range: document.getElementById('sample-range').value,
  body: document.body.innerText,
  items: [...document.querySelectorAll('ul.list-group li span')].map((n) => n.textContent.trim())
}));

const mirrorState = (frame) => frame.evaluate(() => ({
  name: document.querySelector('#sample-name')?.value,
  counter: [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '+')?.parentElement.textContent.replace(/\s+/g, ' ').trim(),
  subscribe: document.querySelector('#sample-subscribe')?.checked,
  contact: document.querySelector('#contact-phone')?.checked,
  color: document.querySelector('#sample-color')?.value,
  range: document.querySelector('#sample-range')?.value,
  body: document.body.innerText,
  items: [...document.querySelectorAll('ul.list-group li span')].map((n) => n.textContent.trim())
}));

(async () => {
  await cancelLiveRequests();
  const launchOptions = { headless: HEADLESS };
  if (CHROMIUM_PATH) launchOptions.executablePath = CHROMIUM_PATH;
  const browser = await chromium.launch(launchOptions);
  let session;

  try {
    session = await startSession(browser);
    const { customer, agent, mirrorFrame: mf, errors } = session;

    console.log('\n--- customer cursor ---');
    await customer.mouse.move(520, 320);
    // rrweb samples mousemove every 50ms and drops the trailing sample.
    await agent.waitForTimeout(120);
    await customer.mouse.move(560, 340);
    const seen = await until(() => mf.evaluate(() => {
      const el = document.querySelector('[data-cb-customer-cursor]');
      return el && el.style.opacity === '1' ? true : null;
    }), 4000).catch(() => null);
    check('customer cursor appears in the mirror', !!seen, true);

    const cursor = await until(() => mf.evaluate(() => {
      const el = document.querySelector('[data-cb-customer-cursor]');
      if (!el || el.style.opacity !== '1') return null;
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      return Math.abs(left - 560) <= 4 && Math.abs(top - 340) <= 4 ? { left, top } : null;
    }), 4000).catch(() => null);
    check('customer cursor position matches', !!cursor, true);

    console.log('\n--- agent -> customer ---');

    // Counter: two clicks and reset.
    await mf.getByRole('button', { name: '+', exact: true }).click();
    await mf.getByRole('button', { name: '+', exact: true }).click();
    await agent.waitForTimeout(700);
    let cs = await customerState(customer);
    check('agent + twice reaches the customer', cs.counter, '− 2 + Reset');
    let ms = await mirrorState(mf);
    check('counter is mirrored back', ms.counter, '− 2 + Reset');

    await mf.getByRole('button', { name: 'Reset', exact: true }).click();
    await agent.waitForTimeout(700);
    cs = await customerState(customer);
    check('agent Reset reaches the customer', cs.counter, '− 0 + Reset');

    // Checkbox.
    await mf.locator('#sample-subscribe').click();
    await agent.waitForTimeout(700);
    cs = await customerState(customer);
    check('agent checkbox reaches the customer', cs.subscribe, true);
    check('checkbox label follows', cs.body.includes('Subscribed.'), true);
    ms = await mirrorState(mf);
    check('checkbox is mirrored back', ms.subscribe, true);

    // Radio.
    await mf.locator('#contact-phone').click();
    await agent.waitForTimeout(700);
    cs = await customerState(customer);
    check('agent radio reaches the customer', cs.contact, true);
    check('radio label follows', cs.body.includes('Preferred: phone'), true);
    ms = await mirrorState(mf);
    check('radio is mirrored back', ms.contact, true);

    // Select.
    await mf.locator('#sample-color').selectOption('danger');
    await agent.waitForTimeout(700);
    cs = await customerState(customer);
    check('agent select reaches the customer', cs.color, 'danger');
    ms = await mirrorState(mf);
    check('select is mirrored back', ms.color, 'danger');

    // Range: a real click inside the track sets the value.
    const range = mf.locator('#sample-range');
    await range.scrollIntoViewIfNeeded();
    const box = await range.boundingBox();
    if (!box) throw new Error('range has no bounding box');
    await agent.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
    await agent.waitForTimeout(900);
    cs = await customerState(customer);
    check('agent range click reached the customer', cs.range !== '7', true);
    check('range label follows', new RegExp(`Satisfaction: ${cs.range}/10`).test(cs.body), true);
    ms = await mirrorState(mf);
    check('range is mirrored back', ms.range, cs.range);

    // Typing.
    await mf.locator('#sample-name').click();
    await agent.keyboard.type('Ada');
    await agent.waitForTimeout(700);
    cs = await customerState(customer);
    check('agent typing reaches the customer', cs.name, 'Ada');
    ms = await mirrorState(mf);
    check('typed name is mirrored back', ms.name, 'Ada');

    // List: add then remove.
    await mf.locator('input[placeholder="New item…"]').click();
    await agent.keyboard.type('Third item');
    await agent.waitForTimeout(500);
    await mf.getByRole('button', { name: 'Add', exact: true }).click();
    await agent.waitForTimeout(900);
    cs = await customerState(customer);
    check('agent Add reaches the customer', cs.items.join('|'), 'First item|Second item|Third item');
    ms = await mirrorState(mf);
    check('added item is mirrored back', ms.items.join('|'), 'First item|Second item|Third item');

    await mf.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await agent.waitForTimeout(900);
    cs = await customerState(customer);
    check('agent Remove reaches the customer', cs.items.join('|'), 'Second item|Third item');

    // Submit uses the current name and satisfaction.
    await mf.getByRole('button', { name: 'Submit feedback', exact: true }).click();
    await agent.waitForTimeout(900);
    cs = await customerState(customer);
    check('submit reaches the customer', /Submitted at/.test(cs.body), true);
    check('submit uses the typed name', cs.body.includes('Name: Ada'), true);

    // The older toolbar path still replaces a field's value.
    await mf.locator('#sample-notes').click();
    await agent.locator('#cb-type-input').fill('Sent from the toolbar');
    await agent.locator('button.cb-btn', { hasText: 'Send text' }).click();
    await agent.waitForTimeout(900);
    cs = await customerState(customer);
    check('Send text toolbar reaches the customer', cs.notes, 'Sent from the toolbar');

    console.log('\n--- customer -> agent ---');

    await customer.locator('#sample-name').fill('Grace');
    await customer.locator('#sample-subscribe').setChecked(false);
    await customer.locator('#contact-email').check();
    await customer.locator('#sample-color').selectOption('success');
    await customer.evaluate(() => {
      const range = document.getElementById('sample-range');
      range.value = '9';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await customer.getByRole('button', { name: '+', exact: true }).click();
    await customer.locator('input[placeholder="New item…"]').fill('Fourth item');
    await customer.getByRole('button', { name: 'Add', exact: true }).click();
    await agent.waitForTimeout(1200);

    ms = await mirrorState(mf);
    check('customer typing is mirrored', ms.name, 'Grace');
    check('customer checkbox is mirrored', ms.subscribe, false);
    check('customer radio is mirrored', ms.contact, false);
    check('customer select is mirrored', ms.color, 'success');
    check('customer range is mirrored', ms.range, '9');
    check('customer counter is mirrored', ms.counter, '− 1 + Reset');
    check('customer list add is mirrored', ms.items.join('|'), 'Second item|Third item|Fourth item');

    // Hidden/occluded tabs have their 60ms timers clamped to ~1s. The batcher
    // must flush from a microtask there, or agent feedback takes a second.
    console.log('\n--- inner scroll container ---');
    const scrollDown = agent.locator('button.cb-btn', { hasText: 'Scroll down' });
    const frameBox = await agent.locator('#cb-mirror iframe').boundingBox();
    let scrollerBox = null;
    for (let i = 0; i < 6; i++) {
      scrollerBox = await mf.locator('#sample-scroller').boundingBox();
      if (scrollerBox && frameBox &&
          scrollerBox.y >= frameBox.y &&
          scrollerBox.y + scrollerBox.height <= frameBox.y + frameBox.height) {
        break;
      }
      await scrollDown.click();
      await agent.waitForTimeout(500);
    }
    check('scroll container is visible in the mirror', !!scrollerBox, true);

    const pageBefore = await customer.evaluate(() => Math.round(scrollY));
    await agent.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + 40);
    await agent.mouse.wheel(0, 160);
    const containerTop = await until(
      () => customer.evaluate(() => document.getElementById('sample-scroller').scrollTop || 0),
      3000).catch(() => 0);
    check('agent wheel scrolls the inner container', containerTop > 0, true);
    const pageAfter = await customer.evaluate(() => Math.round(scrollY));
    check('inner scroll leaves the page alone', Math.abs(pageAfter - pageBefore) <= 6, true);

    const mirrorTop = await until(
      async () => (await mf.evaluate(() => document.getElementById('sample-scroller').scrollTop)) || 0,
      3000).catch(() => 0);
    check('inner scroll is mirrored back', Math.abs(mirrorTop - containerTop) <= 4, true);

    // Let the 600ms agent-gesture echo guard expire before driving from the
    // customer side.
    await agent.waitForTimeout(700);
    await customer.evaluate(() => {
      const el = document.getElementById('sample-scroller');
      el.scrollTop = 300;
      el.dispatchEvent(new Event('scroll'));
    });
    const customerTop = await until(
      async () => {
        const top = await mf.evaluate(() => document.getElementById('sample-scroller').scrollTop);
        return Math.abs(top - 300) <= 4 ? top : 0;
      }, 3000).catch(() => -1);
    check('customer inner scroll is mirrored', customerTop, 300);

    // Hidden/occluded tabs have their 60ms timers clamped to ~1s. The batcher
    // must flush from a microtask there, or agent feedback takes a second.
    console.log('\n--- hidden tab latency ---');
    await customer.evaluate(() => {
      const orig = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => orig(fn, ms === 60 ? 1000 : ms, ...args);
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    const startedAt = Date.now();
    await mf.getByRole('button', { name: '+', exact: true }).click();
    const arrived = await until(async () => (await mirrorState(mf)).counter === '− 2 + Reset', 1500)
      .catch(() => null);
    const elapsed = Date.now() - startedAt;
    check('feedback survives a throttled hidden tab', !!arrived, true);
    check('hidden-tab feedback is not delayed to 1s', elapsed < 500, true);

    check('no console errors', errors.join(' | '), '');
  } catch (error) {
    failures.push(error.stack ?? String(error));
    console.error(error);
  } finally {
    if (session) await endSession(session);
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
  console.log('All interaction checks passed.');
})();
