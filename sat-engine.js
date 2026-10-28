const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const captchaSolver = require('./yescaptcha-solver');
const satregApi = require('./satreg-api-client');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// 读取全局设置
function getGlobalSettings() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return db.settings || {};
    }
  } catch (e) {}
  return {};
}

// Pushplus 微信推送
async function sendPushplus(token, title, content) {
  if (!token) return;
  try {
    await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        title,
        content: `<h3>${title}</h3><p>${content}</p><p>时间：${new Date().toLocaleString()}</p>`,
        template: 'html'
      })
    });
  } catch (err) {
    console.error('Pushplus 推送失败', err.message);
  }
}

// 只读取完整卡片；名称匹配与时段判断必须属于同一考点。
async function inspectTestCenters(page, targets) {
  const result = await page.evaluateHandle(targets => {
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const controlSelector = '[id^="qc-id-tc-select-button"], a[role="button"], button, input[value*="Select"]';
    const isSlot = el => el.id.startsWith('qc-id-tc-select-button') || /^(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|Select)$/i.test((el.innerText || el.value || '').trim());
    const markers = [...document.querySelectorAll(controlSelector)].filter(el => visible(el) && isSlot(el));
    for (const el of document.querySelectorAll('p, span, div')) {
      if (visible(el) && /^No seats available\.?$/i.test(el.innerText.trim()) &&
          ![...el.children].some(child => /^No seats available\.?$/i.test(child.innerText?.trim() || ''))) markers.push(el);
    }
    const cards = [];
    for (const marker of markers) {
      let card = marker.parentElement;
      while (card && card !== document.body) {
        const heading = card.querySelector('h2, h3, h4, strong, [class*="name"]');
        if (heading && markers.filter(el => card.contains(el)).length === 1) {
          const text = [card, ...card.querySelectorAll('*')].flatMap(el => [...el.childNodes]
            .filter(node => node.nodeType === 3).map(node => node.textContent)).join(' ').replace(/\s+/g, ' ').trim();
          const unavailable = /No seats available\.?/i.test(text);
          const button = !unavailable && isSlot(marker) && !marker.matches(':disabled, [disabled], [aria-disabled="true"]') ? marker : null;
          cards.push({ text, name: heading.innerText, button, unavailable });
          break;
        }
        card = card.parentElement;
      }
    }
    const matches = keyword => cards.filter(card => /^\d+$/.test(keyword)
      ? (card.text.match(/\d+/g) || []).includes(keyword)
      : card.text.toLowerCase().includes(keyword.toLowerCase()));
    // 官网卡片不展示考点代码；控制台保存的代码和名称是同一考点的别名。
    const names = targets.filter(target => !/^\d+$/.test(target));
    const matchTargets = names.length ? names : targets;
    const selected = matchTargets.length ? [...new Set(matchTargets.flatMap(matches))] : cards;
    const available = selected.find(card => card.button);
    if (available) return { status: 'available', matchedCenter: available.name, selectTargetBtn: available.button };
    if (selected.length && selected.every(card => card.unavailable) && (!matchTargets.length || matchTargets.every(target => matches(target).length))) {
      return { status: 'unavailable' };
    }
    return { status: 'unknown', reason: '未找到完整目标卡片或可用时段', markerCount: markers.length, cardCount: cards.length };
  }, targets);
  try {
    const status = await (await result.getProperty('status')).jsonValue();
    const reason = await (await result.getProperty('reason')).jsonValue();
    const matchedCenter = await (await result.getProperty('matchedCenter')).jsonValue();
    const selectTargetBtn = (await result.getProperty('selectTargetBtn')).asElement();
    const markerCount = await (await result.getProperty('markerCount')).jsonValue();
    const cardCount = await (await result.getProperty('cardCount')).jsonValue();
    return { status, reason, matchedCenter, selectTargetBtn, markerCount, cardCount };
  } finally {
    await result.dispose();
  }
}

