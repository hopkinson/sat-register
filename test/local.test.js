const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fork } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const satregApi = require('../satreg-api-client');

const root = path.resolve(__dirname, '..');
const engineSource = fs.readFileSync(path.join(root, 'sat-engine.js'), 'utf8');
const emptyDB = () => ({ tasks: [], logs: {}, stats: { totalPolls: 0, totalLocks: 0 }, settings: {} });

test('center cards: scoped slots, disabled slots and missing targets', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const engine = loadEngine();
  await page.setContent('<section><h3>Zone A</h3><span>62250</span><div><p>No seats available.</p></div></section><section><h3>Zone B</h3><span>62251</span><div><a role="button" id="qc-id-tc-select-button-1-3025">8 a.m.</a></div></section>');
  assert.equal((await engine.inspectCenters(page, ['62250', 'Zone A'])).status, 'unavailable');
  const found = await engine.inspectCenters(page, ['62251']);
  assert.equal(found.status, 'available');
  assert.equal(found.matchedCenter, 'Zone B');
  assert.equal(await found.selectTargetBtn.innerText(), '8 a.m.');
  await found.selectTargetBtn.dispose();
  const any = await engine.inspectCenters(page, []);
  assert.equal(any.status, 'available');
  await any.selectTargetBtn.dispose();
  assert.equal((await engine.inspectCenters(page, ['99999'])).status, 'unknown');
  await page.locator('section').first().locator('span').evaluate(el => el.remove());
  assert.equal((await engine.inspectCenters(page, ['62250', 'Zone A'])).status, 'unavailable');
  assert.equal((await engine.inspectCenters(page, ['62250'])).status, 'unknown');
  await page.locator('a').evaluate(el => el.setAttribute('aria-disabled', 'true'));
  assert.equal((await engine.inspectCenters(page, ['62251'])).status, 'unknown');
});

test('queries reject stale results and failed responses; wait for new card rendering', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const engine = loadEngine();
  let mode = 'fresh';
  await page.route('https://satreg.collegeboard.org/**', route => {
    if (route.request().url().endsWith('/api/test-centers')) return route.fulfill({ status: mode === 'failed' ? 500 : 200, contentType: 'application/json', body: '{}' });
    return route.fulfill({ contentType: 'text/html', body: `<div hidden><button>Find a Test Center</button></div><button id="test-center-country-find-button-enabled">Find a Test Center</button><main><section><h3>Zone A</h3><span>62250</span><p>No seats available.</p></section></main><script>
      document.querySelector('#test-center-country-find-button-enabled').onclick = async function() {
        this.disabled = true;
        const response = await fetch('/api/test-centers');
        this.disabled = false;
        if (response.ok && ${JSON.stringify(mode)} === 'fresh') setTimeout(() => {
          document.querySelector('main').innerHTML = '<section><h3>Zone A</h3><span>62250</span><a role="button" id="qc-id-tc-select-button-0-1">8 a.m.</a></section>';
        }, 600);
      };
    </script>` });
  });
  await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  const fresh = await engine.queryCenters(page, ['62250'], 2500);
  assert.equal(fresh.status, 'available', JSON.stringify(fresh) + await page.locator('main').innerHTML());
  await fresh.selectTargetBtn.dispose();
  for (mode of ['stale', 'failed']) {
    await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
    assert.equal((await engine.queryCenters(page, ['62250'], 700)).status, 'unknown', mode);
  }
  mode = 'fresh';
  await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  await page.evaluate(() => {
    document.querySelector('#test-center-country-find-button-enabled').onclick = async () => {
      await fetch('/api/test-centers');
      document.querySelector('main').innerHTML = '<section><h3>Zone A</h3><span>62250</span><p>No seats available.</p></section>';
    };
  });
  assert.equal((await engine.queryCenters(page, ['62250'], 1500)).status, 'unavailable');
  await page.setContent('<h1>Sign in</h1>');
  assert.equal((await engine.queryCenters(page, ['62250'], 700)).status, 'unknown');
});

test('repeated identical center results are trusted even when the DOM does not re-render', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const engine = loadEngine();
  for (const seatState of ['available', 'unavailable']) await t.test(seatState, async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://satreg.collegeboard.org/**', route => {
        if (route.request().url().endsWith('/api/test-centers')) return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ testCenters: [{ tcCd: '62250', tcName: 'Zone A', seatAvailable: seatState === 'available' }] })
        });
        const card = seatState === 'available'
          ? '<section><h3>Zone A</h3><span>62250</span><a role="button" id="qc-id-tc-select-button-0-1">8 a.m.</a></section>'
          : '<section><h3>Zone A</h3><span>62250</span><p>No seats available.</p></section>';
        const script = '<main></main><button id="test-center-country-find-button-enabled">Find a Test Center</button><script>' +
          'let calls = 0;' +
          'document.querySelector("#test-center-country-find-button-enabled").onclick = async function() {' +
          '  await fetch("/api/test-centers");' +
          '  if (calls++ === 0) setTimeout(() => { document.querySelector("main").innerHTML = ' + JSON.stringify(card) + '; }, 300);' +
          '};' +
          '</scr' + 'ipt>';
        return route.fulfill({ contentType: 'text/html', body: script });
      });
      await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
      const first = await engine.queryCenters(page, ['62250'], 3000);
      assert.equal(first.status, seatState, JSON.stringify(first));
      if (first.selectTargetBtn) await first.selectTargetBtn.dispose();
      const second = await engine.queryCenters(page, ['62250'], 3000);
      assert.equal(second.status, seatState, JSON.stringify(second));
      if (second.selectTargetBtn) await second.selectTargetBtn.dispose();
    } finally { await page.close(); }
  });
});

test('query retries the same search when the first response renders no cards', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const engine = loadEngine();
  await page.route('https://satreg.collegeboard.org/**', route => {
    if (route.request().url().endsWith('/api/test-centers')) return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ testCenters: [{ tcCd: '62250', tcName: 'Zone A', seatAvailable: false }] })
    });
    return route.fulfill({ contentType: 'text/html', body: '<main></main><button id="test-center-country-find-button-enabled">Find a Test Center</button><script>' +
      'let calls = 0;' +
      'document.querySelector("#test-center-country-find-button-enabled").onclick = async function() {' +
      '  const first = calls++ === 0;' +
      '  await fetch(first ? "/api/empty" : "/api/test-centers");' +
      '  if (!first) setTimeout(() => { document.querySelector("main").innerHTML = ' +
      JSON.stringify('<section><h3>Zone A</h3><span>62250</span><p>No seats available.</p></section>') + '; }, 250);' +
      '};' +
      '</scr' + 'ipt>' });
  });
  await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  const logs = [];
  const result = await engine.queryCenters(page, ['62250'], 1500, message => logs.push(message));
  assert.equal(result.status, 'unavailable', JSON.stringify(result) + logs.join('|'));
  assert.ok(logs.some(message => /重试同一查询/.test(message)), logs.join('|'));
});

function loadEngine(browserDriver = chromium, settings = { satAccount: 'global@example.invalid', satPassword: 'fixture-global' }, queryFixture) {
  const module = { exports: {} };
  vm.runInNewContext(engineSource + '\nmodule.exports.solveHCaptcha = solveHCaptchaOnce; module.exports.clickWizardControl = clickWizardControl;\nif (queryFixture) queryTestCenters = queryFixture; module.exports.wizard = handleRegistrationWizardPrerequisites; module.exports.inspectCenters = inspectTestCenters; module.exports.queryCenters = queryTestCenters; module.exports.selectDate = ensureOnTestCenterSearchForm; module.exports.postSelection = handlePostLockProcess; module.exports.attemptSelection = attemptSelection; module.exports.solveCaptcha = solveCaptchaOnce; module.exports.extractArkosePublicKey = extractArkosePublicKey; module.exports.queryCentersViaApi = queryTestCentersViaApi; module.exports.watchAdmins = watchTestCenterAdmins;', {
    module, require: name => name === 'playwright' ? { chromium: browserDriver } : name === 'fs' ? { ...fs, existsSync: file => file === path.join(os.tmpdir(), 'data', 'db.json'), readFileSync: () => JSON.stringify({ settings }) } : require(name === './yescaptcha-solver' || name === './satreg-api-client' ? path.join(root, name) : name),
    queryFixture, __dirname: os.tmpdir(), process: { env: {} }, console, setTimeout, clearTimeout, queueMicrotask, Date, URL
  });
  return module.exports;
}

