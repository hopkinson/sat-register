'use strict';

// 官网查位接口客户端（只读查位，不发任何写请求）。
//
// 依据前端资源 data/assets/061_api-YPEdnms7.js：
//   - 服务目录 msregadmintestcenter → https://satreg-api.collegeboard.org
//   - 端点 /msregadmintestcenter-prod/student/search-test-center-admins
//   - 认证头 X-CB-Catapult-Authentication-Token: "CBLogin <JWT>"、X-CB-Catapult-Authorization-Token: <JWT>
//   - 有临时 AWS 凭证时用 aws-api-gateway-client 做 SigV4（region us-east-1，service execute-api）
//   - 响应里的 appToken 由官网自行保存并追加到后续 POST（考期与查位两类请求都会带）
//
// 令牌只从已登录页面读取，在本进程里不落盘、不打日志，也不作为参数在模块间传递。
// 页面内注入的 appToken 不会进入跨进程的请求体或返回值。

const DEFAULT_SEARCH_URL =
  'https://satreg-api.collegeboard.org/msregadmintestcenter-prod/student/search-test-center-admins';
const DEFAULT_UPCOMING_DATES_URL =
  'https://satreg-api.collegeboard.org/msregrequest-prod/student/upcoming-test-dates';
const DIRECTORY = 'msregadmintestcenter';
// 官网报名应用在 003_index 里配置的 appId；查位请求体固定带 srcAppId: 115。
const DEFAULT_SRC_APP_ID = 115;
const UPCOMING_DIRECTORY = 'msregrequest';
const REGION = 'us-east-1';
const SERVICE = 'execute-api';

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