// 官网 search-test-center-admins 返回每个考点的 admin 明细（含 capacity 与 seatAvailable），
// 这是「卡片显示可选」与「官网拒绝分配」之间唯一能对上的证据。
function watchTestCenterAdmins(page, onLog) {
  const seen = new Set();
  const handler = async r => {
    if (!/search-test-center-admins/.test(r.url())) return;
    try {
      const data = await r.json();
      const list = data && (data.testCenters || data.data?.testCenters || data.data || data);
      if (!Array.isArray(list)) return;
      for (const center of list.slice(0, 12)) {
        for (const admin of (center.admins || []).slice(0, 3)) {
          const key = `${center.tcCd}|${admin.tamTCAdminId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          onLog(`考点明细｜${center.tcName || center.tcCd}(${center.tcCd}) ${admin.eventStartTime || '?'} ` +
            `可售=${admin.seatAvailable} 容量=${admin.totalCapacity ?? '?'} 已预留=${admin.totalReservedCap ?? '?'} ` +
            `admin=${admin.tamTCAdminId || '?'} 状态=${admin.tcAdminStatus || '?'}`);
          // 一次性留证：完整 admin 对象，用于核对「卡片可选」与「服务端拒绝」的矛盾根因。
          if (!seen.has('RAW')) {
            seen.add('RAW');
            onLog(`admin原始对象｜${JSON.stringify(admin).slice(0, 700)}`);
            onLog(`center原始对象｜${JSON.stringify(center).slice(0, 500)}`);
          }
        }
      }
    } catch {}
  };
  page.context().on('response', handler);

  // 顺带截获官网自己发出的查位 POST 请求体（含考期 asmtEventId 与会话级 appToken），
  // 后续只读接口查位就复用这份模板，不再每次点页面。模板只留在页面对象内存里，不打印、不落盘。
  const captureRequest = request => {
    try {
      if (request.method() !== 'POST') return;
      if (!/search-test-center-admins/.test(request.url())) return;
      const postData = typeof request.postDataJSON === 'function' ? request.postDataJSON() : null;
      const template = satregApi.pickSearchTemplate(postData);
      if (template) {
        page.__satregSearchTemplate = template;
        // 端点以官网真实请求为准：资源里的常量带分号等细节，不能靠猜。
        try {
          const parsed = new URL(request.url());
          page.__satregSearchUrl = parsed.origin + parsed.pathname;
        } catch (e) { /* 保持默认端点 */ }
      }
    } catch (e) {}
  };
  if (typeof page.on === 'function') page.on('request', captureRequest);

  return () => {
    try { if (typeof page.off === 'function') page.off('request', captureRequest); } catch (e) {}
    try { page.context().off('response', handler); } catch (e) {}
  };
}

// 查询响应里的考点数组层级不固定，统一在这里取。
function extractTestCenters(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = payload.testCenters || payload.data?.testCenters || payload.data || payload;
  return Array.isArray(list) ? list : [];
}

async function queryTestCentersOnce(page, targets, timeout = 15000, onLog = () => {}) {
  const find = page.locator('#test-center-country-find-button-enabled:visible, button:visible:has-text("Find a Test Center"), button:visible:has-text("Search"), input[value*="Find"]:visible').first();
  if (!await find.isVisible() || !await find.isEnabled()) return { status: 'unknown', reason: '查询入口不可用，请检查登录状态或验证码' };
  // 旧卡片必须在本轮请求后重绘；结果未更新时宁可未知，不复用旧状态。
  await page.evaluate(() => {
    window.__satQueryObserver?.disconnect();
    const markerSelector = '[id^="qc-id-tc-select-button"], input[value*="Select"]';
    const relevant = node => node.nodeType === 1 && (node.matches(markerSelector) || node.querySelector(markerSelector) || /No seats available|^\s*(?:Select|\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*$/i.test(node.textContent || ''));
    window.__satQueryState = { changed: false, updatedAt: 0 };
    window.__satQueryObserver = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(relevant) ||
          (record.type === 'characterData' && /No seats available/i.test(record.oldValue + record.target.textContent)) ||
          (record.type === 'attributes' && relevant(record.target)))) {
        window.__satQueryState = { changed: true, updatedAt: Date.now() };
      }
    });
    window.__satQueryObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
  });
  const requests = new Set();
  const track = request => {
    // shortcut: 查询接口路径尚待官网复核，路径变更时保守返回未知并更新匹配规则。
    if (['xhr', 'fetch'].includes(request.resourceType()) && /test[-_]?cent(?:er|re)/i.test(request.url()) &&
        new URL(request.url()).hostname.endsWith('.collegeboard.org')) requests.add(request);
  };
  page.on('request', track);
  try {
    const responsePromise = page.waitForResponse(response => requests.has(response.request()), { timeout }).catch(() => null);
    await find.click({ timeout });
    const response = await responsePromise;
    if (!response) return { status: 'unknown', reason: '本轮官网查询未收到响应' };
    if (!response.ok()) {
      let errBody = '';
      try { errBody = (await response.text()).replace(/\s+/g, ' ').slice(0, 180); } catch (e) {}
      const pageHint = await page.evaluate(() => {
        const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        const m = t.match(/(?:Sorry|Error|unable|invalid|expired|session)[^.]{0,120}\./i);
        return m ? m[0].trim() : '';
      }).catch(() => '');
      onLog('[查询失败诊断] HTTP ' + response.status() + ' ' + new URL(response.url()).pathname + ' 响应=' + (errBody || '空') + ' 页面提示=' + (pageHint || '无'));
      return { status: 'unknown', reason: '本轮官网查询返回 HTTP ' + response.status() };
    }
    if (await response.finished()) return { status: 'unknown', reason: '本轮官网查询响应已失效' };
    // 本轮响应必须真的带回考点数据。重复查询得到相同结果时官网不会重绘卡片，
    // 只看 DOM 变化会把正常结果误判为未知；只要响应属于本轮且含考点数据，即可采信已渲染卡片。
    const payload = await response.json().catch(() => null);
    const payloadCenters = extractTestCenters(payload);
    const hasCenterPayload = payloadCenters.length > 0;
    // 有数据不等于已渲染：等目标考点名称或「无位」文案真的出现在页面上，最多 8 秒。
    if (hasCenterPayload) {
      const expectedNames = payloadCenters.slice(0, 25)
        .map(center => String((center && (center.tcName || center.tcCd)) || '').trim().toLowerCase())
        .filter(name => name.length > 3);
      await page.waitForFunction(names => {
        const text = (document.body ? document.body.innerText : '').toLowerCase();
        return /no seats available/i.test(text) || names.some(name => text.includes(name));
      }, expectedNames, { timeout: Math.min(timeout, 8000) }).catch(() => {});
    }
    if (!hasCenterPayload) {
      // 响应不带考点数据（空体/错误体）时必须看到本轮重绘，避免复用失败查询留下的旧卡片。
      const changed = await page.waitForFunction(() => window.__satQueryState?.changed, null, { timeout })
        .then(() => true, () => false);
      if (!changed) {
        const bodyHint = await page.evaluate(() => {
          const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
          const m = t.match(/(?:Sorry|Error|unable|invalid|expired|session)[^.]{0,120}\./i);
          return m ? m[0].trim() : '';
        }).catch(() => '');
        onLog('[查询失败诊断] HTTP ' + response.status() + ' 响应体不含考点数据（长度 ' + JSON.stringify(payload).length + '）页面提示=' + (bodyHint || '无'));
        return { status: 'unknown', reason: '本轮官网响应未包含考点数据，且页面未更新结果' };
      }
    }
    // 等渲染稳定：有 DOM 变更时静置 300ms；无变更时只需等 loading 结束。
    await page.waitForFunction(() => {
      const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(el => el.getClientRects().length);
      const state = window.__satQueryState;
      return !busy && (!state?.changed || Date.now() - state.updatedAt >= 300);
    }, null, { timeout: Math.min(timeout, 5000) }).catch(() => {});
    let result = await inspectTestCenters(page, targets);
    if (result.status !== 'unknown' || !hasCenterPayload) return result;
    // 响应含数据但卡片尚未渲染：再等一次重绘后复查，避免把“正在渲染”误报为未知。
    await page.waitForFunction(() => window.__satQueryState?.changed, null, { timeout: Math.min(timeout, 4000) }).catch(() => {});
    await page.waitForFunction(() => ![...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')]
      .some(el => el.getClientRects().length), null, { timeout: 2000 }).catch(() => {});
    result = await inspectTestCenters(page, targets);
    if (result.status === 'unknown') {
      const text = await page.evaluate(() => {
        const main = document.querySelector('main, [role="main"], #main-content') || document.body;
        return main ? (main.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : '';
      }).catch(() => '');
      onLog('[查询诊断] 响应考点=' + payloadCenters.length + ' 卡片标记=' + (result.markerCount == null ? '?' : result.markerCount) + ' 卡片=' + (result.cardCount == null ? '?' : result.cardCount) + ' 页面=' + (text || '空'));
    }
    return result;
  } catch (error) {
    return { status: 'unknown', reason: `本轮查询结果未确认：${error.message.split('\n')[0]}` };
  } finally {
    page.off('request', track);
    await page.evaluate(() => window.__satQueryObserver?.disconnect()).catch(() => {});
  }
}

// 单次 unknown 多半是卡片渲染时序抖动；重试同一查询，仍失败才对外报未知。
async function queryTestCenters(page, targets, timeout = 15000, onLog = () => {}) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await queryTestCentersOnce(page, targets, timeout, onLog);
    if (result.status !== 'unknown') return result;
    if (/查询入口不可用/.test(result.reason || '')) return result;
    last = result;
    if (attempt < 3) {
      onLog('本轮查询结果未确认（' + result.reason + '），正在重试同一查询（' + attempt + '/3）...');
      await page.waitForTimeout(1200).catch(() => {});
    }
  }
  return last;
}

// 用官网原生查位请求模板，在已登录页面内重放 search-test-center-admins。
// 只做只读查位；选座/提交/付款仍全部走页面与人工，绝不接管写接口。
async function queryTestCentersViaApi(page, task, targets, timeout = 10000) {
  let currentUrl = '';
  try { currentUrl = page.url(); } catch (e) {}
  if (!/^https:\/\/(?:satreg|mysat)\.collegeboard\.org\//.test(currentUrl)) {
    return { status: 'unknown', reason: '当前页面不在报名官网域，跳过接口查位' };
  }

  const template = page && page.__satregSearchTemplate;
  const body = satregApi.buildReplayBody(template, task || {});
  if (!body) {
    return {
      status: 'unknown',
      reason: template
        ? '捕获的查位请求与当前考期/地区不一致'
        : '尚未捕获官网查位请求（首轮会先走页面查位）'
    };
  }

  let response;
  try {
    response = await satregApi.searchTestCenterAdmins(page, {
      body,
      url: page.__satregSearchUrl || undefined,
      timeoutMs: timeout
    });
  } catch (error) {
    return {
      status: 'unknown',
      error: true,
      reason: '接口查位异常：' + String((error && error.message) || error).split('\n')[0]
    };
  }

  if (!response || !response.ok) {
    const status = response && response.status ? response.status : '-';
    const detail = response && response.error ? '，' + response.error : '';
    return { status: 'unknown', error: true, reason: '接口查位未成功（HTTP ' + status + detail + '）' };
  }

  const list = satregApi.testCenterList(response.data);
  if (!list) {
    return { status: 'unknown', error: true, reason: '接口响应格式未识别（没有考点列表）' };
  }

  const result = satregApi.matchAvailability(list, targets);
  result.source = 'api';
  result.signed = !!response.signed;
  result.authMode = response.authMode || '';
  result.durationMs = response.durationMs;
  result.centerCount = response.centerCount;
  return result;
}

// =========================================================================
// 验证码自动识别（YesCaptcha / Arkose FunCaptcha）
// 识别成功并注入后由页面自行推进；注入无效、未配置密钥或打码失败时保留浏览器转人工。
// =========================================================================

const ARKOSE_SELECTOR = 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="verification"], #fc-iframe-wrap';

// 提取官网 Arkose 控件公开密钥；提取不到时由打码模块使用默认值。
async function extractArkosePublicKey(page) {
  try {
    const src = await page.locator('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]').first().getAttribute('src') || '';
    const match = src.match(/[?&](?:public[-_]?key|pk|sitekey)=([^&]+)/i);
    if (match) return decodeURIComponent(match[1]);
  } catch (e) {}
  return '';
}

// 令牌注入：覆盖常见站点接收方式（隐藏表单域 / Arkose 客户端对象 / 自定义事件）。
// 注入是否被当前页面接受以页面推进校验为准，不接受时转人工，不谎称通过。
async function injectArkoseToken(page, token) {
  return await page.evaluate(token => {
    const hooks = [];
    const input = document.querySelector('input[name*="arkose" i], input[id*="arkose" i], input[name="fc-token"], input[name*="fc-token" i], input[name*="captcha" i][type="hidden"], input[name*="token" i][type="hidden"]');
    if (input) {
      input.value = token;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      hooks.push('input:' + (input.name || input.id));
    }
    try {
      const arkose = window.arkose;
      if (arkose) {
        if (typeof arkose.setSession === 'function') { arkose.setSession(token); hooks.push('arkose.setSession'); }
        if (arkose.enforcement) { arkose.enforcement.sessionToken = token; hooks.push('arkose.enforcement.sessionToken'); }
        arkose.sessionToken = token;
        hooks.push('arkose.sessionToken');
      }
    } catch (e) { hooks.push('arkose:error'); }
    window.dispatchEvent(new CustomEvent('arkose:token', { detail: token }));
    hooks.push('event:arkose:token');
    return hooks;
  }, token);
}

// 本地调试用：保留当前任务的活动页面，便于只读查询页面状态（不参与业务逻辑）。
let activeDebugPage = null;

// 单次自动识别：读取全局密钥 → 提交打码 → 注入 → 校验页面是否自行推进。
async function solveCaptchaOnce(page, onLog = () => {}, options = {}) {
  const verifyTimeout = options.verifyTimeout || 12000;
  const clientKey = (getGlobalSettings().yescaptchaKey || '').trim();
  if (!clientKey) return { solved: false, detail: '未配置 YesCaptcha 密钥，跳过验证码自动识别' };
  const publicKey = await extractArkosePublicKey(page);
  onLog(`检测到 Arkose 验证码，正在提交 YesCaptcha 自动识别${publicKey ? `（publicKey: ${publicKey}）` : ''}...`);
  let token;
  try {
    token = await captchaSolver.solveFunCaptcha({ clientKey, websiteURL: page.url(), websitePublicKey: publicKey || undefined });
  } catch (err) {
    return { solved: false, detail: `YesCaptcha 识别失败：${err.message}` };
  }
  if (!token) return { solved: false, detail: 'YesCaptcha 未返回有效令牌，转人工核对' };
  onLog('YesCaptcha 识别完成，正在注入令牌并等待页面推进...');
  const hooks = await injectArkoseToken(page, token).catch(() => []);
  // 只认验证码控件本身消失或隐藏：确认页文本在验证码弹出前就已存在，不能作为通过判据。
  const advanced = await page.waitForFunction(() => {
    const captcha = document.querySelector('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="verification"], #fc-iframe-wrap');
    return !captcha || captcha.getClientRects().length === 0 || getComputedStyle(captcha).visibility === 'hidden';
  }, null, { timeout: verifyTimeout }).then(() => true, () => false);
  if (advanced) return { solved: true, detail: `验证码已自动通过（注入点：${hooks.join(', ') || '页面自行处理'}）` };
  return { solved: false, detail: '令牌已注入但页面未推进，注入方式可能不适用于当前页面，转人工核对' };
}

// 确认页的 hCaptcha：解算后必须在页面里触发 React 的 onVerify 回调，否则确认按钮一直禁用。
async function injectHCaptchaToken(page, token) {
  return await page.evaluate(token => {
    const via = [];
    let el = document.querySelector('iframe[src*=hcaptcha]');
    let fiberKey = null;
    while (el && !fiberKey) {
      fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) el = el.parentElement;
    }
    if (fiberKey) {
      let fiber = el[fiberKey];
      let depth = 0;
      while (fiber && depth++ < 40) {
        const props = fiber.memoizedProps;
        if (props && typeof props.onVerify === 'function') {
          props.onVerify(token, 'yescaptcha');
          via.push('react-onVerify');
          break;
        }
        fiber = fiber.return;
      }
    }
    document.querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]').forEach(el => {
      el.value = token;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    via.push('textarea');
    return via.join('+');
  }, token).catch(() => '注入失败');
}

// 在浏览器上下文读取官网控件状态：按钮启用、无可见挑战，且官网应用层已拿到验证结果。
// 官网把 hCaptcha 的 onVerify 结果存进 React CaptchaContext.fingerprint（save-reg-request 提交的就是它），
// 但 window.hcaptcha.getResponse() 不一定可见；只认 SDK 会把真实通过的验证误判成未完成。
// 安全规则仍然保留：仅按钮启用（既无 fingerprint 也无 SDK response）不算通过。
function hCaptchaReleased() {
  const btn = document.querySelector('[id$="test-details-continue-button"]');
  if (!btn || btn.disabled) return false;
  const challengeOpen = [...document.querySelectorAll('iframe[src*="frame=challenge"]')]
    .some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  if (challengeOpen) return false;

  // 官网应用层结果：从验证码组件向上找 CaptchaContext Provider 的 value.fingerprint。
  const appFingerprint = (() => {
    try {
      for (const seed of [document.querySelector('.test-details-captcha'), document.querySelector('iframe[src*="hcaptcha"]')]) {
        let node = seed;
        while (node && !Object.keys(node).some(key => key.startsWith('__reactFiber$'))) node = node.parentElement;
        const fiberKey = node && Object.keys(node).find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? node[fiberKey] : null;
        let depth = 0;
        while (fiber && depth++ < 80) {
          const value = fiber.memoizedProps?.value;
          if (value && typeof value.fingerprint === 'string' && typeof value.setFingerprint === 'function') return value.fingerprint;
          fiber = fiber.return;
        }
      }
    } catch {}
    return '';
  })();
  if (appFingerprint.trim()) return true;

  try {
    const response = window.hcaptcha?.getResponse?.();
    if (typeof response === 'string' && response.trim()) return true;
  } catch {}
  return false;
}

async function solveHCaptchaOnce(page, onLog = () => {}) {
  const clientKey = (getGlobalSettings().yescaptchaKey || '').trim();
  if (!clientKey) return { solved: false, detail: '未配置 YesCaptcha 密钥，跳过 hCaptcha 自动识别' };
  const sitekey = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*=hcaptcha]');
    const fromSrc = iframe ? (iframe.src.match(/sitekey=([^&]+)/) || [])[1] || '' : '';
    let el = iframe;
    let key = null;
    while (el && !key) {
      key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!key) el = el.parentElement;
    }
    if (!key) return fromSrc;
    let fiber = el[key];
    let depth = 0;
    while (fiber && depth++ < 40) {
      const props = fiber.memoizedProps;
      if (props && props.sitekey && typeof props.onVerify === 'function') return props.sitekey;
      fiber = fiber.return;
    }
    return fromSrc;
  }).catch(() => '');
  if (!sitekey) return { solved: false, detail: '未读到 hCaptcha sitekey，转人工' };

  // 打码平台要求与真实页面一致；确认页路径会随流程变化，不能写死。
  const websiteURL = typeof page.url === 'function' ? page.url() : '';
  onLog(`正在用 YesCaptcha 解算 hCaptcha（sitekey: ${sitekey}）...`);
  let token;
  try {
    token = await captchaSolver.solveHCaptcha({
      clientKey,
      websiteURL,
      websiteKey: sitekey
    });
  } catch (err) {
    return { solved: false, detail: `hCaptcha 打码失败：${err.message}` };
  }
  if (!token) return { solved: false, detail: 'hCaptcha 打码未返回令牌' };

  // 人工验证可能先于后台识别结束，不能用稍后返回的令牌覆盖官网的新结果。
  if (await page.evaluate(hCaptchaReleased).catch(() => false)) {
    return { solved: true, detail: '官网验证码控件已完成验证，保留当前验证结果' };
  }

  const injected = await injectHCaptchaToken(page, token);
  onLog(`hCaptcha 令牌已回填（${injected}），等待页面放行...`);
  const released = await page.waitForFunction(hCaptchaReleased, null, { timeout: 15000 }).then(() => true, () => false);
  return released
    ? { solved: true, detail: 'hCaptcha 官网控件已完成验证，确认按钮已放行' }
    : { solved: false, detail: '令牌已回填，但官网验证码控件未确认完成，请人工验证' };
}

// 核心抢位 Worker
function runTaskWorker({ task, onLog, onPoll, onNeedsAction, onResume, onError, onExit }) {
  let isStopped = false;
  let browserContext = null;
  let page = null;
  let stopWatchingAdmins = null;
  let contextClosed;
  let wakePoll;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });

  async function waitForManual(message, ready) {
    onLog(message);
    onNeedsAction(null, { outcome: 'verification_required', message });
    await captureScreenshot();
    while (!isStopped && !await ready()) await page.waitForTimeout(1000);
    if (isStopped) throw new Error('任务已停止');
    if (onResume) onResume();
    onLog('人工处理已完成，继续自动查位。');
  }

  // 验证码自动识别配额：一次选座可能连续触发验证码，失位重试也要重新过一遍；
  // 上限 6 次、间隔至少 30 秒，兼顾额度与成功率。
  let captchaAttempts = 0;
  let lastCaptchaAttemptAt = 0;
  async function autoSolveCaptcha() {
    if (captchaAttempts >= 6 || Date.now() - lastCaptchaAttemptAt < 30000) {
      return { solved: false, detail: captchaAttempts >= 6 ? '本次运行验证码自动识别次数已用完（6 次）' : '距上次自动识别不足 30 秒，暂不重复提交' };
    }
    captchaAttempts++;
    lastCaptchaAttemptAt = Date.now();
    // 确认页是 hCaptcha，登录等环节仍是 Arkose：按页面实际出现的框架分流。
    const hasHCaptcha = await page.locator('iframe[src*="hcaptcha.com"]').first().isVisible().catch(() => false);
    return hasHCaptcha ? await solveHCaptchaOnce(page, onLog) : await solveCaptchaOnce(page, onLog);
  }

  async function checkVerification() {
    const blocked = async () => /^(?:account|prod\.idp)\.collegeboard\.org$/.test(new URL(page.url()).hostname) ||
      await page.locator('iframe[src*="arkoselabs"], iframe[title*="verification"], #fc-iframe-wrap, input[autocomplete="one-time-code"]').first().isVisible() ||
      await page.getByRole('heading', { name: 'Sign In', exact: true }).isVisible();
    if (!await blocked()) return;
    if (await page.locator(ARKOSE_SELECTOR).first().isVisible().catch(() => false)) {
      const solved = await autoSolveCaptcha();
      onLog(solved.solved ? `✅ ${solved.detail}` : `⚠️ ${solved.detail}`);
      if (solved.solved) {
        await page.waitForTimeout(1500);
        if (!await blocked()) return;
      }
    }
    await waitForManual('官网需要人工登录或验证码，请在任务浏览器中处理；完成后自动继续。', async () => !await blocked());
  }

  async function captureScreenshot() {
    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(DATA_DIR, `screenshot_${task.id}.jpg`), quality: 75, type: 'jpeg' });
      }
    } catch (e) {}
  }

  async function start() {
    if (isStopped) return;
    const profileDir = path.join(DATA_DIR, `profile_${task.id}`);
    const settings = getGlobalSettings();
    const account = (settings.satAccount || '').trim();
    const password = settings.satPassword || '';
    const photoPath = (task.photoPath || '').trim();
    const cardInfo = task.cardInfo || settings.cardInfo || null;

    if (!account || !password) {
      onLog('❌ 未检测到 SAT 官网账号或密码，请点击右上角【⚙️ 设置】进行配置！');
      onError('缺少 SAT 凭证');
      return;
    }

    onLog(`正在启动隔离浏览器实例 (用户目录: profile_${task.id})...`);

    // 智能检测代理 (仅在显式配置时启用，未配置则使用系统原生网络或 TUN 虚拟网卡)
    let proxyConfig = undefined;
    const configuredProxy = settings.proxy || task.proxy || process.env.HTTP_PROXY || process.env.ALL_PROXY;
    if (configuredProxy) {
      // shortcut: 选座接口 satreg-api 经 HTTP 代理会一直挂起（直连正常），默认绕过；必须全部走代理的网络用 SAT_PROXY_BYPASS 覆盖。
      proxyConfig = { server: configuredProxy, bypass: process.env.SAT_PROXY_BYPASS || 'satreg-api.collegeboard.org' };
      onLog(`已自动加载网络代理路由: ${proxyConfig.server}（绕过 ${proxyConfig.bypass}）`);
    } else {
      onLog('使用系统原生网络 (支持 TUN 虚拟网卡)...');
    }

    // 是否以无头模式运行 (默认 false：弹出真实浏览器窗口，方便桌面直观查看与人工辅助过2FA)
    const isHeadless = false;
    onLog(`浏览器运行模式: ${isHeadless ? '静默无头 (Headless)' : '桌面弹窗 (Visible)'}`);

    try {
      browserContext = await chromium.launchPersistentContext(profileDir, {
        headless: isHeadless,
        proxy: proxyConfig,
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-ipv6'
        ]
      });
      contextClosed = new Promise(resolve => browserContext.once('close', () => {
        isStopped = true;
        resolve();
      }));
      if (isStopped) {
        await browserContext.close();
        return;
      }

      page = await browserContext.newPage();
      activeDebugPage = page;
      page.setDefaultTimeout(40000);

      // 拦截容易引起海外死锁的第三方广告与重型追踪。
      // 保留 kiwi 官网页面资源；选座请求的 fingerprint 来自官网 hCaptcha 上下文。
      const blockedHosts = ['doubleclick', 'onetrust.com/consent', 'googletagmanager', 'google-analytics', 'googlesyndication',
        'scorecardresearch', 'hotjar', 'qualtrics', 'facebook.net', 'bing.com/bat.js', 'criteo'];
      await page.route('**/*', route => {
        const u = route.request().url();
        if (blockedHosts.some(d => u.includes(d)) || route.request().resourceType() === 'media') {
          return route.abort();
        }
        route.continue();
      });

      // 登录态会在长时间轮询中失效（官网会话过期或被风控踢出），抽成函数以便轮询时自愈重登。
      async function performLogin() {
      onLog('正在连接 CollegeBoard 统一登录入口...');
      const loginUrl = 'https://account.collegeboard.org/login/login';
      try {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (gotoErr) {
        onLog('统一登录入口加载较慢，尝试直通控制台入口...');
        await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      }

      // 处理 Cookie 授权弹窗 (防导航中断报错)
      try {
        const acceptBtn = await page.$('button#onetrust-accept-btn-handler').catch(() => null);
        if (acceptBtn) await acceptBtn.click().catch(() => {});
      } catch (e) {}

      await page.waitForTimeout(2000);

      // 检查当前是否需要登录。Okta 登录页水合慢（实测 40-60s 才渲染输入框），
      // 原来只等 15s 会误判成"未出现账号输入框"转人工；改为账号框/密码框竞等，60s 窗口。
      const loginForm = await Promise.race([
        page.waitForSelector('input[name="identifier"]', { timeout: 60000 }).then(h => h && { kind: 'identifier', handle: h }, () => null),
        page.waitForSelector('input[type="password"]', { timeout: 60000 }).then(h => h && { kind: 'password', handle: h }, () => null),
      ]).catch(() => null);
      const hasIdentifierInput = loginForm && loginForm.kind === 'identifier' ? loginForm.handle : null;

      // 官网记住过邮箱时登录页直接给密码框，跳过账号步骤，避免被当成"未出现账号输入框"。
      const passwordOnly = !hasIdentifierInput && await page.locator('input[type="password"]').first().isVisible().catch(() => false);

      if (hasIdentifierInput || passwordOnly) {
        if (hasIdentifierInput) {
          onLog(`正在执行真实登录，账号: ${account}...`);

          // 1. 输入邮箱账号
          await page.fill('input[name="identifier"]', account);
          const submitEmail = await page.$('input[type="submit"], button[type="submit"]');
          if (submitEmail) await submitEmail.click();
          onLog('账号已提交，正在等待安全认证方式...');

          // 2. 选择 Password 认证项 (若页面出现多因素选择列表)
          const factorFound = await page.waitForSelector('a[aria-label*="Select Password"], button[aria-label*="Select Password"], .select-factor', { timeout: 8000 }).catch(() => null);
          if (factorFound) {
            const passwordFactor = page.getByRole('link', { name: /Select Password/i }).or(page.getByRole('button', { name: /Select Password/i }));
            if (await passwordFactor.isVisible()) await passwordFactor.click();
          }
        } else {
          onLog('官网已记住账号，直接填入密码...');
        }

        // 3. 填入密码
        onLog('密码认证框已就绪，正在填入密码并登录...');
        let passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);
        if (!passwordInput) {
          await waitForManual('登录需要人工验证，请在浏览器处理；出现密码框或进入 MySAT 后自动继续。',
            async () => new URL(page.url()).hostname === 'mysat.collegeboard.org' || await page.locator('input[type="password"]').isVisible());
          passwordInput = await page.$('input[type="password"]');
        }
        if (passwordInput) {
          await page.fill('input[type="password"]', password);
          const submitPwd = await page.$('input[type="submit"], button[type="submit"]');
          if (submitPwd) await submitPwd.click();
        }

      // 4. 等待 SSO 完成并跳转回 MySAT 控制台
        onLog('凭据已提交，等待单点登录跳转 (SSO)...');
        // 不能过早强跳 mysat：会打断进行中的 SSO，直接落到未登录的 Sign In 卡片。
        const ssoDone = await page.waitForURL(u => !u.hostname.startsWith('account.collegeboard.org'), { timeout: 35000 })
          .then(() => true, () => false);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        if (!ssoDone) {
          const hint = await page.evaluate(() => {
            const text = [...document.querySelectorAll('[role="alert"], [class*="error" i], [id*="error" i], p')]
              .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
              .filter(t => t && t.length < 200 && /error|incorrect|invalid|wrong|again|verif|captcha|human|locked/i.test(t));
            return text.slice(0, 3).join(' | ') || '无错误提示文本';
          }).catch(() => '读取失败');
          onLog(`登录仍未跳出登录页：${hint}（当前 ${page.url().slice(0, 90)}）`);
        } else {
          onLog(`SSO 已跳转，当前页 ${new URL(page.url()).hostname}`);
        }
        // SSO 会先经 prod.idp 中转；给中转留时间，落定前不要硬跳，否则拿到的是未登录页面。
        await page.waitForURL(u => u.hostname === 'mysat.collegeboard.org' || (!/(^|\.)idp\./.test(u.hostname) && !u.hostname.startsWith('account.')), { timeout: 25000 }).catch(() => {});
        if (!page.url().includes('mysat.collegeboard.org')) {
          await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        }
        await page.waitForTimeout(2500);
        if (await page.locator('text=/Sign in to personalize your visit/i').first().isVisible().catch(() => false)) {
          onLog('⚠️ MySAT 显示未登录卡片：会话未建立，密码提交后没拿到登录态。');
        }
        onLog('登录信息已提交，正在检查官网状态。');
      } else {
        onLog('未出现账号输入框，正在检查官网状态。');
      }
      }

      const sessionLost = async (deep = false) => {
        try {
          const u = page.url();
          if (/^(?:account|prod.idp).collegeboard.org$/.test(new URL(u).hostname)) return true;
          if (/mysat.collegeboard.org/.test(u)) {
            return await page.locator('text=/Sign in to personalize your visit/i').first().isVisible().catch(() => false);
          }
          if (!deep) return false;
          // satreg 是 SPA：登录失效后 URL 仍是查询页，只有接口 401，必须去仪表盘实地核对。
          await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
          const signedOut = await page.locator('text=/Sign in to personalize your visit/i').first()
            .isVisible({ timeout: 8000 }).catch(() => false);
          if (signedOut) return true;
          const backUrl = page.url();
          if (!/dashboard/.test(backUrl)) await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
          return false;
        } catch (e) { return false; }
      };
      // 重登节流：两次自动重登至少间隔 90 秒，避免官网拒登时形成登录风暴。
      let lastReloginAt = 0;
      const relogin = async why => {
        if (Date.now() - lastReloginAt < 90000) {
          onLog('登录态疑似失效（' + why + '），但距上次重登不足 90 秒，本轮跳过自动重登。');
          return false;
        }
        lastReloginAt = Date.now();
        onLog('检测到登录态失效（' + why + '），正在自动重新登录...');
        await performLogin();
        await checkVerification();
        await handleRegistrationWizardPrerequisites(page, onLog, task, waitForManual);
        await ensureOnTestCenterSearchForm(page, onLog, task, waitForManual);
        return true;
      };

      await performLogin();

      await checkVerification();

      // 智能引导路由器：遍历处理 My SAT Dashboard -> Personal Info -> School Info -> Student Profile
      await handleRegistrationWizardPrerequisites(page, onLog, task, waitForManual);

      stopWatchingAdmins = watchTestCenterAdmins(page, onLog); // 记录真实余位，并捕获查位请求模板
      const centerDesc = (task.targetCenters && task.targetCenters.length > 0) ? task.targetCenters.join(', ') : '全区任意考点(有位即抢)';
      onLog(`考位监控引擎启动！目标考点: [${centerDesc}]，开始智能轮询...`);

      let lastSuccessfulCheck = null;
      let consecutiveUnknown = 0; // 连续未确认轮数；达到阈值才做一次昂贵的登录态核验
      let seatRetry = 0;
      // 接口查位状态：接口报告无位时先信任，再周期性用页面交叉验证。
      let apiUnavailableChecks = 0;
      let apiUnavailableTrusted = false;
      let apiDisabledReason = '';
      let apiModeLogged = false; // 接口通道只播报一次，避免每轮刷屏
      // 页面准备只做 DOM 推进：URL 校正、验证码、报名向导、地区下拉。
      // 接口查位已确认的轮次完全跳过它，避免每轮重复点击与重绘。
      const preparePageQuery = async () => {
        // 登录态可能落在第三方落地页（实测 SSO 后会停在中转页），向导无从下手；强制回仪表盘。
        // 注意 mysat.collegeboard.org/ 根页虽同域也算异常（无报名卡片、无国家下拉），必须回 dashboard。
        {
          let cur = '';
          try { cur = page.url(); } catch (e) {}
          const urlOk = /mysat\.collegeboard\.org\/dashboard/.test(cur) || /satreg\.collegeboard\.org/.test(cur);
          if (!urlOk) {
            onLog(`当前停留在 ${cur ? new URL(cur).hostname + new URL(cur).pathname : '空白页'}，正在返回 MySAT 仪表盘...`);
            await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
            await page.waitForTimeout(2500);
          }
        }

        // 如果不慎退回或停留在选日期/规则页，自动推进。
        await checkVerification();
        await handleRegistrationWizardPrerequisites(page, onLog, task, waitForManual);
        await ensureOnTestCenterSearchForm(page, onLog, task, waitForManual);

        // 确保选中 Outside the United States。
        const outsideRadio = await page.$('#test-location-type-international');
        if (outsideRadio) await outsideRadio.click().catch(() => {});

        // 以地区代码为准，避免官网名称变化（如 Macao）导致误选。
        const regionSelect = await page.$('select[name*="country"], select[id*="country"], select[name*="region"]');
        if (!regionSelect) throw new Error(`官网国家／地区选择框不可用，本轮不查询（当前页 ${page.url().slice(0, 100)}）`);
        const regionCode = task.targetCountryCode;
        if (typeof regionCode !== 'string' || !/^[A-Z]{2}$/.test(regionCode) || regionCode === 'US') {
          throw new Error('任务缺少有效国际地区代码；美国邮编查询暂未支持');
        }
        await regionSelect.selectOption({ value: regionCode });
        if (await regionSelect.inputValue() !== regionCode) {
          throw new Error('官网地区选择未确认，本轮不查询');
        }
      };

      // 轮询循环
      while (!isStopped) {
        let querySource = '页面查位';
        let queriedPage = false;
        try {
          onPoll();
          onLog(`[第 ${task.pollCount} 次轮询] 正在检索 ${task.targetRegion} 考位...`);

          // 查位优先走官网自己的只读接口：它直接返回 admins[0].seatAvailable，
          // 不必每次都点「Find a Test Center」等卡片重绘。页面仍负责交叉验证与真正的选座。
          const targets = task.targetCenters || [];
          const apiResult = apiDisabledReason
            ? { status: 'unknown', reason: '接口查位已停用（' + apiDisabledReason + '）' }
            : await queryTestCentersViaApi(page, task, targets);
          let result = apiResult;

          if (apiResult.status === 'unknown') {
            onLog('接口查位未确认（' + (apiResult.reason || '未知原因') + '），准备页面并改用页面查位...');
            await preparePageQuery();
            queriedPage = true;
            result = await queryTestCenters(page, targets, undefined, onLog);
            querySource = apiDisabledReason ? '页面查位（接口已停用）' : '页面查位';
          } else if (apiResult.status === 'available') {
            // 接口只当“预警”：真要点选座按钮，仍要页面卡片在眼前，避免误锁或点到过期按钮。
            onLog('接口查位报告【' + apiResult.matchedCenter + '】有可售名额，正在准备页面并刷新卡片以取得选座按钮...');
            await preparePageQuery();
            queriedPage = true;
            const domResult = await queryTestCenters(page, targets, undefined, onLog);
            if (domResult.status === 'available') {
              result = domResult;
              querySource = '接口查位 + 页面确认';
            } else if (domResult.status === 'unavailable') {
              onLog('⚠️ 接口报告有位，但页面卡片显示无位；本轮按未知处理，不锁位。');
              result = { status: 'unknown', reason: '接口与页面查位结果矛盾（接口有可售名额）' };
              querySource = '接口/页面矛盾';
            } else {
              result = {
                status: 'unknown',
                reason: '接口报告有位，但页面未确认可选卡片：' + (domResult.reason || '未知')
              };
              querySource = '接口有位/页面未确认';
            }
          } else if (apiResult.status === 'unavailable') {
            apiUnavailableChecks += 1;
            // 首次无位结论用页面复核一次；之后先信任接口，仅每 30 次抽查一次，
            // 既省掉大量页面点击，又能在接口口径变化时及时发现。
            const needVerify = !apiUnavailableTrusted || apiUnavailableChecks % 30 === 0;
            if (needVerify) {
              onLog('接口查位报告无位，正在准备页面并交叉验证一次...');
              await preparePageQuery();
              queriedPage = true;
              const domResult = await queryTestCenters(page, targets, undefined, onLog);
              if (domResult.status === 'available') {
                onLog('⚠️ 接口报告无位但页面显示有位；本轮采信页面结果，并停用接口查位以免继续漏报。');
                apiDisabledReason = '接口与页面结果矛盾';
                result = domResult;
                querySource = '页面查位（接口已停用）';
              } else if (domResult.status === 'unavailable') {
                apiUnavailableTrusted = true;
                querySource = '接口查位（已与页面交叉验证）';
              } else {
                querySource = '接口查位（页面未确认）';
              }
            } else {
              querySource = '接口查位（无位）';
            }
          }

          if (!apiDisabledReason && !apiModeLogged && apiResult.status !== 'unknown') {
            apiModeLogged = true;
            onLog('接口查位通道已启用（' +
              (apiResult.authMode === 'sigv4' ? 'Catapult + SigV4' : 'Catapult 头') +
              '，耗时 ' + (apiResult.durationMs || '-') + 'ms，本轮考点 ' +
              (apiResult.centerCount == null ? '-' : apiResult.centerCount) + ' 个）。');
          }

          const { matchedCenter, selectTargetBtn } = result;
          const hasAvailableSeat = result.status === 'available';
          const checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          if (result.status !== 'unknown') lastSuccessfulCheck = checkedAt;
          consecutiveUnknown = result.status === 'unknown' ? consecutiveUnknown + 1 : 0;

          if (hasAvailableSeat && matchedCenter) {
            const selectBtn = selectTargetBtn;

            if (!selectBtn) {
              onLog(`⚠️ 目标考点【${matchedCenter}】出现考位，但卡片按钮解析未就绪，防止误报跳过兜底...`);
              continue;
            }

            onLog(`🔥🔥 发现【${matchedCenter}】有空余考位！点击入选并前往确认页...`);
            const selection = await attemptSelection(page, selectBtn, { autoSolve: autoSolveCaptcha, log: onLog,
              manual: waitForManual, expectedDate: task.targetDate, expectedCenter: matchedCenter });
            if (isStopped) break;
            onLog(selection.message);
            await captureScreenshot();

            // 仅明确失位时重查；提交接口异常属于未确认，不能仅凭官网通用文案反复提交。
            if (selection.outcome === 'seat_lost') {
              seatRetry += 1;
              if (seatRetry <= 3) {
                onLog(`本轮未锁位，重新加载选考位页再次尝试（${seatRetry}/3）...`);
                await page.goto('https://satreg.collegeboard.org/register/testCenterSearch',
                  { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
                // 页面是 SPA，domcontentloaded 后筛选器还没挂出来，等它就绪再进下一轮，否则白跑一次。
                await page.waitForSelector('select[name*="country"], select[id*="country"]', { timeout: 25000 }).catch(() => {});
                await page.waitForTimeout(1500);
                continue;
              }
              onLog(`连续 ${seatRetry} 次未锁位，转为等待人工核对。`);
            }
            seatRetry = 0;
            onNeedsAction(matchedCenter, selection);

            // 微信秒级推送
            const currentSettings = getGlobalSettings();
            const notifyToken = task.pushplusToken || currentSettings.pushplusToken;
            if (notifyToken) {
              await sendPushplus(
                notifyToken,
                'SAT 选座待人工核对',
                `考生：${task.name}<br>考点：${matchedCenter}<br>${selection.message}`
              );
            }

            // === 后续全自动闭环流程：遵循视频 06:10 - 09:28 真实步骤 ===
            if (selection.outcome === 'advanced') {
              await handlePostLockProcess(page, onLog, task, photoPath, cardInfo);
            }
            onLog('浏览器保持开启，请先核对官网选座结果；仅在官网报名和付款成功后点击【确认已付款】。');
            await contextClosed;
            break;
          } else {
            const seatsText = /^页面查位/.test(querySource)
              ? '目标考点无位（No seats available.）'
              : '接口返回无可售名额（seatAvailable 非真）';
            onLog(result.status === 'unavailable'
              ? `${querySource}：${seatsText}；查询时间：${checkedAt}`
              : `当前状态未知（${querySource}）：${result.reason}；上次成功查询：${lastSuccessfulCheck || '暂无'}`);
              // 连续 3 轮查不到结果时核验一次登录态：SPA 下接口 401 不会改变 URL。
              if (result.status === 'unknown' && consecutiveUnknown >= 3 && await sessionLost(true)) {
                consecutiveUnknown = 0;
                if (await relogin('仪表盘显示未登录')) continue;
              }
          }

        } catch (pollErr) {
          onLog(`当前状态未知：${pollErr.message}；上次成功查询：${lastSuccessfulCheck || '暂无'}`);
          consecutiveUnknown += 1;
          if (consecutiveUnknown >= 3 && await sessionLost(true)) {
            consecutiveUnknown = 0;
            if (await relogin('轮询异常且仪表盘显示未登录')) continue;
          }
        }

        if (isStopped) break;

        // 接口查位没有页面渲染与点击开销，间隔可以更短；页面查位仍保持 15 ~ 25 秒抖动防封 IP。
        const delayMs = queriedPage
          ? 15000 + Math.floor(Math.random() * 10000)
          : 6000 + Math.floor(Math.random() * 4000);
        await new Promise(resolve => {
          const timer = setTimeout(() => { wakePoll = null; resolve(); }, delayMs);
          wakePoll = () => { clearTimeout(timer); wakePoll = null; resolve(); };
        });
      }

    } catch (err) {
      if (!isStopped) {
        let reason = err.message || '未知异常';
        onLog(`原始异常：${reason.split('\n')[0].replace(/https?:\/\/[^\s)]+/g, url => url.split('?')[0]).slice(0, 300)}`);
        try {
          if (page && !page.isClosed()) {
            await captureScreenshot('error');
            const pageText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
            if (/incorrect username or password|wrong password|invalid password/i.test(pageText)) {
              reason = 'SAT 官网账号或密码错误，请核对';
            } else if (/verification code|security code|verify your identity|two-step/i.test(pageText)) {
              reason = '触发邮箱安全验证码(2FA)，需人工登录一次';
            } else if (/temporarily locked|account locked/i.test(pageText)) {
              reason = 'SAT账号已被临时锁定，请前往官网解锁';
            } else if (/access denied|cloudflare|rate limit/i.test(pageText)) {
              reason = '网络IP受限或被拦截';
            } else if (err.message && err.message.includes('Timeout')) {
              reason = '页面加载或响应超时(网络较慢或页面结构变更)';
            }
          }
        } catch (e) {}
        onError(reason);
      }
    } finally {
      try { if (stopWatchingAdmins) stopWatchingAdmins(); } catch (e) {}
      if (browserContext) {
        await browserContext.close().catch(() => {});
      }
      if (onExit) onExit();
    }
  }

  // 先把 worker 返回给调度器，再启动，保证同步报错也能清除运行记录。
  queueMicrotask(() => {
    start().catch(err => { if (!isStopped) onError(err.message); }).finally(finish);
  });

  return {
    stop: async () => {
      isStopped = true;
      if (wakePoll) wakePoll();
      if (browserContext) {
        await browserContext.close().catch(() => {});
      }
      await finished;
    }
  };
}

// =========================================================================
// 视频逐帧拆解深度适配：向导前置处理、选期规则推进、后置全流程闭环
// =========================================================================

// 阶段一与阶段二前置向导处理：自动从 MySAT Dashboard 推进至选期考位页 (视频 00:25 - 03:00)
async function clickWizardControl(control) {
  // 部分桌面会话的鼠标点击返回成功却不派发事件；只有事件确实未送达时才补发。
  const element = await control.elementHandle();
  if (!element) throw new Error('报名向导控件已消失');
  // 在事件发生时返回结果；导航开始后再读取旧页面会被慢页面加载拖住。
  const receivedClick = element.evaluate(el => new Promise(resolve => {
    const receive = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      el.removeEventListener('click', receive, true);
      resolve(false);
    }, 6000);
    el.addEventListener('click', receive, { capture: true, once: true });
  })).catch(() => true); // 已导航导致旧上下文销毁时不重放点击。
  try {
    await control.click({ timeout: 5000, noWaitAfter: true });
    const received = await receivedClick;
    if (received === false && await control.isVisible() && await control.isEnabled()) {
      await element.evaluate(el => el.click());
    }
  } finally {
    await element.dispose().catch(() => {});
  }
}

async function handleRegistrationWizardPrerequisites(page, onLog, task, manual = async message => { throw new Error(message); }) {
  const currentUrl = page.url();
  if (currentUrl.includes('mysat.collegeboard.org/dashboard')) {
    const finish = page.getByRole('link', { name: /Finish Registration/i }).or(page.getByRole('button', { name: /Finish Registration/i }));
    // 仪表盘 React 挂载慢（实测 30~90s，kiwi 放行后依赖指纹脚本），15s 早退会误判"无法定位报名"。
    // 轮询等待：Finish Registration 链接可见或页面出现 Incomplete 文案即继续，最多 150s。
    {
      const deadline = Date.now() + 150000;
      let ready = false;
      const registerBtnEarly = page.getByRole('link', { name: /^Register for the SAT/i }).or(page.getByRole('button', { name: /^Register for the SAT/i })).first();
      while (Date.now() < deadline) {
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const hasFinish = await finish.first().isVisible().catch(() => false);
        // 无未完成报名时仪表盘同样算就绪（Register for the SAT 可见即挂载完成）
        const hasRegister = await registerBtnEarly.isVisible().catch(() => false);
        if (hasFinish || /Incomplete/i.test(bodyText) || hasRegister) {
          ready = true;
          // 留证：挂载瞬间的完整卡片 DOM（含删除入口），供删除/调试决策。
          try {
            const dump = await page.evaluate(() => {
              const links = [...document.querySelectorAll('a,button')].filter(e => /Finish Registration/i.test(e.textContent || ''));
              const cards = links.map(link => {
                let card = link.parentElement;
                while (card && card !== document.body && !/Incomplete/i.test(card.innerText || '')) card = card.parentElement;
                if (!card || card === document.body) return null;
                const btns = [...card.querySelectorAll('a,button,[role=button]')].map(e => ({
                  tag: e.tagName,
                  text: ((e.textContent || e.getAttribute('aria-label') || '')).trim().slice(0, 60),
                  href: (e.getAttribute('href') || '').slice(0, 140),
                  id: (e.id || '').slice(0, 70)
                }));
                return { text: card.innerText.replace(/\s+/g, ' ').slice(0, 300), btns };
              }).filter(Boolean);
              const delBtns = [...document.querySelectorAll('a,button,[role=button]')]
                .filter(e => /delete|cancel|remove/i.test(((e.textContent || '') + (e.getAttribute('aria-label') || ''))))
                .map(e => ({ tag: e.tagName, text: ((e.textContent || e.getAttribute('aria-label') || '')).trim().slice(0, 60) }));
              return { cards, delBtns };
            });
            onLog(`卡片DOM留证｜${JSON.stringify(dump).slice(0, 3000)}`);
          } catch (e) {}
          break;
        }
        await page.waitForTimeout(2000);
      }
      if (ready) onLog('仪表盘已挂载，未完成报名卡片就绪。');
      else onLog('仪表盘 150s 内未出现 Finish Registration 卡片，仍尝试诊断一次。');
    }
    const matched = await finish.evaluateAll((links, iso) => {
      const date = new Date(iso + 'T00:00:00Z');
      const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      return links.map((link, index) => {
        let card = link.parentElement;
        while (card && card !== document.body) {
          const text = card.innerText;
          const words = text.toLowerCase().match(/[a-z]+|\d+/g) || [];
          const matches = text.includes(iso) || (words.includes(String(date.getUTCFullYear())) &&
            words.some(w => /^\d+$/.test(w) && Number(w) === date.getUTCDate()) &&
            words.some(w => w === month.toLowerCase() || w === month.slice(0, 3).toLowerCase()));
          if (matches && /Incomplete/i.test(text) && [...card.querySelectorAll('a,button')].filter(el => /Finish Registration/i.test(el.innerText)).length === 1) return index;
          card = card.parentElement;
        }
        return -1;
      }).filter(index => index >= 0);
    }, task.targetDate);
    if (matched.length === 1) {
      onLog(`正在续办 ${task.targetDate} 的未完成报名...`);
      await clickWizardControl(finish.nth(matched[0]));
      // 放行 kiwi 后官网跳转链变长（指纹脚本参与），20s 不够；放宽到 60s，落定前不硬跳。
      await page.waitForURL(url => url.hostname === 'satreg.collegeboard.org', { timeout: 60000 }).catch(() => {});
      if (!/satreg\.collegeboard\.org/.test(page.url())) {
        await page.goto('https://satreg.collegeboard.org/register/testCenterSearch', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      }
    } else {
      const diag = await finish.evaluateAll(links => links.map((l, i) => {
        let card = l.parentElement, text = '';
        while (card && card !== document.body) {
          if (/Incomplete|Finish Registration/i.test(card.innerText)) { text = card.innerText; break; }
          card = card.parentElement;
        }
        return `${i}:${(text || l.innerText || '').replace(/\s+/g, ' ').slice(0, 110)}`;
      })).catch(() => []);
      const bodyHint = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      onLog(`未完成报名诊断：Finish Registration 按钮 ${diag.length} 个｜${diag.join(' ‖ ') || '无'}｜页面含 Incomplete：${/Incomplete/i.test(bodyHint)}`);
      // 无未完成报名（如已删除/从零重报）时，从 Register for the SAT 开始全新报名，不转人工。
      if (!/Incomplete/i.test(bodyHint)) {
        let started = false;
        for (let attempt = 1; attempt <= 3 && !started; attempt++) {
          const registerBtn = page.getByRole('link', { name: /^Register for the SAT/i }).or(page.getByRole('button', { name: /^Register for the SAT/i })).first();
          if (await registerBtn.isVisible().catch(() => false)) {
            onLog('未发现未完成报名，正在从 Register for the SAT 开始全新报名...');
            await clickWizardControl(registerBtn);
            await page.waitForTimeout(3000);
            started = true;
          } else {
            onLog(`第 ${attempt} 次未见到 Register for the SAT 按钮，刷新仪表盘重试...`);
            await page.goto('https://mysat.collegeboard.org/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
            const retryDeadline = Date.now() + 45000;
            while (Date.now() < retryDeadline) {
              if (await registerBtn.isVisible().catch(() => false)) break;
              await page.waitForTimeout(2000);
            }
          }
        }
        if (!started) {
          await manual(`无法唯一定位 ${task.targetDate} 的未完成报名，请在浏览器打开正确报名并进入选日期和考点步骤。`,
            async () => new URL(page.url()).hostname === 'satreg.collegeboard.org');
        }
      } else {
        await manual(`无法唯一定位 ${task.targetDate} 的未完成报名，请在浏览器打开正确报名并进入选日期和考点步骤。`,
          async () => new URL(page.url()).hostname === 'satreg.collegeboard.org');
      }
    }
  }

  const dateStep = page.locator('section, li, div').filter({ has: page.getByText('Select Date and Test Center', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Finish', exact: true }).or(page.getByRole('link', { name: 'Finish', exact: true })) }).last();
  if (await dateStep.isVisible()) {
    await clickWizardControl(dateStep.getByRole('button', { name: 'Finish', exact: true }).or(dateStep.getByRole('link', { name: 'Finish', exact: true })));
    await page.waitForTimeout(1000);
  }

  // 循环处理 Step 1 of 4: Personal Information / School Info / Student Profile (视频 00:40 - 03:00)
  let guard = 0;
  while (guard++ < 8 && page.url().includes('personalInformation')) {
    onLog(`[向导 Step 1/4] 正在处理考生个人信息与背景档案 (第 ${guard} 步)...`);
    
    // 学校、年级和问卷使用官网已有值，不能以选项位置推断考生资料。
    const dialogs = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, .cb-modal[aria-hidden="false"]:visible');
    const outsidePersonalInfo = () => !page.url().includes('personalInformation');
    if (await dialogs.count()) {
      const detail = (await dialogs.first().innerText()).replace(/\s+/g, ' ').trim().slice(0, 400);
      await manual(`个人信息页出现弹窗，请核对并处理后继续：${detail}`,
        async () => outsidePersonalInfo() || await dialogs.count() === 0);
      continue;
    }

    // 新报名时官网会展开年级编辑框，必须点 Confirm 才会出现可用的 Continue（2026-10-25 实测）。
    // Confirm 提交的是下拉当前值（账号档案里的年级），与人工确认流程一致。
    const gradeConfirm = page.locator('#qc-id-personalinfo-button-gradeconfirm:visible');
    if (await gradeConfirm.isVisible().catch(() => false)) {
      onLog('[向导 Step 1/4] 年级编辑框已展开，自动点击 Confirm 确认档案年级。');
      try {
        await clickWizardControl(gradeConfirm);
        await page.waitForTimeout(2000);
      } catch (err) {
        onLog(`年级 Confirm 点击未完成：${err.message.split('\n')[0]}`);
      }
      continue;
    }

    const invalidFields = () => page.locator('input:visible, select:visible, textarea:visible').evaluateAll(fields =>
      fields.filter(el => !el.disabled && el.willValidate && !el.validity.valid)
        .map(el => el.labels?.[0]?.innerText?.trim() || el.getAttribute('aria-label') || el.name || el.id || '未填写字段'));
    const missing = await invalidFields();
    if (missing.length) {
      await manual(`个人信息有待核对或补全的字段：${missing.join('、')}。请按真实资料填写，系统保留已有答案。`,
        async () => outsidePersonalInfo() || (await invalidFields()).length === 0);
      continue;
    }

    // Get Started 过渡页（进入/重启向导时页面停在这里，URL 仍是 personalInformation）：
    // 不点它表单永远不渲染，会被误判为“尚不能继续”而转人工（2026-10-25 实测）。
    const wizardGetStarted = page.locator('#qc-id-getstarted-button-getstarted:visible')
      .or(page.locator('button:visible:has-text("Get Started")')).first();
    if (await wizardGetStarted.isVisible().catch(() => false)) {
      onLog('[向导 Step 1/4] 检测到 Get Started 过渡页，自动点击进入表单。');
      try {
        await clickWizardControl(wizardGetStarted);
        await page.waitForTimeout(2500);
      } catch (err) {
        onLog(`Get Started 点击未完成：${err.message.split('\n')[0]}`);
      }
      continue;
    }

    // Step 1 内部还有子步骤（studentinfo / schoolinfo / contactinfo / studentquestionnaire），
    // 每个子步骤各自有 Continue；id 统一以 -button-continue 结尾；
    // 这些控件多为不带 role 的 <a>，getByRole('button'|'link') 匹配不到。
    // 官网标签内部有换行/缩进，hasText 要允许空白。
    // 子步骤切换时控件会短暂消失（2026-10-26 实测 1~3 秒），
    // 瞬时查不到就转人工会产生假警报，所以这里做短时轮询。
    const findContinue = () => page.locator('[id^="qc-id-"][id$="-button-continue"]:visible')
      .filter({ hasText: /^\s*Continue\s*$/ }).first();
    const findContinueFallback = () => page.getByRole('button', { name: 'Continue', exact: true })
      .or(page.getByRole('link', { name: 'Continue', exact: true }))
      .or(page.locator('a.cb-btn:visible').filter({ hasText: /^\s*Continue\s*$/ }))
      .first();
    // 注意：这个函数只返回可用控件；返回 null 时由下方统一转人工。
    const waitForUsableContinue = async (timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (outsidePersonalInfo() || (await dialogs.count()) > 0) return null;
        for (const finder of [findContinue, findContinueFallback]) {
          const control = finder();
          if (!await control.count().catch(() => 0)) continue;
          if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) return control;
        }
        await page.waitForTimeout(500);
      }
      return null;
    };

    // 恢复判据只比较可验证的结构状态（URL、标题、可见字段、按钮、弹窗、错误提示）。
    // 整页正文会因加载动画持续变化，用它比较会在用户没做任何操作时误报“人工处理已完成”。
    const signature = async () => {
      const snap = await page.evaluate(() => {
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
        return {
          headings: [...document.querySelectorAll('h1, h2, h3, h4, legend')].filter(visible).map(text).filter(Boolean),
          fields: [...document.querySelectorAll('input, select, textarea')].filter(visible)
            .map(el => [el.tagName, el.name, el.id, el.type, el.value, el.disabled ? 1 : 0].join('|')),
          dialogs: [...document.querySelectorAll('[role=dialog], [role=alertdialog], .cb-modal')].filter(visible).length,
          alerts: [...document.querySelectorAll('[role=alert], [class*=error i], [id*=error i]')].filter(visible).map(text).filter(Boolean).sort(),
          buttons: [...document.querySelectorAll('button, a[role=button]')].filter(visible)
            .map(el => [text(el), el.disabled ? 1 : 0].join('|')).sort()
        };
      }).catch(() => null);
      return page.url() + '\n' + JSON.stringify(snap);
    };
    const before = await signature();
    // 真实页面点 Continue 后要十几秒才跳转，且期间既没有 aria-busy 也没有 progressbar；
    // 只靠这两个信号会在 2 秒时误判“未推进”并提前转人工（2026-10-26 实测约 19s）。
    // 改为跟踪在途网络请求：请求未结束就继续等，彻底静默一段时间后才判定未推进。
    const pageBusy = () => page.evaluate(() => !!document.querySelector('[aria-busy=true], [role=progressbar]'))
      .catch(() => false);
    const trackProgress = () => {
      let inFlight = 0;
      const isCounted = request => ['xhr', 'fetch', 'document'].includes(request.resourceType());
      const onRequest = request => { if (isCounted(request)) inFlight++; };
      const onDone = () => { inFlight = Math.max(0, inFlight - 1); };
      page.on('request', onRequest);
      page.on('requestfinished', onDone);
      page.on('requestfailed', onDone);
      return {
        pending: () => inFlight,
        stop: () => {
          page.off('request', onRequest);
          page.off('requestfinished', onDone);
          page.off('requestfailed', onDone);
        }
      };
    };
    const waitForProgress = async (tracker, totalMs = 45000, quietMs = 8000) => {
      await page.waitForTimeout(1500);
      const deadline = Date.now() + totalMs;
      let quietSince = Date.now();
      while (Date.now() < deadline) {
        if (outsidePersonalInfo() || (await dialogs.count()) > 0 || await signature() !== before) return true;
        if (await pageBusy() || tracker.pending() > 0) quietSince = Date.now();
        else if (Date.now() - quietSince > quietMs) return false;
        await page.waitForTimeout(500);
      }
      return outsidePersonalInfo() || (await dialogs.count()) > 0 || await signature() !== before;
    };
    const continueBtn = await waitForUsableContinue();
    if (!continueBtn) {
      // 预警时把真实候选控件打出来，避免只能靠猜选择器修复。
      const candidates = await page.evaluate(() => [...document.querySelectorAll('[id*=continue]')].map(el => ({
        id: el.id, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 24),
        ariaDisabled: el.getAttribute('aria-disabled'), disabled: !!el.disabled,
        visible: el.getClientRects().length > 0
      }))).catch(() => []);
      onLog(`[Step 1 诊断] 当前页 ${page.url().split('?')[0]} 候选继续控件：${JSON.stringify(candidates)}`);
      await manual('个人信息页尚不能继续，请核对页面提示并完成资料确认。',
        async () => outsidePersonalInfo() || (await dialogs.count()) > 0 || await signature() !== before);
      continue;
    }
    const tracker = trackProgress();
    try {
      await clickWizardControl(continueBtn);
    } catch (err) {
      tracker.stop();
      onLog(`个人信息页 Continue 未完成：` + err.message.split("\n")[0]);
      // 点击期间弹出的提示在下一轮统一交接，不重复点击被遮挡的页面。
      if (await dialogs.count()) continue;
      await manual('个人信息页继续操作未完成，请检查官网提示并继续。',
        async () => outsidePersonalInfo() || (await dialogs.count()) > 0 || await signature() !== before);
      continue;
    }
    let progressed = false;
    try {
      progressed = await waitForProgress(tracker);
    } finally {
      tracker.stop();
    }
    if (!progressed) {
      await manual('个人信息页点击 Continue 后未推进，请核对资料及页面提示并手动继续。',
        async () => outsidePersonalInfo() || (await dialogs.count()) > 0 || await signature() !== before);
    }
  }
}

// 自动接受考试规则（设置开关 autoAcceptRules 开启时）：滚动条款到底 → 勾选复选框 → Continue。
// 任一步骤失败即抛出，由调用方转人工；选择器未命中真实页面时行为与关闭开关一致。
// shortcut: 只滚动一次、不等 wheel 事件循环；真实页面若只认 wheel 触发会走人工降级，届时再补。
async function describeClickables(page) {
  return await page.evaluate(() => {
    const out = [];
    const walk = root => {
      for (const el of root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], [role="checkbox"], input[type="checkbox"]')) {
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (text) out.push(`${el.tagName.toLowerCase()}${el.disabled ? '[disabled]' : ''}${el.getClientRects().length ? '' : '[hidden]'}:${text}`);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const buttons = [...new Set(out)].slice(0, 30).join(' | ');
    // 复选框所在区域的可见文字：Continue 若不是标准按钮，从文字里能看出真实控件名。
    const area = (() => {
      const b = document.querySelector('input[type="checkbox"], [role="checkbox"]');
      let el = b;
      for (let i = 0; i < 6 && el && el !== document.body; i++) el = el.parentElement;
      return (el?.innerText || '').replace(/\s+/g, ' ').trim().slice(-200) || '无';
    })();
    // Continue 的祖先链展示状态，定位它为什么不可见（display:none / 折叠容器 / 未滚动到位）。
    const chain = (() => {
      let el = [...document.querySelectorAll('button, [role="button"], input[value*="Continue"]')]
        .find(b => /continue/i.test(b.innerText || b.value || ''));
      if (!el) return '无 Continue 元素';
      const parts = [];
      while (el && el !== document.documentElement && parts.length < 8) {
        const s = getComputedStyle(el);
        parts.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0].slice(0, 20)}(${s.display},h=${el.clientHeight},sh=${el.scrollHeight},st=${Math.round(el.scrollTop)},ov=${s.overflowY})`);
        el = el.parentElement || el.getRootNode()?.host;
      }
      return parts.join(' < ');
    })();
    const boxes = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      .map((b, i) => `#${i}${b.checked ? '已勾选' : '未勾选'}${b.disabled ? '[disabled]' : ''}${b.getClientRects().length ? '' : '[hidden]'}`).join(',') || '无';
    return `${buttons} ‖ 复选框:${boxes} ‖ 区域文字:${area} ‖ Continue链:${chain}`;
  }).catch(e => `诊断失败:${e.message}`);
}