async function fixture(t, db = emptyDB(), raw, workerSource, upstreamSource = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-local-test-'));
  for (const file of ['server.js', 'sat-engine.js', 'satreg-api-client.js', 'yescaptcha-solver.js']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  if (workerSource) fs.writeFileSync(path.join(dir, 'sat-engine.js'), workerSource);
  fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/db.json'), raw ?? JSON.stringify(db));
  // IPC only exists in the fixture, so tests can exercise the real shutdown handler on Windows.
  fs.writeFileSync(path.join(dir, 'boot.js'), upstreamSource + "\nprocess.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); }); require('./server');");
  const child = fork(path.join(dir, 'boot.js'), [], {
    cwd: dir, env: { ...process.env, PORT: '0', NODE_PATH: path.join(root, 'node_modules'), SAT_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (child.connected) child.send('stop');
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  if (raw !== undefined) {
    await once(child, 'exit');
    return { dir, child, output: () => output };
  }
  for (let i = 0; i < 100; i++) {
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      const base = match[0];
      const request = async (url, method = 'GET', body, headers = {}) => {
        const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        return { status: response.status, data: await response.json() };
      };
      return { dir, child, base, request };
    }
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready: ' + output);
}

test('local service: recovery, global credentials, validation, retry and shutdown', async t => {
  const db = emptyDB();
  db.tasks.push({ id: 'task_stale', name: 'old task', status: 'running' });
  const f = await fixture(t, db);
  assert.equal((await f.request('/api/tasks')).data.tasks[0].status, 'idle');
  assert.equal((await f.request('/api/tasks', 'GET', undefined, { Origin: 'https://untrusted.invalid' })).status, 403);
  const failed = await f.request('/api/tasks', 'POST', { name: 'missing credentials' });
  assert.equal(failed.status, 400);
  assert.equal((await f.request('/api/tasks', 'POST', { account: 'a@example.invalid' })).status, 400);
  assert.equal((await f.request('/api/tasks', 'POST', { account: 'a@example.invalid', password: 'legacy-secret' })).status, 400);
  assert.equal((await f.request('/api/tasks', 'POST', { account: 'a@example.invalid', password: 'x', targetDate: '2026-02-30' })).status, 400);
  await f.request('/api/settings', 'POST', { satAccount: 'default@example.invalid', satPassword: 'default-secret' });
  assert.equal((await f.request('/api/tasks', 'POST', { name: 'missing region' })).status, 400);
  assert.equal((await f.request('/api/tasks', 'POST', { targetRegion: 'United States', targetCountryCode: 'US' })).status, 400);
  const first = (await f.request('/api/tasks', 'POST', { name: 'A', targetDate: '2026-12-05', targetRegion: 'Hong Kong', targetCountryCode: 'HK' })).data.task;
  const second = (await f.request('/api/tasks', 'POST', { name: 'B', account: 'b@example.invalid', password: 'b-secret', targetDate: '2027-03-06', targetRegion: 'Hong Kong', targetCountryCode: 'HK' })).data.task;
  assert.notEqual(first.id, second.id);
  assert.equal(first.account, undefined);
  assert.equal(second.account, undefined);
  assert.equal(first.password, undefined);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'data/db.json')));
  for (const task of saved.tasks.filter(task => [first.id, second.id].includes(task.id))) {
    assert.equal(task.account, undefined);
    assert.equal(task.password, undefined);
  }
  await f.request('/api/settings', 'POST', { satAccount: '', satPassword: '' });
  for (let i = 0; i < 2; i++) {
    const started = await f.request('/api/tasks/task_stale/start', 'POST');
    assert.equal(started.data.message, undefined, 'failed task must not remain registered as running');
    assert.equal((await f.request('/api/tasks')).data.tasks.find(task => task.id === 'task_stale').status, 'error');
  }
  const eventAbort = new AbortController();
  const events = await fetch(f.base + '/api/events', { signal: eventAbort.signal });
  const chunk = await events.body.getReader().read();
  const event = new TextDecoder().decode(chunk.value);
  assert.match(event, /event: init/);
  assert(!event.includes('b-secret'));
  eventAbort.abort();
  await f.request('/api/tasks/task_stale/stop', 'POST');
  await f.request(`/api/tasks/${first.id}/complete`, 'POST');
  assert.equal((await f.request('/api/tasks')).data.tasks.find(task => task.id === first.id).status, 'completed');
  await f.request(`/api/tasks/${second.id}`, 'DELETE');
  assert(!(await f.request('/api/tasks')).data.tasks.some(task => task.id === second.id));
  const exit = once(f.child, 'exit');
  f.child.send('stop');
  assert.equal((await exit)[0], 0);
});

const testPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

const regionFixture = { fetchedAt: '2026-10-22T10:00:00Z', regions: [{ code: 'HK', name: 'Hong Kong' }, { code: 'MO', name: 'Macao' }] };

test('official region proxy fetches every time, preserves territories and fails without a local fallback', async t => {
  const f = await fixture(t, undefined, undefined, undefined, `
    let calls = 0;
    global.fetch = async (url, options) => {
      require('node:assert/strict').equal(url, 'https://atlas.collegeboard.org/apricot/prod/4.11.5/api/CBCountries.json');
      require('node:assert/strict').equal(options.headers['Cache-Control'], 'no-cache');
      calls++;
      if (calls === 4) return {ok:false};
      if (calls === 5) throw new Error('offline');
      return {ok:true, json:async()=> calls === 3 ? {countries:[{iso:'??'}]} : {countries:[
        {iso:'us',countryName:'United States'}, {iso:'mo',countryName:'Macao',country:false},
        {iso:'hk',countryName:'Hong Kong '+calls}
      ]}};
    };
  `);
  for (let i = 1; i <= 2; i++) {
    const response = await fetch(f.base + '/api/sat-regions');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.regions, [{code:'HK',name:'Hong Kong '+i},{code:'MO',name:'Macao'}]);
    assert.ok(Number.isFinite(Date.parse(body.fetchedAt)));
    assert.match(body.source, /^https:\/\/atlas\.collegeboard\.org\//);
  }
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/sat-regions')).status, 502);
  assert.equal((await f.request('/api/sat-centers?date=2026-12-05&country=US')).status, 400);
});

test('official exam dates proxy fetches every time, sorts, dedupes and fails without a local fallback', async t => {
  const f = await fixture(t, undefined, undefined, undefined, `
    let calls = 0;
    global.fetch = async (url, options) => {
      require('node:assert/strict').equal(url, 'https://sat-admin-dates.collegeboard.org/');
      require('node:assert/strict').equal(options.headers['Cache-Control'], 'no-cache');
      calls++;
      if (calls === 4) return {ok:false};
      if (calls === 5) throw new Error('offline');
      return {ok:true, json:async()=> calls === 3 ? [{eventFormattedDate:'2026-13-99'},{eventFormattedDate:'2027-01-01',eventInternational:false}] : [
        {eventFormattedDate:'2027-03-06',eventInternational:true},
        {eventFormattedDate:'2026-12-05',eventInternational:true},
        {eventFormattedDate:'2026-12-05',eventInternational:true},
        {eventFormattedDate:'2026-11-07',eventInternational:true}
      ]};
    };
  `);
  for (let i = 1; i <= 2; i++) {
    const response = await fetch(f.base + '/api/sat-exam-dates');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.dates, ['2026-11-07', '2026-12-05', '2027-03-06']);
    assert.ok(Number.isFinite(Date.parse(body.fetchedAt)));
    assert.match(body.source, /^https:\/\/sat-admin-dates\.collegeboard\.org\//);
  }
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/sat-exam-dates')).status, 502);
});

test('online regions retry without stale options; center failures and country changes block stale selection', async t => {
  const f = await fixture(t);
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:480,height:900}});
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({body:''}));
  let failRegions = true, failCenters = false, failDates = true, delayed;
  await page.route('**/api/sat-regions', route => route.fulfill({status:failRegions ? 502 : 200,json:regionFixture}));
  await page.route('**/api/sat-exam-dates', route => route.fulfill({status:failDates ? 502 : 200,json:{source:'https://sat-admin-dates.collegeboard.org/',fetchedAt:'2026-10-22T10:00:00Z',dates:['2026-11-07','2026-12-05']}}));
  await page.route('**/api/sat-centers?**', route => {
    if (new URL(route.request().url()).searchParams.get('country') === 'MO') { delayed = route; return; }
    return route.fulfill({status:failCenters ? 502 : 200,json:[{name:'HK center',code:'12345'}]});
  });
  const dialogs = [];
  page.on('dialog', async dialog => {dialogs.push(dialog.message());await dialog.accept();});
  await page.goto(f.base);
  await page.getByRole('button',{name:'发起考位监控'}).click();
  await page.locator('#regionLoadStatus').getByText('加载失败',{exact:true}).waitFor();
  assert(await page.locator('#formRegion').isDisabled());
  assert.equal(await page.locator('#formRegion option[value=HK]').count(),0);
  await page.locator('#taskForm button[type=submit]').click();
  assert.match(dialogs.pop(), /加载官网地区/);
  failRegions = false;
  failDates = false;
  await page.locator('#btnRefreshRegions').click();
  await page.locator('#btnRefreshDates').click();
  await page.locator('#formRegion').selectOption('HK');
  await page.locator('#formDate').selectOption('2026-12-05');
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  assert.match(await page.locator('#formRegion option[value=MO]').innerText(), /澳门.*Macao/);
  await page.locator('#formCenter').selectOption('HK center');
  failCenters = true;
  await page.locator('#btnRefreshCenters').click();
  await page.locator('#centerLoadStatus').getByText('加载失败',{exact:true}).waitFor();
  assert.equal(await page.locator('#formCenter option[value="HK center"]').count(),0);
  await page.locator('#taskForm button[type=submit]').click();
  assert.match(dialogs.pop(), /确认考点/);
  failCenters = false;
  await page.locator('#btnRefreshCenters').click();
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  const macaoRequest = page.waitForRequest(r => r.url().includes('country=MO'));
  await page.locator('#formRegion').selectOption('MO');
  await macaoRequest;
  assert(await page.locator('#formCenter').isDisabled());
  await page.locator('#formRegion').selectOption('HK');
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  const oldResponse = page.waitForResponse(r => r.url().includes('country=MO'));
  await delayed.fulfill({json:[{name:'Stale Macao center',code:'99999'}]});
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.doesNotMatch(await page.locator('#formCenter').innerText(),/Stale Macao/);
  await page.screenshot({path:path.join(os.tmpdir(),'sat-online-regions.png'),fullPage:true});
  failRegions = true;
  await page.locator('#btnRefreshRegions').click();
  await page.locator('#regionLoadStatus').getByText('加载失败',{exact:true}).waitFor();
  assert.equal(await page.locator('#formRegion option[value=HK]').count(),0);
  assert(await page.locator('#formCenter').isDisabled());
});