// 在页面上下文执行：不接受外部变量，所有参数从 options 传入。
// SigV4 实现对齐 data/assets/060_aws-api-gateway-client-DxWvNndk.js：
//   canonicalRequest = verb \n path \n query \n canonicalHeaders(末尾带换行) \n signedHeaders \n sha256(body)
//   x-amz-security-token 在签名之后再加（与官网客户端一致，不参与签名）。
async function inPageApiRequest(options) {
  const opts = options || {};
  const kind = opts.kind === 'upcoming-test-dates' ? 'upcoming-test-dates' : 'search';
  const url = String(opts.url || '');
  const directory = opts.directory || (kind === 'upcoming-test-dates' ? 'msregrequest' : 'msregadmintestcenter');
  const region = opts.region || 'us-east-1';
  const service = opts.service || 'execute-api';
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const out = { signed: false, status: 0, ok: false, error: '', centerCount: 0, dateCount: 0 };
  // 官网前端把 appToken 存在 sessionStorage（react-utils 的 je: JSON {localState}）里；
  // window 上的副本只覆盖本次页面生命周期，刷新后仍要能从站点自己的存储里读回。
  const readPageAppToken = () => {
    try {
      const direct = window.__satregAppToken;
      if (typeof direct === 'string' && direct) return direct;
    } catch (e) {}
    for (const storeName of ['sessionStorage', 'localStorage']) {
      try {
        const store = window[storeName];
        if (!store || typeof store.getItem !== 'function') continue;
        const raw = store.getItem('appToken');
        if (!raw) continue;
        let value = raw;
        try {
          const parsed = JSON.parse(raw);
          value = parsed && typeof parsed === 'object' && 'localState' in parsed ? parsed.localState : parsed;
        } catch (e) { /* 站点也可能直接存字符串 */ }
        if (typeof value === 'string' && value) return value;
      } catch (e) {}
    }
    return '';
  };
  // 回传前递归剔除 appToken；结构无法识别时也只把脱敏后的数据交给 Node 进程。
  const stripPageTokens = value => {
    if (Array.isArray(value)) return value.map(stripPageTokens);
    if (value && typeof value === 'object') {
      const copy = {};
      for (const key of Object.keys(value)) {
        if (key.toLowerCase() === 'apptoken') continue;
        copy[key] = stripPageTokens(value[key]);
      }
      return copy;
    }
    return value;
  };
  const encoder = new TextEncoder();
  const toHex = bytes =>
    Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async text => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  const hmac = async (key, message) => new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    encoder.encode(message)
  ));

  let iam = null;
  try { iam = (window.cb && window.cb.core && window.cb.core.iam) || null; } catch (e) { iam = null; }

  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

  if (opts.withAuth !== false) {
    if (!iam) { out.error = 'page-missing-iam'; return out; }
    let jwt = '';
    try { jwt = iam.getJWTToken() || ''; } catch (e) { jwt = ''; }
    if (!jwt) { out.error = 'page-missing-jwt'; return out; }
    headers['X-CB-Catapult-Authentication-Token'] = 'CBLogin ' + jwt;
    headers['X-CB-Catapult-Authorization-Token'] = jwt;
  }

  // 官网每轮响应可能换发 appToken，并把它追加到后续请求体。这里把最新值只存在页面 window 上，
  // 不跨进程回传、不写日志；页面重新加载后自然失效，再由捕获到的官网请求重新建立。
  let bodyToSend = opts.body && typeof opts.body === 'object' ? Object.assign({}, opts.body) : {};
  // 官网 061_api 的 constructRequestBody 在未显式关闭 withAppToken 时，会给所有 POST
  // （包括 upcoming-test-dates）追加当前 appToken；137_test-center 的 getAvailableTestDates
  // 没有关闭该默认行为，所以两类请求都要在页面内补令牌。
  // 令牌只从页面读取并写回页面，绝不出现在跨进程的 options/返回值里。
  const pageToken = readPageAppToken();
  if (pageToken) bodyToSend.appToken = pageToken;
  const payload = JSON.stringify(bodyToSend);

  if (opts.sign !== false) {
    let creds = null;
    try { creds = iam && typeof iam.getTempAWSCreds === 'function' ? iam.getTempAWSCreds(directory) : null; } catch (e) { creds = null; }
    const accessKey = (creds && (creds.accessKeyId || creds.accessKey)) || '';
    const secretKey = (creds && (creds.secretKey || creds.secretAccessKey)) || '';
    const sessionToken = (creds && creds.sessionToken) || '';
    if (!accessKey || !secretKey) {
      // 官网 createClient 在没有临时 AWS 凭证时只发 Catapult 头，不带签名。
      // 这里保持同样行为，避免因为凭证未就绪就整条接口查位不可用。
      out.error = '';
      out.authMode = 'catapult-only';
    } else {
    try {
      const parsed = new URL(url);
      const amzDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const toSign = Object.assign({}, headers, { 'x-amz-date': amzDate, host: parsed.hostname });
      const lower = {};
      for (const key of Object.keys(toSign)) lower[key.toLowerCase()] = String(toSign[key]);
      const names = Object.keys(lower).sort();
      const canonicalHeaders = names.map(name => name + ':' + lower[name] + '\n').join('');
      const signedHeaders = names.join(';');
      const canonicalRequest = 'POST\n' + encodeURI(parsed.pathname) + '\n\n' +
        canonicalHeaders + '\n' + signedHeaders + '\n' + await sha256(payload);
      const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
      const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await sha256(canonicalRequest);
      let key = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
      key = await hmac(key, region);
      key = await hmac(key, service);
      key = await hmac(key, 'aws4_request');
      const signature = toHex(await hmac(key, stringToSign));
      headers['x-amz-date'] = amzDate;
      headers.Authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
      if (sessionToken) headers['x-amz-security-token'] = sessionToken;
      out.signed = true;
      out.authMode = 'sigv4';
    } catch (e) {
      // 签名失败不等于请求不可用：退回 Catapult 头试一次，结果照样如实回报。
      out.error = 'sign-failed:' + ((e && e.message) || e);
      out.authMode = 'catapult-only';
      out.signed = false;
    }
    }
  }

  // 该接口只用 Catapult 头鉴权，不依赖 Cookie；而它的 CORS 预检返回
  // `Access-Control-Allow-Origin: *` + `Allow-Credentials: true`，浏览器在
  // credentials:'include' 时会直接拒绝这种组合（表现为 Failed to fetch）。
  // 所以默认 omit；若服务端确实要求凭据，再回退 include 试一次。
  const sendRequest = async credentials => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        credentials,
        mode: 'cors',
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    let response;
    try {
      response = await sendRequest('omit');
    } catch (omitError) {
      out.error = 'fetch:' + ((omitError && omitError.message) || omitError);
      response = await sendRequest('include');
      out.error = '';
    }
    out.status = response.status;
    out.ok = !!response.ok;
    const text = await response.text();
    out.textLength = text.length;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // 非 JSON 响应也只回传脱敏片段，避免把可能夹带的 appToken 带到 Node 进程。
      out.raw = String(text).slice(0, 300).replace(/("?appToken"?\s*[:=]\s*"?)[^",}\s]+/gi, '$1[redacted]');
    }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.appToken === 'string' && parsed.appToken) {
        try { window.__satregAppToken = parsed.appToken; } catch (e) {}
      }
      if (kind === 'upcoming-test-dates') {
        const dates = Array.isArray(parsed.upcomingSATTestDates) ? parsed.upcomingSATTestDates
          : (parsed.data && Array.isArray(parsed.data.upcomingSATTestDates)) ? parsed.data.upcomingSATTestDates
          : Array.isArray(parsed.data) ? parsed.data
          : Array.isArray(parsed) ? parsed : null;
        if (dates) {
          out.dateCount = dates.length;
          // 只回传匹配考期需要的字段；appToken 只留在页面 window 上。
          out.data = {
            dates: dates.map(item => {
              if (!item || typeof item !== 'object') return {};
              const mapped = {
                adminId: item.adminId,
                testDate: item.testDate,
                testDt: item.testDt,
                alternateTestDt: item.alternateTestDt,
                status: item.status,
                asmtEventId: item.asmtEventId,
                asmtId: item.asmtId,
                registrationDeadlinePassed: item.registrationDeadlinePassed,
                lateRegistrationDeadline: item.lateRegistrationDeadline
              };
              // ssdOptIn 是考期响应里的显式布尔值；只在确实给出时回传，
              // 缺失时保持 undefined，让 Node 侧回退到捕获模板/任务设置。
              if (typeof item.ssdOptIn === 'boolean') mapped.ssdOptIn = item.ssdOptIn;
              return mapped;
            })
          };
        } else {
          out.data = stripPageTokens(parsed);
        }
      } else {
        const list = Array.isArray(parsed.testCenters) ? parsed.testCenters
          : (parsed.data && Array.isArray(parsed.data.testCenters)) ? parsed.data.testCenters
          : Array.isArray(parsed.data) ? parsed.data
          : Array.isArray(parsed) ? parsed : null;
        if (list) {
          // 只回传判定需要的字段，避免把整份响应（含 appToken）跨进程搬运。
          out.centerCount = list.length;
          out.data = {
            testCenters: list.map(center => {
              if (!center || typeof center !== 'object') return {};
              const admins = Array.isArray(center.admins) ? center.admins : [];
              const admin = admins[0] && typeof admins[0] === 'object' ? admins[0] : null;
              return {
                tcCd: center.tcCd,
                tcName: center.tcName,
                tcAdminStatus: center.tcAdminStatus,
                admins: admin ? [{
                  seatAvailable: admin.seatAvailable,
                  tcAdminStatus: admin.tcAdminStatus,
                  eventStartTime: admin.eventStartTime,
                  tamTCAdminId: admin.tamTCAdminId,
                  asmtEventId: admin.asmtEventId,
                  totalCapacity: admin.totalCapacity,
                  totalReservedCap: admin.totalReservedCap
                }] : []
              };
            })
          };
        } else {
          out.data = stripPageTokens(parsed);
        }
      }
    }
  } catch (e) {
    out.error = 'fetch:' + ((e && e.message) || e);
  }
  return out;
}