async function acceptTestingRules(page, onLog) {
  // 真实条款容器（如 #qc-id-termsconditions-scrollbox-termsconditions）的复选框只在收到
  // 滚轮/滚动事件后才启用，仅设置 scrollTop 无效（2026-10-24 实测）；补发 wheel 事件再滚到底。
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 4) {
        for (let i = 0; i < 10; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true, cancelable: true }));
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  const box = page.locator('input[type="checkbox"], [role="checkbox"]').first();
  await box.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const b = document.querySelector('input[type="checkbox"], [role="checkbox"]');
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  }, null, { timeout: 10000 }).catch(() => { throw new Error('考试规则复选框未启用'); });
  await box.check();
  const continueBtn = await page.$('button:visible:has-text("Continue"), a:visible:has-text("Continue"), input[value*="Continue"]:visible');
  // 选择器未命中时把页面按钮清单打进日志，便于按真实 DOM 修选择器（含 shadow root）。
  if (!continueBtn) throw new Error(`未找到规则页 Continue 按钮（页面按钮：${await describeClickables(page)}）`);
  await continueBtn.click();
  await page.waitForTimeout(2500);
  if (await page.locator('text=/SAT Weekend Testing Rules|Testing Rules/').first().isVisible()) throw new Error('点击 Continue 后仍在规则页');
  onLog('考试规则已自动接受，继续选择考期。');
}