test('exam dates load from the official list, block submit until ready and keep saved dates in edit', async t => {
  const db = emptyDB();
  db.tasks.push({ id: 'task_edit_date', name: 'old', targetDate: '2025-06-07', targetRegion: 'Hong Kong', targetCountryCode: 'HK', targetCenters: ['old'], status: 'idle' });
  db.tasks.push({ id: 'task_edit_known', name: 'known', targetDate: '2026-12-05', targetRegion: 'Hong Kong', targetCountryCode: 'HK', targetCenters: ['old'], status: 'idle' });
  const f = await fixture(t, db);
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:480,height:900}});
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({body:''}));
  let failDates = true;
  const dateFixture = { source:'https://sat-admin-dates.collegeboard.org/', fetchedAt:'2026-10-23T10:00:00Z', dates:['2026-11-07','2026-12-05','2027-03-06'] };
  await page.route('**/api/sat-exam-dates', route => route.fulfill({status:failDates ? 502 : 200,json:dateFixture}));
  await page.route('**/api/sat-regions', route => route.fulfill({json:regionFixture}));
  await page.route('**/api/sat-centers?**', route => route.fulfill({json:[{name:'HK center',code:'12345'}]}));
  const dialogs = [];
  page.on('dialog', async dialog => {dialogs.push(dialog.message());await dialog.accept();});
  await page.goto(f.base);
  await page.getByRole('button',{name:'发起考位监控'}).click();
  await page.locator('#regionLoadStatus').getByText('获取于',{exact:false}).waitFor();
  await page.locator('#dateLoadStatus').getByText('加载失败',{exact:true}).waitFor();
  assert(await page.locator('#formDate').isDisabled());
  assert.equal(await page.locator('#formDate option[value="2026-12-05"]').count(),0);
  await page.locator('#formRegion').selectOption('HK');
  await page.locator('#taskForm button[type=submit]').click();
  assert.match(dialogs.pop(), /考期/);
  failDates = false;
  await page.locator('#btnRefreshDates').click();
  await page.locator('#dateLoadStatus').getByText('获取于',{exact:false}).waitFor();
  assert.match(await page.locator('#formDate option[value="2026-12-05"]').innerText(), /2026年12月5日/);
  assert.match(await page.locator('#formDate option[value="2026-12-05"]').innerText(), /星期六/);
  assert(await page.locator('#formDate').isEnabled());
  await page.locator('#formRegion').selectOption('HK');
  await page.locator('#formDate').selectOption('2026-12-05');
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  // 编辑模式：官网列表外的已保存考期保留为可选项，列表内的已保存考期直接预选
  await page.waitForFunction(() => currentTasks.some(task => task.id === 'task_edit_date'));
  await page.evaluate(() => openEditSheet('task_edit_date'));
  await page.waitForFunction(() => document.querySelectorAll('#formDate option').length === 5);
  assert.equal(await page.locator('#formDate').inputValue(), '2025-06-07');
  assert.match(await page.locator('#formDate option[value="2025-06-07"]').innerText(), /已保存/);
  await page.evaluate(() => openEditSheet('task_edit_known'));
  await page.waitForFunction(() => document.querySelectorAll('#formDate option').length === 4 && document.getElementById('formDate').value === '2026-12-05');
  assert.equal(await page.locator('#formDate option[value="2025-06-07"]').count(), 0);
});

test('edits preserve task/history/photo, reject active/completed tasks and restore failed photo saves', async t => {
  const db = emptyDB();
  db.tasks.push({ id: 'task_edit', name: 'original', targetDate: '2026-12-05', targetCenters: ['old'], status: 'idle', pollCount: 12 });
  db.logs.task_edit = ['original log'];
  const f = await fixture(t, db, undefined, `module.exports.runTaskWorker = ({onNeedsAction}) => {
    queueMicrotask(() => onNeedsAction('old', {message:'manual check'})); return {stop:async()=>{}};
  };`);
  const url = '/api/tasks/task_edit';
  const payload = { targetDate: '2027-03-06', targetCenters: ['new'] };
  const photoFile = path.join(f.dir, 'data/photo_task_edit.jpg');
  const originalPhoto = Buffer.from(testPhoto.split(',')[1], 'base64');
  for (const invalid of [{targetDate:'2027-02-30'}, {targetCenters:[42]}, {photoBase64:'data:image/png;base64,YmFk'}]) {
    assert.equal((await f.request(url, 'PATCH', {...payload, ...invalid})).status, 400);
  }
  assert.equal((await f.request('/api/tasks/missing', 'PATCH', payload)).status, 404);
  await f.request(url + '/start', 'POST');
  assert.equal((await f.request(url, 'PATCH', payload)).status, 409);
  await f.request(url + '/stop', 'POST');
  const updated = (await f.request(url, 'PATCH', {...payload, photoBase64:testPhoto})).data.task;
  assert.equal(updated.status, 'idle');
  assert.equal(updated.id, 'task_edit');
  assert.equal(updated.name, 'original');
  assert.equal(updated.pollCount, 12);
  assert.equal(updated.selection, null);
  assert.equal(updated.lockedCenter, null);
  assert.equal(updated.targetDate, payload.targetDate);
  assert.deepEqual(updated.targetCenters, payload.targetCenters);
  assert.equal((await f.request(url + '/logs')).data.logs[0], 'original log');
  assert.equal((await f.request(url, 'PATCH', payload)).data.task.photoPath, photoFile);
  assert.deepEqual(fs.readFileSync(photoFile), originalPhoto);
  const persisted = fs.readFileSync(path.join(f.dir, 'data/db.json'), 'utf8');
  fs.mkdirSync(path.join(f.dir, 'data/db.json.tmp'));
  const replacement = 'data:image/jpeg;base64,/9j/AA==';
  assert.equal((await f.request(url, 'PATCH', {...payload, photoBase64:replacement})).status, 500);
  assert.deepEqual(fs.readFileSync(photoFile), originalPhoto);
  assert.equal(fs.readFileSync(path.join(f.dir, 'data/db.json'), 'utf8'), persisted);
  assert.equal((await f.request('/api/tasks')).data.tasks[0].photoPath, photoFile);
  fs.rmdirSync(path.join(f.dir, 'data/db.json.tmp'));
  assert.equal((await f.request(url, 'PATCH', {...payload, photoBase64:replacement})).status, 200);
  assert.deepEqual(fs.readFileSync(photoFile), Buffer.from('/9j/AA==', 'base64'));
  assert.equal((await f.request(url, 'PATCH', {...payload, removePhoto:true})).data.task.photoPath, '');
  assert.equal(fs.existsSync(photoFile), false);
  await f.request(url + '/complete', 'POST');
  assert.equal((await f.request(url, 'PATCH', payload)).status, 409);
});

test('dashboard edits photos/dates and requires explicit center selection after date changes', async t => {
  const db = emptyDB();
  db.tasks.push({id:'task_ui', name:'original', targetDate:'2026-12-05', targetCountryCode:'HK', targetCenters:['12345','Original center'], status:'idle'});
  const f = await fixture(t, db);
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:480,height:900}});
  const errors = [], dialogs = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('dialog', async dialog => {dialogs.push(dialog.message()); await dialog.accept();});
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({contentType:'text/css',body:''}));
  await page.route('**/api/sat-regions', route => route.fulfill({json:regionFixture}));
  await page.route('**/api/sat-exam-dates', route => route.fulfill({json:{source:'https://sat-admin-dates.collegeboard.org/',fetchedAt:'2026-10-23T10:00:00Z',dates:['2026-12-05','2027-03-06','2027-05-01','2027-06-05']}}));
  let failCenters = true, staleRoute;
  await page.route('**/api/sat-centers?**', async route => {
    if (new URL(route.request().url()).searchParams.get('date') === '2027-05-01') {staleRoute = route; return;}
    await route.fulfill({status:failCenters ? 500 : 200,contentType:'application/json',body:JSON.stringify([{name:'New center',code:'67890',seatAvailability:true}])});
  });
  await page.goto(f.base);
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await page.locator('#formDate').inputValue(), '2026-12-05');
  assert.equal(await page.locator('#formName').isDisabled(), true);
  await page.locator('#formPhoto').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:Buffer.from(testPhoto.split(',')[1],'base64')});
  await page.getByText('photo.png',{exact:true}).waitFor();
  let saved = page.waitForResponse(r => r.request().method() === 'PATCH');
  await page.locator('#taskForm button[type=submit]').click();
  assert.equal((await saved).status(), 200);
  assert.deepEqual((await f.request('/api/tasks')).data.tasks[0].targetCenters,['12345','Original center']);
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  assert.match(await page.locator('#photoPreviewImg').getAttribute('src'), /\/photo$/);
  await page.waitForFunction(() => !document.getElementById('formDate').disabled && document.querySelector('#formDate option[value="2027-03-06"]'));
  await page.locator('#formDate').selectOption('2027-03-06');
  await page.locator('#centerLoadStatus').getByText('加载失败',{exact:true}).waitFor();
  await page.locator('#taskForm button[type=submit]').click();
  assert.match(dialogs.at(-1), /确认考点/);
  assert.equal((await f.request('/api/tasks')).data.tasks[0].targetDate,'2026-12-05');
  failCenters = false;
  await page.locator('#btnRefreshCenters').click();
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  assert.doesNotMatch(await page.locator('#formCenter').innerText(), /有空位/);
  assert.equal(await page.locator('#formCenter').evaluate(el => el.selectedOptions[0].disabled), true);
  await page.locator('#formCenter').selectOption('New center');
  saved = page.waitForResponse(r => r.request().method() === 'PATCH');
  await page.locator('#taskForm button[type=submit]').click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.equal(response.request().postDataJSON().photoBase64, undefined);
  const task = (await f.request('/api/tasks')).data.tasks[0];
  assert.equal(task.targetDate,'2027-03-06');
  assert.deepEqual(task.targetCenters,['67890','New center']);
  assert.ok(task.photoPath);
  await page.getByRole('button',{name:'编辑',exact:true}).click();
  await page.waitForFunction(() => !document.getElementById('formDate').disabled && document.querySelector('#formDate option[value="2027-05-01"]'));
  await page.locator('#formDate').selectOption('2027-05-01');
  await page.waitForFunction(() => document.getElementById('formCenter').disabled);
  await page.locator('#formDate').selectOption('2027-06-05');
  await page.locator('#centerLoadStatus').getByText(/^1 个 · 获取于/).waitFor();
  const staleResponse = page.waitForResponse(r => r.url().includes('date=2027-05-01'));
  await staleRoute.fulfill({contentType:'application/json',body:JSON.stringify([{name:'Stale center',code:'11111'}])});
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.doesNotMatch(await page.locator('#formCenter').innerText(), /Stale center/);
  await page.screenshot({path:path.join(os.tmpdir(),'sat-edit-task.png'),fullPage:true});
  await page.locator('#addSheet .sheet-close').click();
  await page.getByRole('button',{name:'发起考位监控'}).click();
  assert.equal(await page.locator('#formName').isDisabled(),false);
  await page.waitForFunction(() => !document.getElementById('formRegion').disabled);
  assert.equal(await page.locator('#formRegion').isDisabled(),false);
  assert.equal(await page.locator('#formPhoto').inputValue(),'');
  await page.locator('#addSheet .sheet-close').click();
  await page.evaluate(() => {currentTasks[0].status='running';renderTasks();});
  assert.equal(await page.getByRole('button',{name:'编辑',exact:true}).isDisabled(),true);
  await page.evaluate(() => {currentTasks[0].status='completed';renderTasks();});
  assert.equal(await page.getByRole('button',{name:'编辑',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
});

test('corrupt database fails closed without replacing user data', async t => {
  const f = await fixture(t, undefined, '{broken database');
  assert.equal(f.child.exitCode, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'data/db.json'), 'utf8'), '{broken database');
});