// 页面上下文里只回答「当前是否已有 appToken」，不把令牌回传。
function inPageHasAppToken() {
  try {
    const direct = window.__satregAppToken;
    if (typeof direct === 'string' && direct) return true;
  } catch (e) {}
  for (const storeName of ['sessionStorage', 'localStorage']) {
    try {
      const store = window[storeName];
      if (!store || typeof store.getItem !== 'function') continue;
      const raw = store.getItem('appToken');
      if (!raw) continue;
      let value = raw;
      try {
        const parsed = JSON.parse(raw);
        value = parsed && typeof parsed === 'object' && 'localState' in parsed ? parsed.localState : parsed;
      } catch (e) {}
      if (typeof value === 'string' && value) return true;
    } catch (e) {}
  }
  return false;
}

// 缓存命中时确认页面仍持有 appToken：缺失就重新拉考期，避免拿旧缓存发出不带令牌的查位请求。
async function hasPageAppToken(page) {
  if (!page || typeof page.evaluate !== 'function') return false;
  try {
    return await withTimeout(page.evaluate(inPageHasAppToken), 3000, '读取页面 appToken 超时') === true;
  } catch (e) {
    return false;
  }
}

// 在已登录页面里调用官网只读接口。返回结构固定，调用方不需要再解析页面异常。
async function callPageApi(page, options, kind, label) {
  if (!page || typeof page.evaluate !== 'function') return { ok: false, error: '没有可用的活动页面' };
  if (!options || !options.body || typeof options.body !== 'object') return { ok: false, error: '缺少请求体' };
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const startedAt = Date.now();
  const isDates = kind === 'upcoming-test-dates';
  let raw;
  try {
    raw = await withTimeout(page.evaluate(inPageApiRequest, {
      kind,
      url: options.url || (isDates ? DEFAULT_UPCOMING_DATES_URL : DEFAULT_SEARCH_URL),
      body: options.body,
      withAuth: options.withAuth !== false,
      sign: options.sign !== false,
      directory: options.directory || (isDates ? UPCOMING_DIRECTORY : DIRECTORY),
      region: options.region || REGION,
      service: options.service || SERVICE,
      timeoutMs
    }), timeoutMs + 5000, '页面内' + label + '请求超时');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).split('\n')[0], durationMs: Date.now() - startedAt };
  }
  const result = {
    ok: !!(raw && raw.ok),
    status: Number(raw && raw.status) || 0,
    signed: !!(raw && raw.signed),
    authMode: (raw && raw.authMode) || '',
    error: (raw && raw.error) || '',
    durationMs: Date.now() - startedAt
  };
  if (isDates) {
    result.dateCount = Number(raw && raw.dateCount) || 0;
    result.dates = raw && raw.data && Array.isArray(raw.data.dates) ? raw.data.dates : null;
  } else {
    result.centerCount = Number(raw && raw.centerCount) || 0;
  }
  if (raw && raw.data && typeof raw.data === 'object') result.data = raw.data;
  else if (raw && raw.raw) result.snippet = String(raw.raw).slice(0, 300);
  if (!result.ok && !result.error) {
    const body = result.data || {};
    result.error = body.message || body.errorMessage || body.error || ('HTTP ' + result.status);
  }
  return result;
}