// 阶段三选考期与规则确认：确保到达考点搜索表单 (视频 03:04 - 04:10)
async function ensureOnTestCenterSearchForm(page, onLog, task, manual = async message => { throw new Error(message); }) {
  // 0. 报名总览页的 Get Started：不先点它，规则页/日期页都不会出现（2026-10-24 实测）。
  const getStarted = await page.$('button:visible:has-text("Get Started"), a:visible:has-text("Get Started")');
  if (getStarted) {
    await getStarted.click().catch(() => {});
    await page.waitForTimeout(1500);
    onLog('已点击报名总览的 Get Started，进入规则确认。');
  }

  // 0.5 续办可能直接落在旧占位的确认页（20 分钟警告、无查询表单）；先 Back 回考点选择再查位。
  const staleConfirmBack = await page.$('#test-details-back-button');
  if (staleConfirmBack && await staleConfirmBack.isVisible().catch(() => false)) {
    await staleConfirmBack.click().catch(() => {});
    await page.waitForTimeout(1500);
    onLog('检测到旧考位确认页，已自动返回考点选择表单。');
  }

  // 1. 检查并签署 Testing Rules (视频 03:04)
  const rulesGone = async () => !await page.locator('text=/SAT Weekend Testing Rules|Testing Rules/').first().isVisible();
  const rulesManualMessage = '请在官网阅读考试规则，滚动条款至末尾，由你当次确认接受并点击 Continue；系统等待处理后继续。';
  const rulesText = await page.$('text=/SAT Weekend Testing Rules|Testing Rules/');
  if (rulesText && await rulesText.isVisible()) {
    if (getGlobalSettings().autoAcceptRules) {
      await acceptTestingRules(page, onLog).catch(e => {
        onLog(`自动接受考试规则失败：${e.message}`);
        return manual('自动接受考试规则未成功，' + rulesManualMessage, rulesGone);
      });
    } else {
      await manual(rulesManualMessage, rulesGone);
    }
  }

  // 2. 检查选考期页面 (Choose a test date - 视频 03:28)
  const chooseDateHeader = await page.$('text=Choose a test date');
  if (chooseDateHeader) {
    onLog('检测到考期选择页面 (Choose a test date)，正在选择目标考期...');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.targetDate || '')) throw new Error('请先为任务填写有效考期');
    const target = new Date(`${task.targetDate}T00:00:00Z`);
    if (!Number.isFinite(target.getTime())) throw new Error('任务考期无效');
    const month = target.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const year = String(target.getUTCFullYear());
    const day = String(target.getUTCDate());
    if (target.toISOString().slice(0, 10) !== task.targetDate) throw new Error('任务考期无效');
    await page.locator('input[type="radio"], [role="radio"], [id^="qc-id-selectdatecenter-testdate-button-"]').first()
      .waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    const candidates = await page.$$('input[type="radio"], [role="radio"], [id^="qc-id-selectdatecenter-testdate-button-"]');
    let dateOption = null;
    for (const candidate of candidates) {
      const matches = await candidate.evaluate((el, expected) => {
        if (el.value === expected.iso || el.getAttribute('data-date') === expected.iso) return true;
        let label = el.labels?.[0]?.innerText || el.closest('label')?.innerText || el.getAttribute('aria-label') || el.innerText || '';
        if (el.id.startsWith('qc-id-selectdatecenter-testdate-button-')) {
          let group = el.parentElement;
          while (group && group !== document.body) {
            const years = [...new Set((group.innerText.match(/\b20\d{2}\b/g) || []))];
            if (years.length) { if (years.length !== 1) return false; label += ' ' + years[0]; break; }
            group = group.parentElement;
          }
        }
        const words = label.toLowerCase().match(/[a-z]+|\d+/g) || [];
        return words.includes(expected.year) && words.some(word => /^\d+$/.test(word) && Number(word) === Number(expected.day)) &&
          words.some(word => word === expected.month.toLowerCase() || word === expected.month.slice(0, 3).toLowerCase());
      }, { iso: task.targetDate, month, year, day });
      if (matches) { dateOption = candidate; break; }
    }
    if (!dateOption) {
      await manual(`无法准确匹配考期 ${task.targetDate}，请在浏览器中人工选择并继续；系统不会替你选择其他日期`,
        async () => !await page.getByText('Choose a test date', { exact: true }).isVisible());
      return;
    }
    const label = await dateOption.evaluateHandle(el => el.labels?.[0] || el);
    await label.asElement().click();
    await label.dispose();
    if ((await dateOption.getAttribute('id') || '').startsWith('qc-id-selectdatecenter-testdate-button-')) {
      const details = page.getByText(new RegExp(`${month}\\s+${day},?\\s+${year}`, 'i')).first();
      if (!await details.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) {
        await manual(`官网未确认完整考期 ${task.targetDate}，请人工核对日期并继续。`,
          async () => !await page.getByText('Choose a test date', { exact: true }).isVisible());
        return;
      }
    }
    const continueBtn = await page.$('#testdate-continue-button, button[aria-label="Continue to test location"], button:visible:has-text("Continue"), input[value*="Continue"]:visible');
    if (continueBtn) await continueBtn.click();
    await page.waitForTimeout(2500);
  }
  if (await page.getByText('Choose your test location', { exact: true }).isVisible()) {
    const date = new Date(task.targetDate + 'T00:00:00Z');
    const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const expected = page.getByText(new RegExp(`(?:${month}|${month.slice(0, 3)})\\s+${date.getUTCDate()},?\\s+${date.getUTCFullYear()}`, 'i')).first();
    if (!await expected.isVisible()) await manual(`考点查询页未确认目标考期 ${task.targetDate}，请人工核对并切换到正确考期。`, async () => await expected.isVisible());
  }
}