test('dashboard creates candidate with global credentials, renders safely, and preserves invalid form', async t => {
  const f = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  // 本机流程测试不依赖外部样式 CDN 的网络状态。
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/api/sat-regions', route => route.fulfill({json:regionFixture}));
  await page.route('**/api/sat-exam-dates', route => route.fulfill({json:{source:'https://sat-admin-dates.collegeboard.org/',fetchedAt:'2026-10-23T10:00:00Z',dates:['2026-12-05']}}));
  await page.route('**/api/sat-centers?**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto(f.base);
  await page.getByRole('button', { name: '发起考位监控' }).click();
  await page.locator('#formRegion').selectOption('HK');
  await page.locator('#formDate').selectOption('2026-12-05');
  await page.waitForFunction(() => !document.getElementById('formCenter').disabled);
  assert.equal(await page.locator('#formAccount, #formPassword').count(), 0);
  await page.locator('#formName').fill('考生 <img src=x onerror="window.injected=true">');
  await Promise.all([
    page.waitForEvent('dialog'),
    page.locator('#taskForm button[type=submit]').click()
  ]);
  assert.match(dialogs[0], /全局.*账号.*密码/);
  assert.match(await page.locator('#formName').inputValue(), /<img/);
  await f.request('/api/settings', 'POST', { satAccount: 'global@example.invalid', satPassword: 'fixture-global' });
  const created = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.locator('#taskForm button[type=submit]').click();
  const response = await created;
  assert.equal(response.status(), 200);
  const payload = response.request().postDataJSON();
  assert.equal(payload.account, undefined);
  assert.equal(payload.password, undefined);
  await page.locator('.task-card').waitFor();
  assert.equal(await page.locator('.student-name, .student-account').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal((await f.request('/api/tasks')).data.tasks[0].status, 'idle');
  await page.getByRole('button', { name: '查看日志' }).click();
  await page.locator('#logSheet').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: '关闭流水' }).click();
  await page.evaluate(() => {
    currentTasks[0].status = 'needs_action';
    currentTasks[0].selection = { outcome: 'unverified', message: '选座结果未确认，请在浏览器人工核对；系统未确认锁位。<img src=x onerror="window.injected=true">' };
    renderTasks();
  });
  assert.match(await page.locator('.task-card [role="status"]').innerText(), /系统未确认锁位/);
  assert.equal(await page.locator('[role="status"] img').count(), 0);
  assert.equal(await page.getByText('待人工核对', { exact: true }).count(), 1);
  assert.equal(await page.locator('.countdown-timer').count(), 0);
  assert.equal(await page.getByRole('button', {name:'确认已付款', exact:true}).count(), 0);
  await page.evaluate(() => {
    currentTasks[0].selection.message = '选座结果未确认，请在浏览器人工核对；系统未确认锁位。';
    renderTasks();
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'sat-local-dashboard.png'), fullPage: true });
});

test('worker uses latest global credentials instead of saved task credentials', async () => {
  const settings = { satAccount: 'first@example.invalid', satPassword: ' first fixture ' };
  const task = { id: 'legacy', account: 'old@example.invalid', password: 'old-fixture' };
  const submitted = [];
  let launches = 0;
  const engine = loadEngine({ launchPersistentContext: async () => {
    launches++;
    const context = new EventEmitter();
    context.close = async () => context.emit('close');
    context.newPage = async () => ({
      setDefaultTimeout() {}, route: async () => {}, goto: async () => {},
      $: async () => null, waitForTimeout: async () => {},
      waitForSelector: async selector => selector.includes('identifier') || selector.includes('password') ? {} : null,
      fill: async (selector, value) => {
        submitted.push([selector, value]);
        if (selector.includes('password')) throw new Error('fixture stops after login inputs');
      },
      url: () => 'https://account.collegeboard.org/login/login',
      content: async () => '', isClosed: () => false, screenshot: async () => {}
    });
    return context;
  } }, settings);
  for (let i = 0; i < 2; i++) {
    let exited;
    const done = new Promise(resolve => { exited = resolve; });
    const worker = engine.runTaskWorker({ task, onLog() {}, onError() {}, onExit: exited });
    await done;
    await worker.stop();
    assert.deepEqual(submitted.slice(-2), [
      ['input[name="identifier"]', settings.satAccount], ['input[type="password"]', settings.satPassword]
    ]);
    settings.satAccount = 'updated@example.invalid';
    settings.satPassword = ' updated fixture ';
  }
  settings.satAccount = '';
  settings.satPassword = '';
  let failed;
  const failure = new Promise(resolve => { failed = resolve; });
  const worker = engine.runTaskWorker({ task, onLog() {}, onError: failed });
  assert.equal(await failure, '缺少 SAT 凭证');
  await worker.stop();
  assert.equal(launches, 2, 'legacy credentials must not bypass missing global configuration');
});

test('date selection follows task date and rejects unmatched dates without clicking', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<h1>Choose a test date</h1><label><input type="radio" name="d" value="2026-12-05">December 5, 2026</label><label><input type="radio" name="d" value="spring">March 6, 2027</label>');
  const engine = loadEngine();
  await engine.selectDate(page, () => {}, { targetDate: '2027-03-06' });
  assert(await page.locator('[value=spring]').isChecked());
  await assert.rejects(engine.selectDate(page, () => {}, { targetDate: '2027-05-01' }), /无法准确匹配考期/);
  assert(await page.locator('[value=spring]').isChecked());
});