async function searchTestCenterAdmins(page, options = {}) {
  return callPageApi(page, options, 'search', '查位');
}

// 拉取目标地区的可用考期；响应里的 asmtEventId 是查位请求的必需参数。
async function upcomingTestDates(page, options = {}) {
  const body = options.body && typeof options.body === 'object'
    ? options.body
    : buildUpcomingDatesBody(options);
  if (!body) return { ok: false, error: '缺少考期请求体' };
  return callPageApi(page, Object.assign({}, options, { body }), 'upcoming-test-dates', '考期');
}

// 响应里的考点数组层级不固定，统一在这里取。
function extractTestCenters(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = payload.testCenters || (payload.data && payload.data.testCenters) || payload.data || payload;
  return Array.isArray(list) ? list : [];
}

// 与 extractTestCenters 同一套取数组层级，但把「根本不是考点数组」与「考点数组为空」区分开：
// 前者 null（响应格式变了解析不了），后者 []（接口确实返回零个考点）。
function testCenterList(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const list = payload.testCenters || (payload.data && payload.data.testCenters) || payload.data || payload;
  return Array.isArray(list) ? list : null;
}

function adminFor(center) {
  const admins = center && Array.isArray(center.admins) ? center.admins : [];
  return admins[0] || null;
}

// 官网卡片只认 admins[0]：有 admin 且 seatAvailable 才可选；Closed / Suspended 的考点被官网过滤。
function centerAvailability(center) {
  const admin = adminFor(center);
  if (!admin) return { available: false, admin: null, reason: '考点无 admin 明细' };
  const status = admin.tcAdminStatus;
  if (status === 'Closed' || status === 'Suspended') {
    return { available: false, admin, reason: '考点状态 ' + status };
  }
  const seat = admin.seatAvailable;
  // 官网卡片是 truthy 判定（admins[0].seatAvailable）；这里额外排除显式否值。
  // 宁可多跑一次页面确认，也不把「其实有位」误判成无位。
  const available = !!seat && seat !== 'false' && seat !== 'N' && seat !== 0;
  return { available, admin, reason: available ? '' : 'seatAvailable=false' };
}