// 后续页面只说明流程推进，不能作为锁位成功或剩余时间的证据。
// 选座流程（真实页面结构）：点卡片只等于选中考点，官网随后放开「Continue」，
// 详情页内嵌 Arkose 验证码，验证通过前 Continue 禁用；部分考点还会要求设备指标采集同意。
async function attemptSelection(page, selectBtn, deps = {}) {
  const log = deps.log || (() => {});
  const unknown = { outcome: 'unverified', message: '选座结果未确认，请在浏览器人工核对；系统未确认锁位。' };
  const captchaSelector = 'iframe[src*="hcaptcha.com"], iframe[src*="arkoselabs"], iframe[title*="verification"], #fc-iframe-wrap, #FunCaptcha';
  const confirmationSelector = 'text=/Confirm Your Test Details|20 minute warning/';
  let submissionFailure = null;

  async function isVisible(selector) {
    return await page.locator(selector).first().isVisible().catch(() => false);
  }

  // 按钮出现到可点击之间有延迟（验证码、接口回填），轮询等它变成可用再点。
  async function clickWhenReady(selector, label, timeout = 40000) {
    const btn = page.locator(selector).first();
    const appeared = await btn.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
    if (!appeared) {
      log(`未出现${label}`);
      return false;
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await btn.isEnabled().catch(() => false)) {
        try {
          await clickWizardControl(btn);
        } catch {
          log(`${label}点击失败`);
          return false;
        }
        log(`已点击${label}`);
        return true;
      }
      await page.waitForTimeout(1000);
    }
    log(`${label}始终不可点击`);
    return false;
  }

  // 设备指标采集同意：必须先滚到底，复选框才可用；确认按钮也只有勾选后才有 id。
  async function handleDeviceMetricsModal() {
    const box = page.locator('#collect-device-metrics-scrollbox-id').first();
    if (!await box.isVisible().catch(() => false)) return false;
    await box.scrollIntoViewIfNeeded().catch(() => {});
    log('出现设备指标采集同意弹窗，正在滚动条款并勾选...');
    await box.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }).catch(() => {});
    await page.waitForTimeout(800);
    // 复选框是受控 input：必须等滚动事件消化后再点，否则勾不上。
    const checkbox = page.locator('#collect-device-metrics-checkbox-id').first();
    for (let i = 0; i < 5; i++) {
      if (await checkbox.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(600);
    }
    // 真实鼠标点击对这个受控复选框无效（观察到勾不上），DOM 点击反而稳定触发 React 状态更新。
    await checkbox.evaluate(el => el.click()).catch(() => {});
    // 确认按钮只有勾选后才会带 id 出现，轮询等它。
    for (let i = 0; i < 12; i++) {
      const ok = page.locator('#collect-device-metrics-continue-id').first();
      if (await ok.count() && await ok.isVisible().catch(() => false)) {
        await ok.evaluate(el => el.click()).catch(() => {});
        log('已确认设备指标采集同意');
        return true;
      }
      if (i === 5) await checkbox.evaluate(el => el.click()).catch(() => {});
      await page.waitForTimeout(600);
    }
    log('设备指标同意确认按钮未出现，转人工');
    return false;
  }

  // 官网这一关是 hCaptcha：先真实点一次验证框，多数情况会直接放行；
  // 出现图片挑战或长时间不放行时才调用打码接口，避免无谓消耗额度。
  const detailsReleased = async () => {
    const detailsBtn = page.locator('[id$="test-details-continue-button"]').first();
    if (!await detailsBtn.isEnabled().catch(() => false)) return false;
    if (await page.locator('iframe[src*="hcaptcha"]').count()) return await page.evaluate(hCaptchaReleased).catch(() => false);
    return !await isVisible(ARKOSE_SELECTOR);
  };
  const targetMatches = async () => {
    if (!deps.expectedDate && !deps.expectedCenter) return true;
    const url = new URL(page.url());
    if (url.hostname !== 'satreg.collegeboard.org' || url.pathname !== '/register/testCenterSearch') return false;
    const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const text = normalize(await page.locator('body').innerText().catch(() => ''));
    if (!text.includes('confirm your test details')) return false;
    if (deps.expectedDate) {
      const date = new Date(deps.expectedDate + 'T00:00:00Z');
      const fullDate = date.toLocaleString('en-US', {month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
      if (!text.includes(normalize(fullDate))) return false;
    }
    return !deps.expectedCenter || text.includes(normalize(deps.expectedCenter));
  };
  async function passCaptcha() {
    const captchaMounted = async () => await page.evaluate(() =>
      !!document.querySelector('.test-details-captcha, iframe[src*="hcaptcha"], iframe[src*="arkoselabs"]')
    ).catch(() => false);

    // 验证码是懒加载的：先等它挂载；如果按钮自己变可用，说明这轮不需要验证码。
    let mounted = false;
    for (let i = 0; i < 30; i++) {
      if (await detailsReleased()) return true;
      if (await captchaMounted()) { mounted = true; break; }
      await page.waitForTimeout(1000);
    }
    if (!mounted) {
      log('30 秒内未见验证码，继续尝试');
      return false;
    }

    log('详情页出现验证码，先点击验证框尝试直接放行...');
    // 验证框通常在首屏之外，先滚到可见区再点，否则鼠标坐标会落到视口外。
    await page.locator('.test-details-captcha, iframe[src*="hcaptcha"]').first()
      .scrollIntoViewIfNeeded().catch(() => {});
    await page.frameLocator('iframe[src*="frame=checkbox"]').locator('#checkbox')
      .click({ timeout: 10000 }).catch(() => {});

    let challengeSeen = false;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1000);
      if (await detailsReleased()) {
        log('验证码控件已放行');
        return true;
      }
      if (await isVisible('iframe[src*="frame=challenge"]')) challengeSeen = true;
    }

    log(challengeSeen ? '验证码弹出图片挑战，转自动识别' : '验证框点击后未放行，转自动识别');
    for (let attempt = 0; attempt < 2; attempt++) {
      const solved = deps.autoSolve ? await deps.autoSolve().catch(() => null) : null;
      log(`自动识别：${solved && solved.solved ? `✅ ${solved.detail}` : `⚠️ ${solved && solved.detail ? solved.detail : '未配置或失败'}`}`);
      if (await detailsReleased()) return true;
      await page.waitForTimeout(3000);
    }
    return false;
  }

  async function inspect() {
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !url.hostname.endsWith('collegeboard.org')) return unknown;
    if (submissionFailure) return { ...unknown,
      message: `官网选座提交失败（HTTP ${submissionFailure.status}${submissionFailure.message ? '：' + submissionFailure.message : ''}）；未确认锁位，已保留浏览器，请核对报名状态。` };
    const text = await page.locator('body').innerText().catch(() => '');
    if (/seat is no longer available|no longer available/i.test(text)) {
      return { outcome: 'seat_lost', message: '官网提示该考位已不可用（锁位超时或被他人抢占），本轮未锁位。' };
    }
    if (/no seats available|session (?:has )?expired|unable to|something went wrong/i.test(text)) return unknown;
    if ((url.hostname === 'satreg.collegeboard.org' && /^\/register\/(photoUpload|purchase)(?:\/|$)/.test(url.pathname)) ||
        (url.hostname === 'pps.collegeboard.org' && /payment|checkout|card/i.test(text))) {
      return { outcome: 'advanced', message: '已进入报名后续页面，仍需人工核对考期、考点及锁位结果。' };
    }
    if (await isVisible(captchaSelector)) {
      return { outcome: 'verification_required', message: '官网需要人工完成验证码，尚未确认锁位。' };
    }
    if (await page.locator(confirmationSelector).first().isVisible().catch(() => false)) {
      return { outcome: 'confirmation_pending', message: '停在考位确认页，尚未确认锁位，请在浏览器人工核对。' };
    }
    return unknown;
  }

  try {
    await selectBtn.click();
    log('已点击考点卡片，等待官网放开考位步骤的 Continue...');
    if (!await clickWhenReady('[id$="test-location-continue-button"]', '考位步骤 Continue')) return await inspect();

    await page.locator('[id$="test-details-continue-button"]').first()
      .waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    if (!await passCaptcha()) {
      const message = '请在浏览器完成人工验证码；系统将核对官网验证状态、目标考期和考点后自动接续，无需等待聊天回复。';
      if (typeof deps.manual !== 'function') return {outcome:'verification_required',message};
      await deps.manual(message, async () => await targetMatches() && await detailsReleased());
      if (!await detailsReleased()) return {outcome:'verification_required',message};
    }
    if (!await targetMatches()) return {...unknown,message:'当前确认页的考期或考点与任务不符，已停止自动提交，请核对官网报名。'};

    // 只观察官网原样提交：不改写参数、不重放锁位请求，不记录令牌和完整请求体。
    const confirmCalls = [];
    const confirmReads = [];
    const onConfirmResp = r => {
      const url = new URL(r.url());
      if (url.hostname !== 'satreg-api.collegeboard.org' || !url.pathname.endsWith('/student/save-reg-request')) return;
      const item = { status: r.status() };
      confirmCalls.push(item);
      if (item.status >= 400) submissionFailure = item;
      try {
        const posted = JSON.parse(r.request().postData() || '{}');
        const reg = posted.regRequest || {};
        log('官网提交摘要：' + JSON.stringify({ testCenterCode: reg.testCenterCode, testDate: reg.testDate,
          assessmentCount: Array.isArray(reg.assessments) ? reg.assessments.length : null,
          hasFingerprint: Boolean(posted.fingerprint), deviceMetricsConsent: reg.deviceMetricsConsent }));
      } catch {}
      confirmReads.push(r.json().then(body => {
        if (typeof body.message === 'string') item.message = body.message.slice(0, 250);
        if (typeof body.requestId === 'string') item.requestId = body.requestId;
      }).catch(() => {}));
    };
    page.context().on('response', onConfirmResp);
    try {
      // 点 Continue 往往先弹设备指标同意（弹窗要点击后才挂载，必须等它出现再处理），处理完再点一次提交。
      for (let round = 0; round < 3; round++) {
        if (!await clickWhenReady('[id$="test-details-continue-button"]', '详情步骤 Continue', 60000)) break;
        const modalShown = await page.locator('#collect-device-metrics-scrollbox-id').first()
          .waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false);
        if (!modalShown) {
          log('未出现同意弹窗，视为已提交');
          break;
        }
        if (!await handleDeviceMetricsModal()) break;
        // 同意本身就是提交动作，无需再点 Continue。
        log('设备指标同意已提交，等待官网确认锁位...');
        break;
      }
      await page.waitForTimeout(8000);
    } finally {
      // 成功跳转可能中断旧响应体读取，诊断日志不能阻塞后续报名流程。
      await Promise.race([Promise.allSettled(confirmReads), page.waitForTimeout(2000)]);
      for (const call of confirmCalls) log('确认接口：save-reg-request ' + JSON.stringify(call));
      page.context().off('response', onConfirmResp);
    }

    await page.waitForURL(url => /\/register\/(photoUpload|purchase)/.test(url.pathname) || url.hostname === 'pps.collegeboard.org',
      { timeout: 25000 }).catch(() => null);
    await page.waitForTimeout(1500);
    return await inspect();
  } catch (e) {
    // 点击或页面检查失败后仍交给人工，避免重复选座或关闭现场。
    return { ...unknown, message: `${unknown.message}（${e.message.split('\n')[0].slice(0, 80)}）` };
  }
}