test('official wizard resumes only the target registration and hands rules to the user', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const engine = loadEngine();
  await page.route('https://mysat.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:`
    <a href="https://satreg.collegeboard.org/wrong">Register for the SAT</a>
    <section><h2>March 6, 2027</h2>Incomplete<a href="https://satreg.collegeboard.org/wrong">Finish Registration</a></section>
    <section><h2>December 5, 2026</h2>Incomplete<a href="https://satreg.collegeboard.org/progress">Finish Registration</a></section>`}));
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:route.request().url().endsWith('/progress')
    ? '<section><h2>Personal Information</h2><a href="/wrong">Finish</a></section><section><h2>Select Date and Test Center</h2><a href="/rules">Finish</a></section>'
    : '<h1>Testing Rules</h1><input type="checkbox" id="terms-acceptance-checkbox" disabled><button disabled>Continue</button>'}));
  await page.goto('https://mysat.collegeboard.org/dashboard');
  await engine.wizard(page, () => {}, {targetDate:'2026-12-05'});
  assert.equal(page.url(), 'https://satreg.collegeboard.org/rules');
  let handedOff = false;
  await engine.selectDate(page, () => {}, {targetDate:'2026-12-05'}, async (message, ready) => {
    handedOff = true;
    assert.match(message, /当次确认/);
    assert.equal(await page.locator('input').isChecked(), false);
    assert.equal(await page.locator('input').isDisabled(), true);
    assert.equal(await ready(), false);
    await page.setContent('<h1>Choose your test location</h1><p>December 5, 2026</p>');
    assert.equal(await ready(), true);
  });
  assert(handedOff);
  await page.goto('https://mysat.collegeboard.org/dashboard');
  await page.locator('section').last().evaluate(el => el.remove());
  await engine.wizard(page, () => {}, {targetDate:'2026-12-05'}, async message => {
    assert.match(message, /无法唯一定位/);
    assert.equal(page.url(), 'https://mysat.collegeboard.org/dashboard');
    await page.goto('https://satreg.collegeboard.org/rules');
  });
});

test('wizard click does not time out waiting for a slow destination to load', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let releaseResponse;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  t.after(() => releaseResponse());
  await page.route('https://satreg.collegeboard.org/**', async route => {
    if (route.request().url().endsWith('/slow')) await responseGate;
    await route.fulfill({contentType:'text/html', body:'<button onclick="location.href=\'/slow\'">Continue</button>'});
  });
  await page.goto('https://satreg.collegeboard.org/start');
  const click = loadEngine().clickWizardControl(page.getByRole('button', {name:'Continue'}));
  const result = await Promise.race([click.then(() => 'clicked', () => 'failed'),
    new Promise(resolve => setTimeout(() => resolve('still waiting for navigation'), 1500))]);
  releaseResponse();
  await click;
  assert.equal(result, 'clicked');
});

test('wizard recovers clicks that never reach the control without repeating delivered clicks', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let registrationLoads = 0;
  const swallowMouse = '<script>window.addEventListener("click", e => { if(e.isTrusted) e.stopImmediatePropagation(); }, true);</script>';
  await page.route('https://mysat.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:
    '<button onclick="location.href=\'https://satreg.collegeboard.org/register/personalInformation\'">Register for the SAT</button>' + swallowMouse}));
  await page.route('https://satreg.collegeboard.org/**', route => {
    registrationLoads++;
    return route.fulfill({contentType:'text/html', body:
      '<h1>Confirm Student Information</h1><button onclick="window.continueClicks++;history.pushState({},\'\',\'/register/testDate\')">Continue</button>' +
      '<script>window.continueClicks=0;</script>' + swallowMouse});
  });
  await page.goto('https://mysat.collegeboard.org/dashboard');
  await loadEngine().wizard(page, () => {}, {targetDate:'2026-12-05'}, async message => assert.fail(message));
  assert.equal(new URL(page.url()).pathname, '/register/testDate');
  assert.equal(registrationLoads, 1);
  assert.equal(await page.evaluate(() => window.continueClicks), 1);
});

test('personal information preserves saved school and questionnaire answers and ignores hidden controls', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:`
    <h1>School Information</h1>
    <select id="grade" required><option value="8">8th Grade</option><option selected value="graduate">No longer in high school</option></select>
    <select id="education"><option>I do not wish to respond</option><option selected>College</option></select>
    <div hidden role="dialog"><button>Continue</button><button>Confirm</button></div>
    <button onclick="window.confirmClicks++">Confirm Student Information</button>
    <a role="button" onclick="history.pushState({},'', '/register/testDate')">Continue</a>
    <script>window.changes=0;window.confirmClicks=0;document.addEventListener('change',()=>window.changes++);</script>`}));
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  await loadEngine().wizard(page, () => {}, {}, async message => assert.fail(message));
  assert.equal(new URL(page.url()).pathname, '/register/testDate');
  assert.equal(await page.locator('#grade').inputValue(), 'graduate');
  assert.equal(await page.locator('#education').inputValue(), 'College');
  assert.equal(await page.evaluate(() => window.changes), 0);
  assert.equal(await page.evaluate(() => window.confirmClicks), 0);
});

test('personal information waits for a blocking dialog and resumes after it is handled', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:`
    <h1>School Information</h1><select id="grade"><option selected>Saved grade</option><option>Wrong grade</option></select>
    <div class="cb-modal" aria-hidden="false" style="position:fixed;inset:0;background:white;z-index:2">
      <p>Please confirm your school name and address</p><button onclick="window.confirmClicks++">Confirm</button>
    </div>
    <button onclick="window.continueClicks++;history.pushState({},'', '/register/testDate')">Continue</button>
    <script>window.confirmClicks=0;window.continueClicks=0;</script>`}));
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  let handoffs = 0;
  await loadEngine().wizard(page, () => {}, {}, async (message, ready) => {
    handoffs++;
    assert.match(message, /弹窗.*Please confirm your school/);
    assert.equal(await ready(), false);
    assert.equal(await page.evaluate(() => window.confirmClicks + window.continueClicks), 0);
    await page.locator('.cb-modal').evaluate(el => { el.hidden = true; el.setAttribute('aria-hidden', 'true'); });
    assert.equal(await ready(), true);
  });
  assert.equal(handoffs, 1);
  assert.equal(await page.locator('#grade').inputValue(), 'Saved grade');
  assert.equal(await page.evaluate(() => window.confirmClicks), 0);
  assert.equal(await page.evaluate(() => window.continueClicks), 1);
});

test('personal information hands missing required answers and stalled Continue to the user', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html', body:`
    <label for="grade">Grade Level</label><select id="grade" required>
      <option value="" selected>Select a grade</option><option value="graduate">No longer in high school</option>
    </select><button onclick="window.continueClicks++">Continue</button><script>window.continueClicks=0;</script>`}));
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  let handoffs = 0;
  await loadEngine().wizard(page, () => {}, {}, async (message, ready) => {
    handoffs++;
    assert.equal(await ready(), false);
    if (handoffs === 1) {
      assert.match(message, /Grade Level/);
      assert.equal(await page.locator('#grade').inputValue(), '');
      assert.equal(await page.evaluate(() => window.continueClicks), 0);
      await page.locator('#grade').selectOption('graduate');
    } else {
      assert.match(message, /未推进/);
      assert.equal(await page.evaluate(() => window.continueClicks), 1);
      await page.evaluate(() => history.pushState({}, '', '/register/testDate'));
    }
    assert.equal(await ready(), true);
  });
  assert.equal(handoffs, 2);
  assert.equal(await page.locator('#grade').inputValue(), 'graduate');
});

test('personal information ignores unrelated text churn before Continue is enabled', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const script = '<h1>School Information</h1>' +
    '<select id="grade"><option selected value="graduate">No longer in high school</option></select>' +
    '<div id="status">Loading</div><button id="continue" disabled>Continue</button>' +
    '<scr' + 'ipt>let n = 0; setInterval(() => { document.getElementById("status").textContent = "Loading " + (n++) + " / 100"; }, 200);</scr' + 'ipt>';
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({ contentType: 'text/html', body: script }));
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  let handoffs = 0;
  await loadEngine().wizard(page, () => {}, {}, async (message, ready) => {
    handoffs++;
    assert.match(message, /尚不能继续/);
    for (let i = 0; i < 4; i++) {
      assert.equal(await ready(), false, 'text churn must not count as manual progress');
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => {
      document.getElementById('continue').disabled = false;
      history.pushState({}, '', '/register/testDate');
    });
    assert.equal(await ready(), true);
  });
  assert.equal(handoffs, 1);
  assert.equal(new URL(page.url()).pathname, '/register/testDate');
});

test('personal information clicks an anchor Continue that has no button or link role', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // 官网实测：问卷子步骤的 Continue 是不带 role、也没 href 的 <a>，
  // 隐式 role 为 generic，getByRole('button'|'link') 都匹配不到。
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({ contentType: 'text/html', body:
    '<h1>Student Questionnaire</h1>' +
    '<a id="qc-id-studentquestionnaire-button-continue" aria-disabled="false" class="cb-btn cb-btn-yellow"' +
      ' onclick="window.go()">\n        Continue\n      </a>' +
    '<scr' + 'ipt>window.clicks = 0;' +
    'window.go = () => { window.clicks++; if (window.clicks === 1) {' +
    '  document.querySelector("h1").textContent = "School Information";' +
    '  history.pushState({}, "", "/register/personalInformation?step=2");' +
    '} else { history.pushState({}, "", "/register/testDate"); } };' +
    '</scr' + 'ipt>' }));
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  await loadEngine().wizard(page, () => {}, {}, async message => assert.fail(message));
  assert.equal(await page.evaluate(() => window.clicks), 2, '两个子步骤的无 role <a> 都要点到');
  assert.equal(new URL(page.url()).pathname, '/register/testDate');
});

test('personal information keeps waiting while the submit request is still in flight', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  // 真实页面点 Continue 后既没有 aria-busy 也没有 progressbar，但有在途请求，
  // 约 19 秒后才 pushState 到 testDate。只靠 busy 标记会在 2 秒时误判“未推进”。
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('https://satreg.collegeboard.org/**', async route => {
    if (route.request().url().endsWith('/slow')) {
      await gate;
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ contentType: 'text/html', body:
    '<h1>Confirm Student Information</h1>' +
    '<select id="grade"><option selected value="graduate">No longer in high school</option></select>' +
    '<button id="continue" onclick="window.clicks++; fetch(\'/slow\').then(() => history.pushState({}, \'\', \'/register/testDate\'))">Continue</button>' +
      '<scr' + 'ipt>window.clicks = 0;</scr' + 'ipt>' });
  });
  await page.goto('https://satreg.collegeboard.org/register/personalInformation');
  let handoffs = 0;
  const pending = loadEngine().wizard(page, () => {}, {}, async message => {
    handoffs++;
    assert.fail('不应在请求在途时转人工：' + message);
  });
  // 8s 静默阈值之后仍在等待，才能证明在途请求会拉长等待。
  await page.waitForTimeout(10500);
  assert.equal(handoffs, 0, '请求进行中不能转人工');
  assert.match(page.url(), /personalInformation/, '页面还未变化时不能提前结束');
  release();
  await pending;
  assert.equal(handoffs, 0);
  assert.equal(new URL(page.url()).pathname, '/register/testDate');
  assert.equal(await page.evaluate(() => window.clicks), 1);
});

test('auto rules acceptance scrolls terms, checks the box and continues when enabled', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<h1>Testing Rules</h1>
    <div id="terms" style="height: 40px; overflow: auto;"><p style="height: 400px;">terms</p></div>
    <input type="checkbox" id="accept" disabled>
    <button id="go" disabled>Continue</button>
    <script>
      document.getElementById('terms').addEventListener('scroll', function() {
        if (this.scrollTop + this.clientHeight >= this.scrollHeight - 4) {
          document.getElementById('accept').disabled = false;
          const go = document.getElementById('go');
          go.disabled = false;
          go.onclick = () => { document.querySelector('h1').textContent = 'Registration Continued'; };
        }
      });
    </script>`);
  const engine = loadEngine(chromium, { autoAcceptRules: true });
  const logs = [];
  await engine.selectDate(page, msg => logs.push(msg), { targetDate: '2026-12-05' }, async () => { throw new Error('开启自动接受后不应转人工'); });
  assert.equal(await page.locator('h1').innerText(), 'Registration Continued');
  assert.equal(await page.locator('#accept').isChecked(), true);
  // Continue 缺失时诚实降级回人工，消息仍要求当次确认，且日志记录失败原因
  await page.setContent('<h1>Testing Rules</h1><input type="checkbox">');
  let handedOff = false;
  await engine.selectDate(page, msg => logs.push(msg), { targetDate: '2026-12-05' }, async (message, ready) => {
    handedOff = true;
    assert.match(message, /当次确认/);
    await page.setContent('<h1>Registration Continued</h1>');
    assert.equal(await ready(), true);
  });
  assert(handedOff);
  assert(logs.some(m => /自动接受考试规则失败：未找到规则页 Continue 按钮/.test(m)), JSON.stringify(logs));
});

test('official date buttons respect the year group and verify full date before continuing', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const engine = loadEngine();
  await page.setContent(`<div hidden><button onclick="throw new Error('wrong Continue')">Continue</button></div><h1>Choose a test date</h1>
    <section><h2>2027</h2><button id="qc-id-selectdatecenter-testdate-button-DEC-05-other">Dec 5</button></section>
    <section><h2>2026</h2><button id="qc-id-selectdatecenter-testdate-button-DEC-05" onclick="document.querySelector('#details').textContent='Saturday, December 5, 2026'">Dec 5</button></section>
    <p id="details"></p><button id="testdate-continue-button" aria-label="Continue to test location" onclick="document.querySelector('h1').textContent='Choose your test location'">Next</button>`);
  await engine.selectDate(page, () => {}, {targetDate:'2026-12-05'});
  assert.equal(await page.locator('h1').innerText(), 'Choose your test location');
  assert.match(await page.locator('#details').innerText(), /December 5, 2026/);
  await page.setContent('<h1>Choose a test date</h1><section><h2>2027</h2><button id="qc-id-selectdatecenter-testdate-button-DEC-05">Dec 5</button></section>');
  await assert.rejects(engine.selectDate(page, () => {}, {targetDate:'2026-12-05'}), /无法准确匹配考期/);
  await assert.rejects(engine.selectDate(page, () => {}, {targetDate:'2026-02-30'}), /考期无效/);
});