function normalize(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesTarget(center, target) {
  const wanted = normalize(target);
  if (!wanted) return true;
  if (/^\d+$/.test(wanted)) return String(center.tcCd == null ? '' : center.tcCd) === wanted;
  const name = normalize(center.tcName);
  return name === wanted || name.includes(wanted);
}

// 把接口结果映射成引擎现有的 available / unavailable / unknown 三种状态。
function matchAvailability(centers, targets, options = {}) {
  const list = (Array.isArray(centers) ? centers : []).filter(center => center && typeof center === 'object');
  if (!list.length) {
    // 空列表几乎总是「查询条件不对」（asmtEventId 过期等），不是「全国无考点」。
    // 报 unknown 让它回退页面查位，比谎报无位安全。
    return { status: 'unknown', matchedCount: 0, availableCount: 0, reason: '接口返回空考点列表' };
  }
  const wanted = (Array.isArray(targets) ? targets : []).map(normalize).filter(Boolean);
  const matched = wanted.length ? list.filter(center => wanted.some(target => matchesTarget(center, target))) : list;
  if (!matched.length) {
    return { status: 'unknown', matchedCount: 0, availableCount: 0, reason: '接口结果中未找到目标考点' };
  }
  // asmtEventId 过期时接口可能返回另一场考试的考点；eventStartTime 对不上就不采信。
  const wantedDate = dateOnly(options.targetDate);
  if (wantedDate) {
    const mismatched = matched.some(center => {
      const admin = adminFor(center);
      const eventDate = dateOnly(admin && admin.eventStartTime);
      return eventDate && eventDate !== wantedDate;
    });
    if (mismatched) {
      return { status: 'unknown', matchedCount: matched.length, availableCount: 0, reason: '接口返回的考点考期与目标日期不一致' };
    }
  }
  const available = matched.filter(center => centerAvailability(center).available);
  if (available.length) {
    const center = available[0];
    return {
      status: 'available',
      matchedCenter: center.tcName || center.tcCd || '',
      center,
      admin: adminFor(center),
      matchedCount: matched.length,
      availableCount: available.length,
      reason: ''
    };
  }
  // 「没有 admin 明细」不等于「已满」：官网卡片此时根本不会渲染，页面查位只会给未知。
  // 宁可报 unknown 回退页面，也不要把尚未放考期的考点误判成无位。
  const missingDetail = matched.some(center => !adminFor(center));
  if (missingDetail) {
    return { status: 'unknown', matchedCount: matched.length, availableCount: 0, reason: '目标考点缺少 admin 明细' };
  }
  const complete = wanted.every(target => list.some(center => matchesTarget(center, target)));
  return complete
    ? { status: 'unavailable', matchedCount: matched.length, availableCount: 0, reason: '' }
    : { status: 'unknown', matchedCount: matched.length, availableCount: 0, reason: '部分目标考点未出现在接口结果中' };
}

// 没有捕获到官网原始请求体时的兜底构造（对应 137_test-center 里国际查位的 er()）。
// 只有显式给出 asmtEventId 才可用；asmtId 默认 99（官网 SAT 兜底值）。
function buildSearchBody(options) {
  const opts = options || {};
  const date = String(opts.eventStartDt || '').trim();
  const country = String(opts.countryCode || '').trim().toUpperCase();
  const asmtEventId = opts.asmtEventId;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!/^[A-Z]{2}$/.test(country)) return null;
  if (asmtEventId == null || asmtEventId === '') return null;
  const asmtId = opts.asmtId == null || opts.asmtId === '' ? 99 : opts.asmtId;
  const body = {
    options: {},
    eventStartDt: date,
    tcAsmtFamilyCd: 1,
    tcAsmtId: [String(asmtId)],
    tcCountryISOCode: country,
    tcPostalCd: '',
    asmtEventId: Number(asmtEventId),
    ssdOptIn: opts.ssdOptIn === true,
    isSimpleSearch: true
  };
  const srcAppId = opts.srcAppId == null || opts.srcAppId === '' ? DEFAULT_SRC_APP_ID : Number(opts.srcAppId);
  if (Number.isFinite(srcAppId)) body.srcAppId = srcAppId;
  // appToken 不在这里拼装：它只由页面上下文在发送前注入。
  return body;
}