// 阶段四至六全流程自动化：锁位后处理照片上传、设备申报、订单总核对与信用卡支付 (视频 06:10 - 09:28)
async function handlePostLockProcess(page, onLog, task, photoPath, cardInfo) {
  try {
    // === 步骤 3: 考生证件照上传与合规校验 (视频 06:10 - 07:46) ===
    onLog('正在等待进入证件照上传页面 (Upload Your Photo)...');
    await page.waitForURL(url => url.pathname.includes('photoUpload') || url.pathname.includes('purchase'), { timeout: 20000 }).catch(() => {});
    
    if (page.url().includes('photoUpload')) {
      const uploadPhotoBtn = await page.$('button:has-text("Upload/Edit Photo"), button:has-text("Upload Photo")');
      if (uploadPhotoBtn) await uploadPhotoBtn.click().catch(() => {});

      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 8000 }).catch(() => null);
      if (fileInput && photoPath && fs.existsSync(photoPath)) {
        onLog(`正在推入考生免冠证件照: ${photoPath}...`);
        await fileInput.setInputFiles(photoPath);
        await page.waitForTimeout(2500);
        // 裁切/合规卡片点击 Continue
        const cropContinueBtn = await page.$('button:has-text("Continue"), input[value*="Continue"]');
        if (cropContinueBtn) await cropContinueBtn.click().catch(() => {});
        await page.waitForTimeout(2500);
      }

      // 点击 Next: Check Out 按钮 (视频 07:40)
      const nextCheckoutBtn = await page.waitForSelector('button:has-text("Next: Check Out"), button:has-text("Check Out")', { timeout: 8000 }).catch(() => null);
      if (nextCheckoutBtn) {
        onLog('证件照已确认，进入结账流程 (Next: Check Out)...');
        await nextCheckoutBtn.click();
        await page.waitForTimeout(3000);
      }
    }

    // === 步骤 4 & 5: Check Out - 设备申报与订单复核 (视频 07:45 - 08:35) ===
    await page.waitForURL(url => url.pathname.includes('purchase') || url.pathname.includes('checkout') || url.hostname.includes('pps.collegeboard.org'), { timeout: 20000 }).catch(() => {});

    if (page.url().includes('purchase') || page.url().includes('checkout')) {
      onLog('正在处理考试设备确认 (Tell Us Which Device You\'ll Bring)...');
      // 选择自带笔记本设备
      const deviceSelect = await page.$('select');
      if (deviceSelect) {
        await deviceSelect.selectOption({ index: 1 }).catch(() => {});
      }

      // 签署确认条款勾选框 (视频 08:25 处 [x] I confirm this information is accurate)
      const accurateCheckbox = await page.$('input[type="checkbox"]');
      if (accurateCheckbox) {
        onLog('签署报考信息真实性声明 (I confirm this information is accurate)...');
        await accurateCheckbox.check().catch(() => {});
      }

      // 点击确认进入收银台 (黄色 Confirm 按钮)
      const finalConfirmBtn = await page.$('button:has-text("Confirm")');
      if (finalConfirmBtn) {
        onLog('确认订单无误，正在进入官方支付网关 (PPS)...');
        await finalConfirmBtn.click();
        await page.waitForTimeout(4000);
      }
    }

    // === 步骤 6: 官方收银台 (PPS) 信用卡填单与扣费 (视频 08:35 - 09:28) ===
    await page.waitForURL(url => url.hostname.includes('pps.collegeboard.org'), { timeout: 25000 }).catch(() => {});

    if (page.url().includes('pps.collegeboard.org')) {
      onLog('🎉 已成功抵达 College Board 官方收银台 (pps.collegeboard.org)，准备支付！');

      if (cardInfo && cardInfo.number) {
        // 1. 选择卡种 Type of Card (Visa / MasterCard 等)
        const cardTypeSelect = await page.$('select[name*="type"], select[id*="type"], select[name*="card"]');
        if (cardTypeSelect) {
          const cardTypeVal = cardInfo.cardType || 'Visa';
          await cardTypeSelect.selectOption({ label: cardTypeVal }).catch(async () => {
            await cardTypeSelect.selectOption({ index: 1 }).catch(() => {});
          });
        }

        // 2. 填写卡号
        const cardNumInput = await page.$('input[name*="number"], input[id*="number"], input[name*="card"]');
        if (cardNumInput) {
          await cardNumInput.fill(cardInfo.number);
        }

        // 3. 有效期与安全码
        if (cardInfo.expMonth) {
          const monthSelect = await page.$('select[name*="month"], select[id*="month"], input[name*="month"]');
          if (monthSelect) await monthSelect.selectOption({ label: cardInfo.expMonth }).catch(async () => {
            await monthSelect.fill(cardInfo.expMonth).catch(() => {});
          });
        }
        if (cardInfo.expYear) {
          const yearSelect = await page.$('select[name*="year"], select[id*="year"], input[name*="year"]');
          if (yearSelect) await yearSelect.selectOption({ label: cardInfo.expYear }).catch(async () => {
            await yearSelect.fill(cardInfo.expYear).catch(() => {});
          });
        }
        if (cardInfo.cvv) {
          const cvvInput = await page.$('input[name*="code"], input[id*="code"], input[name*="cvv"], input[name*="security"]');
          if (cvvInput) await cvvInput.fill(cardInfo.cvv);
        }

        onLog('💳 信用卡表单（卡种、卡号、有效期、CVV）已全自动填报就绪！');

        onLog('信用卡信息已尝试填入，请核对考期、考点和金额后人工提交支付；本机版不会自动扣款。');
      } else {
        onLog('已到达收银台，未配置信用卡预填。请人工核对锁位结果、金额并付款。');
      }
    }
  } catch (flowErr) {
    onLog(`后置流程执行提示: ${flowErr.message}`);
  }
}

module.exports = {
  runTaskWorker,
  queryTestCentersViaApi,
  sendPushplus,
  getActivePage: () => activeDebugPage
};