test('worker resumes after manual rules and can stop while waiting without querying', async t => {
  for (const resume of [true, false]) await t.test(resume ? 'resume' : 'stop', async t => {
    const browser = await chromium.launch({headless:true});
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html',body:'<h1>Testing Rules</h1><input type="checkbox" disabled>'}));
    const goto = page.goto.bind(page);
    page.goto = () => goto('https://satreg.collegeboard.org/register/testCenterSearch');
    page.route = async () => {};
    page.waitForSelector = async () => null;
    const wait = page.waitForTimeout.bind(page);
    page.waitForTimeout = () => wait(20);
    context.newPage = async () => page;
    let notify, queried, resumed = 0, queries = 0;
    const waiting = new Promise(resolve => {notify = resolve;});
    const checked = new Promise(resolve => {queried = resolve;});
    const engine = loadEngine({launchPersistentContext:async () => context}, undefined, async () => {
      queries++; queried(); return {status:'unavailable'};
    });
    const worker = engine.runTaskWorker({task:{id:'manual',targetDate:'2026-12-05',targetCountryCode:'MO',targetRegion:'Macau'},onLog(){},onPoll(){},
      onNeedsAction:(center, selection) => {assert.equal(center,null);assert.match(selection.message,/当次确认/);notify();},
      onResume:() => {resumed++;},onError:error => assert.fail(error)});
    await waiting;
    assert.equal(await page.locator('input').isChecked(),false);
    if (resume) {
      await page.setContent('<h1>Choose your test location</h1><p>December 5, 2026</p><select id="test-center-country-select"><option value="HK">Hong Kong</option><option value="MO">Macao</option></select>');
      await checked;
      assert.equal(await page.locator('select').inputValue(), 'MO');
      assert.equal(resumed,1);
    }
    await worker.stop();
    assert.equal(page.isClosed(),true);
    assert.equal(queries,resume ? 1 : 0);
  });
});

test('selection hands browser to user until stopped; legacy autoSubmit never pays', async () => {
  const context = new EventEmitter();
  let closes = 0, selected = false, paymentClicks = 0, options;
  const absent = { first() { return this; }, last() { return this; }, filter() { return this; }, or() { return this; }, isVisible: async () => false };
  const page = {
    locator: () => absent, getByText: () => absent, getByRole: () => absent,
    setDefaultTimeout() {}, route: async () => {}, goto: async () => {}, url: () => 'https://satreg.collegeboard.org/register/testCenterSearch',
    waitForTimeout: async () => {}, waitForSelector: async () => null, waitForURL: async () => {}, isClosed: () => false,
    context: () => ({ on() {}, off() {} }),
    content: async () => 'Target Center', screenshot: async () => {},
    $: async selector => selector.startsWith('select[name*=') ? {selectOption:async()=>{}, inputValue:async()=>'HK'} : selector === 'text=Target Center' ? {
      evaluate: async () => 'Seats Available',
      evaluateHandle: async () => ({ asElement: () => ({ click: async () => { selected = true; } }) })
    } : null
  };
  context.newPage = async () => page;
  context.close = async () => { closes++; context.emit('close'); };
  const engine = loadEngine({ launchPersistentContext: async (profile, config) => { options = config; return context; } }, undefined, async () => ({ status: 'available', matchedCenter: 'Target Center', selectTargetBtn: { click: async () => { selected = true; } } }));
  let ready;
  const handoff = new Promise(resolve => { ready = resolve; });
  let exited;
  const done = new Promise(resolve => { exited = resolve; });
  const worker = engine.runTaskWorker({ task: { id: 'fixture', account: 'a', password: 'b', targetCountryCode: 'HK', targetCenters: ['Target Center'] }, onLog() {}, onPoll() {}, onNeedsAction: (center, selection) => ready({ center, selection }), onError: err => assert.fail(err), onExit: exited });
  const result = await handoff;
  assert.equal(result.center, 'Target Center');
  assert.equal(result.selection.outcome, 'unverified');
  await new Promise(resolve => setImmediate(resolve));
  assert(selected);
  assert.equal(options.headless, false);
  assert.equal(closes, 0, 'handoff must retain browser for manual payment');
  await worker.stop();
  await done;
  const checkout = { waitForURL: async () => {}, url: () => 'https://pps.collegeboard.org/checkout', $: async selector => selector.includes('Submit') ? { click: async () => { paymentClicks++; } } : null };
  await engine.postSelection(checkout, () => {}, {}, '', { number: 'fixture', autoSubmit: true });
  assert.equal(paymentClicks, 0);
});

test('selection observes one unmodified official submission and preserves HTTP failure evidence', async t => {
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const payload = {regRequest:{testCenterCode:'62251',testDate:'2026-12-05',deviceMetricsConsent:true,
    assessments:[{asmtId:118,asmtEventId:3025},{asmtId:118,asmtEventId:3025}]},fingerprint:'fixture-private-token'};
  for (const status of [500, 200]) await t.test(String(status), async () => {
    const page = await browser.newPage();
    const requests = [], logs = [];
    try {
      await page.route('https://satreg-api.collegeboard.org/**', async route => {
        const headers = {'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS',
          'access-control-allow-headers':'content-type'};
        if (route.request().method() === 'OPTIONS') return route.fulfill({status:204,headers});
        requests.push(route.request().postDataJSON());
        return route.fulfill({status,headers,contentType:'application/json',body:JSON.stringify({
          message:status===500?'RegAdminTestCenterService.assignSeat failed':'ok',requestId:'fixture-request'})});
      });
      await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({contentType:'text/html',body:
        route.request().url().endsWith('/photoUpload') ? '<h1>Upload Your Photo</h1>' :
        '<h1>Confirm Your Test Details</h1><button id="test-location-continue-button">Continue</button>' +
        '<button id="test-details-continue-button">Continue</button><div id="result"></div><script>' +
        'document.getElementById("test-details-continue-button").onclick=async()=>{' +
        'const r=await fetch("https://satreg-api.collegeboard.org/msregrequest-prod/student/save-reg-request",' +
        '{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify('+JSON.stringify(payload)+')});' +
        'if(r.ok)location.href="/register/photoUpload";else document.getElementById("result").textContent="Sorry, this seat is no longer available.";};</script>'}));
      await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
      const bounded = locator => new Proxy(locator, {get(target,key) {
        if(key==='first')return ()=>bounded(target.first());
        if(key==='waitFor')return options=>target.waitFor({...options,timeout:100});
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const driver = {url:()=>page.url(),locator:selector=>bounded(page.locator(selector)),context:()=>page.context(),
        waitForTimeout:ms=>page.waitForTimeout(Math.min(ms,100)),
        waitForURL:(predicate,options)=>page.waitForURL(predicate,{...options,timeout:100})};
      const result = await loadEngine().attemptSelection(driver,{click:async()=>{}},{log:message=>{
        logs.push(message);
        if(process.env.SAT_TEST_DEBUG) console.log(status,message);
      }});
      assert.equal(requests.length,1,'failure must not replay a seat submission');
      assert.deepEqual(requests[0],payload,'official request must not be rewritten');
      assert.equal(result.outcome,status===500?'unverified':'advanced');
      if(status===500){assert.match(result.message,/HTTP 500.*assignSeat failed/);assert.match(result.message,/未确认锁位/);}
      assert(!logs.join('\n').includes('fixture-private-token'));
      assert.equal(page.isClosed(),false);
    } finally {await page.close();}
  });
});

test('selection evidence uses real page state and never treats a click or warning as a lock', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const engine = loadEngine();
  const cases = [
    { name: 'unchanged search page', body: 'Target Center', outcome: 'unverified' },
    { name: 'confirmation without Continue', body: '<h1>Confirm Your Test Details</h1>20 minute warning', outcome: 'confirmation_pending' },
    { name: 'Continue does not advance', body: '<h1>Confirm Your Test Details</h1><button>Continue</button>', outcome: 'confirmation_pending' },
    { name: 'disabled Continue', body: '<h1>Confirm Your Test Details</h1><button disabled>Continue</button>', outcome: 'confirmation_pending' },
    { name: 'visible captcha', body: '<h1>Confirm Your Test Details</h1><div id="fc-iframe-wrap">Verification</div><button>Continue</button>', outcome: 'verification_required' },
    { name: 'seat disappeared', body: '<h1>Confirm Your Test Details</h1>No longer available<button>Continue</button>', outcome: 'seat_lost' },
    { name: 'post-selection page', body: '<h1>Confirm Your Test Details</h1><a id="qc-id-test-location-continue-button" href="#">Continue</a><button id="qc-id-test-details-continue-button" onclick="location.href=\'/register/photoUpload\'">Continue</button>', outcome: 'advanced' },
    { name: 'captcha after Continue', body: '<h1>Confirm Your Test Details</h1><a id="qc-id-test-location-continue-button" href="#">Continue</a><button id="qc-id-test-details-continue-button" onclick="document.body.innerHTML=\'<div id=fc-iframe-wrap>Verification</div>\'">Continue</button>', outcome: 'verification_required' },
    { name: 'click fails', body: 'Target Center', outcome: 'unverified', failClick: true }
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/photoUpload') ? '<h1>Upload Your Photo</h1>' : sample.body }));
      await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
      // Only shorten waits; selection and classification run against actual browser DOM.
      const driver = {
        url: () => page.url(), locator: selector => page.locator(selector),
        getByRole: (...args) => page.getByRole(...args),
        waitForSelector: (selector, options) => page.waitForSelector(selector, { ...options, timeout: 100 }),
        waitForURL: (predicate, options) => page.waitForURL(predicate, { ...options, timeout: 100 }),
        // 引擎内部用 waitForTimeout 等官网落定；测试里封顶 500ms，既给导航留时间又不拖慢套件。
        waitForTimeout: async ms => page.waitForTimeout(Math.min(ms, 500)),
        context: () => ({ on() {}, off() {} })
      };
      const result = await engine.attemptSelection(driver, { click: async () => { if (sample.failClick) throw new Error('selection interrupted'); } });
      assert.equal(result.outcome, sample.outcome);
      assert(!/成功|独占|20 分钟/.test(result.message));
      assert.equal(page.isClosed(), false);
    } finally { await page.close(); }
  });
});