// 从官网原生查位请求体里只保留重放需要的字段（丢弃可能存在的其它筛选条件）。
// 这些字段只留在内存里复用，绝不写日志、不落盘。
function pickSearchTemplate(postData) {
  if (!postData || typeof postData !== 'object' || Array.isArray(postData)) return null;
  const asmtEventId = Number(postData.asmtEventId);
  if (!Number.isFinite(asmtEventId) || asmtEventId <= 0) return null;
  const template = {
    asmtEventId,
    eventStartDt: String(postData.eventStartDt || '').slice(0, 10),
    tcCountryISOCode: String(postData.tcCountryISOCode || '').toUpperCase(),
    tcAsmtFamilyCd: Number(postData.tcAsmtFamilyCd) || 1,
    tcAsmtId: Array.isArray(postData.tcAsmtId) ? postData.tcAsmtId.map(String) : null,
    ssdOptIn: postData.ssdOptIn === true,
    isSimpleSearch: postData.isSimpleSearch !== false,
    srcAppId: postData.srcAppId
    // appToken 不进入模板：它由页面在发送前从 window / sessionStorage 读取并注入。
  };
  if (template.eventStartDt.length !== 10) template.eventStartDt = '';
  return template;
}

// 用捕获到的模板重建请求体；考期不一致时 asmtEventId 会失效，直接返回 null 交给页面兜底。
function buildReplayBody(template, task) {
  const t = template;
  const job = task || {};
  if (!t || !t.asmtEventId) return null;
  const date = String(job.targetDate || '').trim();
  const country = String(job.targetCountryCode || '').trim().toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{2}$/.test(country)) return null;
  if (t.eventStartDt !== date) return null;
  const body = {
    options: {},
    eventStartDt: date,
    tcAsmtFamilyCd: t.tcAsmtFamilyCd || 1,
    tcAsmtId: t.tcAsmtId || ['99'],
    tcCountryISOCode: country,
    tcPostalCd: '',
    asmtEventId: t.asmtEventId,
    ssdOptIn: t.ssdOptIn === true,
    isSimpleSearch: true
  };
  const srcAppId = t.srcAppId == null || t.srcAppId === '' ? DEFAULT_SRC_APP_ID : Number(t.srcAppId);
  if (Number.isFinite(srcAppId)) body.srcAppId = srcAppId;
  // appToken 不在这里拼装：它只由页面上下文在发送前注入。
  return body;
}

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

// 把 ISO、斜杠日期和官网展示日期统一成 YYYY-MM-DD；无法识别时返回空串。
function dateOnly(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (match) return match[3] + '-' + match[1].padStart(2, '0') + '-' + match[2].padStart(2, '0');
  match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (match) {
    const month = MONTH_NAMES[match[1].toLowerCase()];
    if (month) return match[3] + '-' + String(month).padStart(2, '0') + '-' + match[2].padStart(2, '0');
  }
  return '';
}

function extractUpcomingDates(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload.upcomingSATTestDates) ? payload.upcomingSATTestDates
    : Array.isArray(payload.dates) ? payload.dates
    : payload.data && Array.isArray(payload.data.upcomingSATTestDates) ? payload.data.upcomingSATTestDates
    : payload.data && Array.isArray(payload.data.dates) ? payload.data.dates
    : payload.data && Array.isArray(payload.data) ? payload.data
    : [];
  return list.filter(item => item && typeof item === 'object');
}

// 考期对象只保留匹配与下单需要的字段，绝不透传 appToken。
// ssdOptIn 只在响应显式给出布尔值时才保留；缺失/非布尔一律 undefined，
// 让调用方能回退到捕获模板或任务设置，而不是被误判成 false。
function sanitizeUpcomingOption(item) {
  const option = {
    adminId: item.adminId,
    testDate: item.testDate,
    testDt: item.testDt,
    alternateTestDt: item.alternateTestDt,
    status: item.status,
    asmtEventId: item.asmtEventId,
    asmtId: item.asmtId,
    registrationDeadlinePassed: item.registrationDeadlinePassed,
    lateRegistrationDeadline: item.lateRegistrationDeadline
  };
  if (typeof item.ssdOptIn === 'boolean') option.ssdOptIn = item.ssdOptIn;
  return option;
}