test('hCaptcha requires SDK completion and a closed challenge, not just an enabled button', async t => {
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const solver = require(path.join(root,'yescaptcha-solver'));
  const original = solver.solveHCaptcha;
  solver.solveHCaptcha = async () => 'fixture-solved-token';
  t.after(() => {solver.solveHCaptcha=original;});
  const engine = loadEngine({}, {yescaptchaKey:'fixture-key'});
  for (const mode of ['callback-only','sdk-with-open-challenge','accepted','no-button','manual-completed-first']) await t.test(mode, async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://newassets.hcaptcha.com/**',route=>route.fulfill({contentType:'text/html',body:'<div></div>'}));
      await page.setContent('<iframe id="widget" src="https://newassets.hcaptcha.com/widget#frame=checkbox"></iframe>' +
        '<iframe id="challenge" src="https://newassets.hcaptcha.com/widget#frame=challenge"></iframe>' +
        '<textarea name="h-captcha-response"></textarea><button id="test-details-continue-button" disabled>Continue</button>');
      await page.evaluate(mode => {
        window.hcaptcha={getResponse:()=>window.sdkResponse||''};
        document.getElementById('widget').__reactFiber$fixture={memoizedProps:{sitekey:'fixture-sitekey',onVerify:token=>{
          const button=document.getElementById('test-details-continue-button');
          button.disabled=false;
          if(mode!=='callback-only')window.sdkResponse=token;
          if(mode==='accepted'||mode==='no-button')document.getElementById('challenge').hidden=true;
          if(mode==='no-button')button.remove();
        }}};
      },mode);
      if(mode==='manual-completed-first'){
        solver.solveHCaptcha=async()=>{
          await page.evaluate(()=>{
            window.sdkResponse='fixture-manual-response';
            document.getElementById('challenge').hidden=true;
            document.getElementById('test-details-continue-button').disabled=false;
          });
          return 'fixture-late-service-response';
        };
      }else solver.solveHCaptcha=async()=> 'fixture-solved-token';
      const driver={evaluate:(...args)=>page.evaluate(...args),
        waitForFunction:(fn,arg,options)=>page.waitForFunction(fn,arg,{...options,timeout:100})};
      const result=await engine.solveHCaptcha(driver);
      assert.equal(result.solved,mode==='accepted'||mode==='manual-completed-first');
      if(mode==='manual-completed-first'){
        assert.equal(await page.evaluate(()=>window.hcaptcha.getResponse()),'fixture-manual-response');
        assert.equal(await page.locator('textarea').inputValue(),'');
        assert.match(result.detail,/保留当前验证结果/);
      }
      if(mode==='callback-only'){
        assert.equal(await page.locator('button').isEnabled(),true);
        assert.equal(await page.evaluate(()=>window.hcaptcha.getResponse()),'');
      }
      if(!result.solved)assert.match(result.detail,/控件未确认完成/);
    } finally {await page.close();}
  });
});

test('hCaptcha accepts the official React fingerprint when the SDK response is hidden', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const solver = require(path.join(root, 'yescaptcha-solver'));
  const original = solver.solveHCaptcha;
  let calls = 0;
  solver.solveHCaptcha = async () => { calls++; return 'fixture-token'; };
  t.after(() => { solver.solveHCaptcha = original; });
  const page = await browser.newPage();
  try {
    await page.route('https://newassets.hcaptcha.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div></div>' }));
    await page.setContent('<div class="test-details-captcha"></div>' +
      '<iframe id="widget" src="https://newassets.hcaptcha.com/captcha/v1/fixture?sitekey=fixture-sitekey"></iframe>' +
      '<textarea name="h-captcha-response"></textarea>' +
      '<button id="test-details-continue-button">Continue</button>' +
      '<scr' + 'ipt>window.hcaptcha = { getResponse: () => "" };</scr' + 'ipt>');
    await page.evaluate(() => {
      const widget = document.getElementById('widget');
      widget["__reactFiber$fixture"] = { memoizedProps: {
        sitekey: 'fixture-sitekey',
        onVerify: () => {},
        value: { fingerprint: 'fixture-fingerprint', setFingerprint() {} }
      } };
    });
    const result = await loadEngine({}, { yescaptchaKey: 'fixture-key' }).solveHCaptcha(page);
    assert.equal(result.solved, true, JSON.stringify(result));
    assert.match(result.detail, /保留当前验证结果/);
    assert.equal(calls, 1);
    assert.equal(await page.locator('textarea').inputValue(), '');
  } finally { await page.close(); }
});

test('selection does not submit while hCaptcha is unresolved even if Continue is enabled', async t => {
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('https://newassets.hcaptcha.com/**',route=>route.fulfill({contentType:'text/html',body:'<div></div>'}));
  await page.setContent('<button id="test-location-continue-button">Continue</button>' +
    '<iframe src="https://newassets.hcaptcha.com/widget#frame=checkbox"></iframe>' +
    '<iframe src="https://newassets.hcaptcha.com/widget#frame=challenge"></iframe>' +
    '<button id="test-details-continue-button" onclick="window.submissions++">Continue</button>' +
    '<script>window.submissions=0;window.hcaptcha={getResponse:()=>""};</script>');
  let solves=0;
  const driver={locator:s=>page.locator(s),evaluate:(...args)=>page.evaluate(...args),
    frameLocator:()=>({locator:()=>({click:async()=>{}})}),waitForTimeout:()=>page.waitForTimeout(5)};
  const result=await loadEngine().attemptSelection(driver,{click:async()=>{}},{autoSolve:async()=>{
    solves++;return {solved:false,detail:'fixture challenge unresolved'};
  }});
  assert.equal(result.outcome,'verification_required');
  assert.equal(await page.evaluate(()=>window.submissions),0);
  assert.equal(solves,2);
});

test('selection resumes after manual verification without a chat reply and rechecks date and center', async t => {
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('https://newassets.hcaptcha.com/**',route=>route.fulfill({contentType:'text/html',body:'<div></div>'}));
  await page.route('https://satreg.collegeboard.org/**',route=>route.fulfill({contentType:'text/html',body:
    '<h1>Confirm Your Test Details</h1><p id="date">Saturday, December 5, 2026</p><p id="center">Zone B</p>' +
    '<button id="test-location-continue-button">Continue</button>' +
    '<iframe src="https://newassets.hcaptcha.com/widget#frame=checkbox"></iframe>' +
    '<iframe id="challenge" src="https://newassets.hcaptcha.com/widget#frame=challenge"></iframe>' +
    '<button id="test-details-continue-button" onclick="window.submissions++;history.pushState({},\'\',\'/register/photoUpload\')">Continue</button>' +
    '<script>window.submissions=0;window.hcaptcha={getResponse:()=>window.sdkResponse||""};</script>'}));
  await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  let handoffs=0;
  const bounded=locator=>new Proxy(locator,{get(target,key){
    if(key==='first')return ()=>bounded(target.first());
    if(key==='waitFor')return options=>target.waitFor({...options,timeout:100});
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const driver={url:()=>page.url(),locator:s=>bounded(page.locator(s)),evaluate:(...args)=>page.evaluate(...args),context:()=>page.context(),
    frameLocator:()=>({locator:()=>({click:async()=>{}})}),waitForTimeout:()=>page.waitForTimeout(5),
    waitForURL:(predicate,options)=>page.waitForURL(predicate,{...options,timeout:100})};
  const result=await loadEngine().attemptSelection(driver,{click:async()=>{}},{expectedDate:'2026-12-05',expectedCenter:'Zone B',
    autoSolve:async()=>({solved:false,detail:'fixture waiting for human'}),manual:async(message,ready)=>{
      handoffs++;
      assert.match(message,/无需等待聊天回复/);
      assert.equal(await ready(),false);
      assert.equal(await page.evaluate(()=>window.submissions),0);
      await page.evaluate(()=>{
        window.sdkResponse='fixture-manual-response';
        document.getElementById('challenge').hidden=true;
        document.getElementById('date').textContent='December 6, 2026';
      });
      assert.equal(await ready(),false,'a different date must not resume submission');
      await page.locator('#date').evaluate(el=>{el.textContent='Saturday, December 5, 2026';});
      await page.locator('#center').evaluate(el=>{el.textContent='Other Center';});
      assert.equal(await ready(),false,'a different center must not resume submission');
      await page.locator('#center').evaluate(el=>{el.textContent='Zone B';});
      assert.equal(await ready(),true);
    }});
  assert.equal(handoffs,1);
  assert.equal(await page.evaluate(()=>window.submissions),1);
  assert.equal(result.outcome,'advanced');
});

test('captcha auto-solve submits to YesCaptcha, verifies page progress and falls back without a key', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const solver = require(path.join(root, 'yescaptcha-solver'));
  const originalSolve = solver.solveFunCaptcha;
  const calls = [];
  solver.solveFunCaptcha = async options => {
    calls.push(options);
    if (calls.length <= 2) return 'fixture-token';
    throw new Error('fixture solver offline');
  };
  t.after(() => { solver.solveFunCaptcha = originalSolve; });
  const logs = [];
  const engine = loadEngine({}, { satAccount: 'a@example.invalid', satPassword: 'fixture', yescaptchaKey: 'fixture-key' });

  // 页面在收到 arkose:token 事件后自行移除验证码（模拟注入被接受并推进）
  const keyPage = await browser.newPage();
  await keyPage.setContent('<iframe id="arkose-frame" src="https://client-api.arkoselabs.com/fc/gc/?public-key=TEST-KEY-123"></iframe>' +
    '<script>window.addEventListener("arkose:token", () => document.getElementById("arkose-frame").remove());</script>');
  assert.equal(await engine.extractArkosePublicKey(keyPage), 'TEST-KEY-123');
  const solved = await engine.solveCaptcha(keyPage, msg => logs.push(msg), { verifyTimeout: 3000 });
  assert.equal(solved.solved, true, JSON.stringify(solved));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientKey, 'fixture-key');
  assert.equal(calls[0].websitePublicKey, 'TEST-KEY-123');
  assert.match(logs.join('\n'), /YesCaptcha 自动识别/);

  // 页面不接受注入：打码令牌已消耗但页面未推进，必须如实转人工
  const stuckPage = await browser.newPage();
  await stuckPage.setContent('<h1>Confirm Your Test Details</h1><div id="fc-iframe-wrap">Verification</div>');
  const failed = await engine.solveCaptcha(stuckPage, () => {}, { verifyTimeout: 500 });
  assert.equal(failed.solved, false);
  assert.match(failed.detail, /未推进/);
  assert.equal(calls.length, 2);

  // 打码服务本身失败：如实报告，不谎称通过
  const offline = await engine.solveCaptcha(stuckPage, () => {}, { verifyTimeout: 500 });
  assert.equal(offline.solved, false);
  assert.match(offline.detail, /fixture solver offline/);
  assert.equal(calls.length, 3);

  // 未配置密钥：不打码、不注入、直接转人工
  const noKeyEngine = loadEngine({}, { satAccount: 'a@example.invalid', satPassword: 'fixture' });
  const before = calls.length;
  const skipped = await noKeyEngine.solveCaptcha(stuckPage, () => {}, { verifyTimeout: 500 });
  assert.equal(skipped.solved, false);
  assert.match(skipped.detail, /未配置/);
  assert.equal(calls.length, before);
});

test('selection auto-solves captcha through YesCaptcha and continues only on verified progress', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const solver = require(path.join(root, 'yescaptcha-solver'));
  const originalSolve = solver.solveFunCaptcha;
  solver.solveFunCaptcha = async () => 'fixture-token';
  t.after(() => { solver.solveFunCaptcha = originalSolve; });
  const engine = loadEngine({}, { satAccount: 'a@example.invalid', satPassword: 'fixture', yescaptchaKey: 'fixture-key' });

  // 注入被接受：验证码移除后 Continue 前进到照片页，选座链路继续自动推进
  const page = await browser.newPage();
  await page.route('https://satreg.collegeboard.org/**', route => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/photoUpload')
    ? '<h1>Upload Your Photo</h1>'
    : '<h1>Confirm Your Test Details</h1>20 minute warning<div id="fc-iframe-wrap" class="test-details-captcha">Verification</div>'
      + '<a id="qc-id-test-location-continue-button" href="#">Continue</a>'
      + '<button id="qc-id-test-details-continue-button" disabled onclick="location.href=\'/register/photoUpload\'">Continue</button>'
      + '<script>window.addEventListener("arkose:token", () => { const w = document.getElementById("fc-iframe-wrap"); if (w) w.remove(); const b = document.getElementById("qc-id-test-details-continue-button"); if (b) b.disabled = false; });</script>' }));
  await page.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  const driver = {
    url: () => page.url(), locator: selector => page.locator(selector),
    getByRole: (...args) => page.getByRole(...args),
    waitForSelector: (selector, options) => page.waitForSelector(selector, { ...options, timeout: 100 }),
    waitForURL: (predicate, options) => page.waitForURL(predicate, { ...options, timeout: 2000 }),
    waitForTimeout: ms => page.waitForTimeout(ms),
    context: () => ({ on() {}, off() {} }),
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    frameLocator: selector => page.frameLocator(selector)
  };
  const solved = await engine.attemptSelection(driver, { click: async () => {} }, { autoSolve: () => engine.solveCaptcha(page, () => {}) });
  assert.equal(solved.outcome, 'advanced', JSON.stringify(solved));

  // 注入不被接受：停在验证码交接，不谎称推进、不继续选座链路
  const stuckPage = await browser.newPage();
  await stuckPage.route('https://satreg.collegeboard.org/**', route => route.fulfill({ contentType: 'text/html', body:
    '<h1>Confirm Your Test Details</h1>20 minute warning<div id="fc-iframe-wrap">Verification</div><button>Continue</button>' }));
  await stuckPage.goto('https://satreg.collegeboard.org/register/testCenterSearch');
  const stuckDriver = {
    url: () => stuckPage.url(), locator: selector => stuckPage.locator(selector),
    getByRole: (...args) => stuckPage.getByRole(...args),
    waitForSelector: (selector, options) => stuckPage.waitForSelector(selector, { ...options, timeout: 100 }),
    waitForURL: (predicate, options) => stuckPage.waitForURL(predicate, { ...options, timeout: 2000 }),
    waitForTimeout: ms => stuckPage.waitForTimeout(ms)
  };
  const handed = await engine.attemptSelection(stuckDriver, { click: async () => {} }, { autoSolve: () => engine.solveCaptcha(stuckPage, () => {}, { verifyTimeout: 500 }) });
  assert.equal(handed.outcome, 'verification_required');
  assert.match(handed.message, /人工完成验证码/);
});

test('stop during browser startup waits for closure before allowing reuse', async () => {
  let launch;
  const pendingLaunch = new Promise(resolve => { launch = resolve; });
  const context = new EventEmitter();
  let pageCreated = false, closed = false, stopped = false;
  context.newPage = async () => { pageCreated = true; };
  context.close = async () => { closed = true; context.emit('close'); };
  const engine = loadEngine({ launchPersistentContext: () => pendingLaunch });
  const worker = engine.runTaskWorker({ task: { id: 'starting', account: 'a', password: 'b' }, onLog() {}, onError: err => assert.fail(err) });
  await new Promise(resolve => setImmediate(resolve));
  const stop = worker.stop().then(() => { stopped = true; });
  assert.equal(stopped, false);
  launch(context);
  await stop;
  assert(closed);
  assert.equal(pageCreated, false);
});

test('api client: availability mapping never reports a false no-seat result', () => {
  const center = (over = {}) => ({ tcCd: '62250', tcName: 'Zone A', admins: [{ seatAvailable: false, tcAdminStatus: 'Open', ...over }] });
  assert.equal(satregApi.matchAvailability([], []).status, 'unknown');
  assert.equal(satregApi.matchAvailability([center()], ['62250']).status, 'unavailable');
  assert.equal(satregApi.matchAvailability([center({ seatAvailable: true })], ['62250']).status, 'available');
  assert.equal(satregApi.matchAvailability([center({ seatAvailable: 'Y' })], ['62250']).status, 'available');
  assert.equal(satregApi.matchAvailability([center()], ['99999']).status, 'unknown');
  assert.equal(satregApi.matchAvailability([center({ tcAdminStatus: 'Closed' })], ['62250']).status, 'unavailable');
  assert.equal(satregApi.matchAvailability([center({ tcAdminStatus: 'Suspended' })], ['62250']).status, 'unavailable');
  const noDetail = satregApi.matchAvailability([{ tcCd: '62250', tcName: 'Zone A', admins: [] }], ['62250']);
  assert.equal(noDetail.status, 'unknown');
  assert.match(noDetail.reason, /admin/);
  const partial = satregApi.matchAvailability([center()], ['62250', '62251']);
  assert.equal(partial.status, 'unknown');
  assert.match(partial.reason, /部分目标考点/);
  assert.equal(satregApi.matchAvailability([center()], []).status, 'unavailable');
});

test('api client: replay body is rebuilt from the captured official request only', () => {
  const captured = satregApi.pickSearchTemplate({
    asmtEventId: 12345, eventStartDt: '2026-12-05T00:00:00', tcCountryISOCode: 'hk',
    tcAsmtId: ['99'], tcAsmtFamilyCd: 1, appToken: 'session-token-not-logged', isSimpleSearch: true
  });
  assert.equal(captured.eventStartDt, '2026-12-05');
  assert.equal(captured.tcCountryISOCode, 'HK');
  assert.equal(captured.appToken, 'session-token-not-logged');
  const body = satregApi.buildReplayBody(captured, { targetDate: '2026-12-05', targetCountryCode: 'HK' });
  assert.equal(body.asmtEventId, 12345);
  assert.deepEqual(body.tcAsmtId, ['99']);
  assert.equal(body.appToken, 'session-token-not-logged');
  assert.equal(satregApi.buildReplayBody(captured, { targetDate: '2027-03-06', targetCountryCode: 'HK' }), null);
  assert.equal(satregApi.buildReplayBody(captured, { targetDate: '2026-12-05' }), null);
  assert.equal(satregApi.pickSearchTemplate({ eventStartDt: '2026-12-05' }), null);
  assert.equal(satregApi.buildSearchBody({ eventStartDt: '2026-12-05', countryCode: 'HK' }), null);
  assert.equal(satregApi.buildSearchBody({ eventStartDt: '2026-12-05', countryCode: 'HK', asmtEventId: 7 }).asmtEventId, 7);
  assert.equal(satregApi.testCenterList({ message: 'expired' }), null);
  assert.deepEqual(satregApi.testCenterList({ testCenters: [] }), []);
});

test('api query: template capture keeps appToken in memory and replay maps the official payload', async () => {
  const engine = loadEngine();
  const page = new EventEmitter();
  const context = new EventEmitter();
  page.context = () => context;
  page.url = () => 'https://satreg.collegeboard.org/register/testCenterSearch';
  const stop = engine.watchAdmins(page, () => {});
  const request = new EventEmitter();
  request.method = () => 'POST';
  request.url = () => 'https://satreg-api.collegeboard.org/msregadmintestcenter-prod/student/search-test-center-admins';
  request.postDataJSON = () => ({ asmtEventId: 77, eventStartDt: '2026-12-05', tcCountryISOCode: 'HK', appToken: 'memory-only' });
  page.emit('request', request);
  assert.equal(page.__satregSearchTemplate.appToken, 'memory-only');

  let sent = null;
  page.evaluate = async (fn, options) => {
    sent = options;
    return { ok: true, status: 200, signed: true, authMode: 'sigv4', centerCount: 1,
      data: { testCenters: [{ tcCd: '62250', tcName: 'Zone A', tcAdminStatus: 'Open',
        admins: [{ seatAvailable: true, tcAdminStatus: 'Open' }] }] } };
  };
  const result = await engine.queryCentersViaApi(page, { targetDate: '2026-12-05', targetCountryCode: 'HK' }, ['62250']);
  assert.equal(result.status, 'available', JSON.stringify(result));
  assert.equal(result.matchedCenter, 'Zone A');
  assert.equal(result.source, 'api');
  assert.equal(result.authMode, 'sigv4');
  assert.equal(sent.body.asmtEventId, 77);
  assert.equal(sent.body.appToken, 'memory-only');
  assert.equal(sent.body.tcCountryISOCode, 'HK');
  stop();
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(context.listenerCount('response'), 0);

  const noTemplate = new EventEmitter();
  noTemplate.url = () => 'https://satreg.collegeboard.org/register/testCenterSearch';
  const missing = await engine.queryCentersViaApi(noTemplate, { targetDate: '2026-12-05', targetCountryCode: 'HK' }, ['62250']);
  assert.equal(missing.status, 'unknown');
  noTemplate.url = () => 'https://example.invalid/';
  assert.match((await engine.queryCentersViaApi(noTemplate, {}, [])).reason, /不在报名官网域/);
});