// 目标任务日期必须命中带有效 asmtEventId 的考期；
// 官网前端（137_test-center 的 Ua）只在 status === 'Y' 时认为该日期可报名，
// 因此显式非 'Y' 一律排除；status 缺失时无法判断，只在同一天没有 'Y' 条目时才作为兜底候选，
// 以免响应字段变化时把「还能报名」误判成「不能报名」。
// 常规日期优先于 alternateTestDt（周日考试兜底），'Y' 优先于缺失 status。
function pickTestDateOption(payload, targetDate) {
  const target = dateOnly(targetDate);
  if (!target) return null;
  let best = null;
  for (const item of extractUpcomingDates(payload)) {
    const status = item.status == null ? '' : String(item.status).toUpperCase();
    if (status && status !== 'Y') continue;
    const eventId = Number(item.asmtEventId);
    if (!Number.isFinite(eventId) || eventId <= 0) continue;
    const primary = dateOnly(item.testDate || item.testDt);
    const alternate = dateOnly(item.alternateTestDt);
    let match = '';
    if (primary === target) match = 'testDate';
    else if (alternate === target) match = 'alternateTestDt';
    if (!match) continue;
    const rank = (match === 'testDate' ? 2 : 0) + (status === 'Y' ? 1 : 0);
    if (!best || rank > best.rank) best = { match, item, rank };
  }
  if (!best) return null;
  const option = sanitizeUpcomingOption(best.item);
  return {
    date: target,
    match: best.match,
    adminId: option.adminId,
    asmtEventId: Number(option.asmtEventId),
    asmtId: option.asmtId,
    ssdOptIn: option.ssdOptIn,
    option
  };
}

// 对应 137_test-center 的 es(): { isUSDomesticInd, ...typeCodes, ssdOptIn }。
function buildUpcomingDatesBody(options) {
  const opts = options || {};
  const country = String(opts.countryCode || opts.country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  return {
    isUSDomesticInd: country === 'US' ? 'Y' : 'N',
    asmtFamilyCd: opts.asmtFamilyCd == null ? 1 : Number(opts.asmtFamilyCd),
    asmtSubtypeCd: opts.asmtSubtypeCd == null ? 2 : Number(opts.asmtSubtypeCd),
    ssdOptIn: opts.ssdOptIn === true
  };
}

// 捕获官网原生考期请求时只保留类型字段，用于校验与复用；不保留 appToken。
function pickUpcomingDatesTemplate(postData) {
  if (!postData || typeof postData !== 'object' || Array.isArray(postData)) return null;
  const family = Number(postData.asmtFamilyCd);
  const subtype = Number(postData.asmtSubtypeCd);
  if (!Number.isFinite(family) || !Number.isFinite(subtype)) return null;
  return {
    isUSDomesticInd: postData.isUSDomesticInd === 'Y' || postData.isUSDomesticInd === true ? 'Y' : 'N',
    asmtFamilyCd: family,
    asmtSubtypeCd: subtype,
    ssdOptIn: postData.ssdOptIn === true
  };
}

module.exports = {
  DEFAULT_SEARCH_URL,
  DEFAULT_UPCOMING_DATES_URL,
  DIRECTORY,
  UPCOMING_DIRECTORY,
  REGION,
  SERVICE,
  DEFAULT_SRC_APP_ID,
  inPageApiRequest,
  inPageHasAppToken,
  hasPageAppToken,
  inPageSearchRequest: inPageApiRequest,
  searchTestCenterAdmins,
  upcomingTestDates,
  extractTestCenters,
  extractUpcomingDates,
  testCenterList,
  matchAvailability,
  centerAvailability,
  buildSearchBody,
  pickSearchTemplate,
  buildReplayBody,
  dateOnly,
  pickTestDateOption,
  buildUpcomingDatesBody,
  pickUpcomingDatesTemplate
};

