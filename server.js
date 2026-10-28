const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 保持 stdin 打开，防止后台执行时因 stdin 关闭导致进程退出
if (process.stdin.resume) {
  process.stdin.resume();
}

function writeDebug(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(path.join(__dirname, 'data', 'server_debug.log'), line, 'utf8');
}

process.on('uncaughtException', (err) => {
  writeDebug(`[CRITICAL] 未捕获异常: ${err.stack || err.message}`);
  console.error('[CRITICAL] 未捕获异常:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeDebug(`[CRITICAL] 未处理拒绝: ${reason}`);
  console.error('[CRITICAL] 未处理拒绝:', reason);
});
process.on('exit', (code) => {
  writeDebug(`[PROCESS EXIT] code: ${code}`);
});

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// 数据目录与文件
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 初始数据结构
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      throw new Error('data/db.json 无法读取，请从备份恢复；为保护原数据，服务已停止。');
    }
  }
  const defaultDB = {
    tasks: [],
    stats: { totalPolls: 0, totalLocks: 0 },
    settings: { pushplusToken: '' },
    logs: {} // taskId -> []
  };
  saveDB(defaultDB);
  return defaultDB;
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

let db = loadDB();
if (!db.settings) db.settings = { pushplusToken: '' };

// 进程重启后没有任何浏览器任务在运行，不能沿用上次的运行标记。
let recovered = false;
for (const task of db.tasks) {
  if (['running', 'locked', 'needs_action'].includes(task.status)) {
    task.status = 'idle';
    task.lockExpiry = null;
    task.lastLog = '服务已重新启动，请核对官网报名状态后手动启动任务';
    recovered = true;
  }
}
if (recovered) saveDB(db);

function publicTask(task) {
  const { password, cardInfo, ...visible } = task;
  return visible;
}

// 内存中运行中的 worker 管理
const runningWorkers = new Map(); // taskId -> { engine, stop() }

// SSE 客户端管理 (用于手机端实时数据推送)
const sseClients = new Set();
function broadcast(event, payload) {
  if (event === 'task_created' || event === 'task_updated') payload = publicTask(payload);
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// 记录并广播日志
function appendTaskLog(taskId, message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const logItem = `[${time}] ${message}`;
  if (!db.logs[taskId]) db.logs[taskId] = [];
  db.logs[taskId].push(logItem);
  if (db.logs[taskId].length > 100) db.logs[taskId].shift(); // 最多存100条
  
  const task = db.tasks.find(t => t.id === taskId);
  if (task) {
    task.lastLog = logItem;
    saveDB(db);
  }
  broadcast('log', { taskId, log: logItem });
}

app.use((req, res, next) => {
  const origins = [`http://127.0.0.1:${server.address()?.port}`, `http://localhost:${server.address()?.port}`];
  if (!['127.0.0.1', 'localhost'].includes(req.hostname) || (req.headers.origin && !origins.includes(req.headers.origin))) {
    return res.status(403).json({ error: '只允许从本机控制台访问' });
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
// 第三方库走长缓存；页面本体不缓存，保证改动即时生效。
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. SSE 实时长连接
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify({ tasks: db.tasks.map(publicTask), stats: db.stats })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// 2. 获取任务与统计
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: db.tasks.map(publicTask), stats: db.stats });
});

// 官网公开字典；每次请求重新获取，不保存本地名单。
app.get('/api/sat-regions', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const source = 'https://atlas.collegeboard.org/apricot/prod/4.11.5/api/CBCountries.json';
  try {
    const response = await fetch(source, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('官网请求失败');
    const data = await response.json();
    if (!Array.isArray(data.countries) || !data.countries.length || data.countries.some(c =>
      !c || typeof c.countryName !== 'string' || !c.countryName.trim() || typeof c.iso !== 'string' || !/^[a-z]{2}$/i.test(c.iso))) {
      throw new Error('官网数据格式异常');
    }
    const regions = data.countries.filter(c => c.iso.toUpperCase() !== 'US')
      .map(c => ({ code: c.iso.toUpperCase(), name: c.countryName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!regions.length) throw new Error('官网地区列表为空');
    res.json({ source, fetchedAt: new Date().toISOString(), regions });
  } catch (error) {
    res.status(502).json({ error: '官网地区列表加载失败，请重试' });
  }
});

// 官方考期列表；每次请求重新获取，与地区名单同一纪律。
app.get('/api/sat-exam-dates', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const source = 'https://sat-admin-dates.collegeboard.org/';
  try {
    const response = await fetch(source, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('官网请求失败');
    const data = await response.json();
    if (!Array.isArray(data) || !data.length || data.some(d =>
      !d || d.eventInternational === false || typeof d.eventFormattedDate !== 'string' ||
      !Number.isFinite(Date.parse(d.eventFormattedDate)) ||
      new Date(d.eventFormattedDate + 'T00:00:00Z').toISOString().slice(0, 10) !== d.eventFormattedDate)) {
      throw new Error('官网数据格式异常');
    }
    const dates = [...new Set(data.map(d => d.eventFormattedDate))].sort();
    if (!dates.length) throw new Error('官网考期列表为空');
    res.json({ source, fetchedAt: new Date().toISOString(), dates });
  } catch (error) {
    res.status(502).json({ error: '官网考期列表加载失败，请重试' });
  }
});

// 2.1 透传拉取官网指定日期与考区的真实考点列表
app.get('/api/sat-centers', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { date, country } = req.query;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof country !== 'string' || !/^[A-Z]{2}$/.test(country) || country === 'US') {
    return res.status(400).json({ error: '请选择有效考期与国际考区；美国需邮编查询，暂未支持' });
  }
  try {
    const url = `https://aru-test-center-search.collegeboard.org/prod/test-centers?date=${encodeURIComponent(date)}&country=${encodeURIComponent(country)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return res.status(502).json({ error: '官网考点列表查询失败' });
    const data = await resp.json();
    if (!Array.isArray(data)) return res.status(502).json({ error: '官网考点列表格式异常' });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: '官网考点列表查询失败' });
  }
});

// 3. 新建任务
app.post('/api/tasks', (req, res) => {
  const { name, targetDate, targetRegion, targetCountryCode, targetCenters, targetCenter } = req.body;
  const currentAccount = db.settings?.satAccount || '';
  const currentPassword = db.settings?.satPassword || '';
  if (typeof currentAccount !== 'string' || typeof currentPassword !== 'string' ||
      (name !== undefined && typeof name !== 'string')) {
    return res.status(400).json({ error: '姓名、账号和密码必须是文本' });
  }
  if (!currentAccount.trim() || !currentPassword) {
    return res.status(400).json({ error: '请先在设置中配置全局 SAT 账号和密码' });
  }
  if (typeof targetCountryCode !== 'string' || !/^[A-Z]{2}$/.test(targetCountryCode) || targetCountryCode === 'US' ||
      typeof targetRegion !== 'string' || !targetRegion.trim()) {
    return res.status(400).json({ error: '请选择官网加载的国际考区；美国需邮编查询，暂未支持' });
  }
  if (targetDate && (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
      !Number.isFinite(Date.parse(targetDate)) || new Date(targetDate).toISOString().slice(0, 10) !== targetDate)) {
    return res.status(400).json({ error: '考试日期无效' });
  }

  const centers = Array.isArray(targetCenters) && targetCenters.length > 0
    ? targetCenters
    : (targetCenter ? [targetCenter] : []);

  const newTask = {
    id: 'task_' + require('crypto').randomUUID(),
    name: name || '核心考生',
    targetDate: targetDate || '2026-12-05',
    targetRegion,
    targetCountryCode,
    targetCenters: centers,
    operator: req.body.operator || '曾总',
    photoPath: '',
    cardInfo: req.body.cardInfo || db.settings?.cardInfo || null,
    status: 'idle', // idle, running, locked, error, completed
    pollCount: 0,
    lastCheckTime: null,
    lastLog: '任务已录入，等待启动',
    lockExpiry: null,
    lockedCenter: null,
    createdAt: new Date().toISOString()
  };

  // 考生专属证件照写入磁盘
  if (req.body.photoBase64) {
    try {
      const base64Data = req.body.photoBase64.replace(/^data:image\/\w+;base64,/, '');
      const photoFile = path.join(DATA_DIR, `photo_${newTask.id}.jpg`);
      fs.writeFileSync(photoFile, Buffer.from(base64Data, 'base64'));
      newTask.photoPath = photoFile;
    } catch (e) {
      console.error('保存考生证件照失败:', e.message);
    }
  }

  db.tasks.unshift(newTask);
  db.logs[newTask.id] = [`[${new Date().toLocaleTimeString()}] 任务录入成功`];
  saveDB(db);

  broadcast('task_created', newTask);
  res.json({ success: true, task: publicTask(newTask) });
});

// 仅停止后的任务可修改，避免 worker 混用新旧配置。
app.patch('/api/tasks/:id', (req, res) => {
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (runningWorkers.has(task.id) || !['idle', 'error'].includes(task.status)) {
    return res.status(409).json({ error: task.status === 'completed' ? '已完成任务不能编辑' : '请先停止任务，再编辑' });
  }
  const { targetDate, targetCenters, photoBase64, removePhoto } = req.body;
  if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
      !Number.isFinite(Date.parse(targetDate)) || new Date(targetDate).toISOString().slice(0, 10) !== targetDate) {
    return res.status(400).json({ error: '考试日期无效' });
  }
  if (!Array.isArray(targetCenters) || targetCenters.length > 10 ||
      targetCenters.some(c => typeof c !== 'string' || !c.trim() || c.length > 500) ||
      (removePhoto !== undefined && typeof removePhoto !== 'boolean') || (removePhoto && photoBase64 !== undefined)) {
    return res.status(400).json({ error: '考点或照片操作无效' });
  }
  let photo;
  if (photoBase64 !== undefined) {
    const match = typeof photoBase64 === 'string' && photoBase64.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return res.status(400).json({ error: '请选择 JPG、PNG 或 WebP 图片' });
    photo = Buffer.from(match[2], 'base64');
    const validImage = match[1] === 'jpeg' ? photo.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : match[1] === 'png' ? photo.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : photo.toString('ascii', 0, 4) === 'RIFF' && photo.toString('ascii', 8, 12) === 'WEBP';
    if (!validImage || photo.length > 5 * 1024 * 1024 || photo.toString('base64') !== match[2]) {
      return res.status(400).json({ error: '图片内容无效或超过 5 MB' });
    }
  }
  const photoFile = path.join(DATA_DIR, `photo_${task.id}.jpg`);
  const photoChanged = photo !== undefined || removePhoto === true;
  let previousPhoto;
  try {
    if (photoChanged) {
      previousPhoto = fs.existsSync(photoFile) ? fs.readFileSync(photoFile) : null;
      if (photo) {
        fs.writeFileSync(photoFile + '.tmp', photo);
        fs.renameSync(photoFile + '.tmp', photoFile);
      } else if (previousPhoto) fs.unlinkSync(photoFile);
    }
    const message = `任务配置已修改：考期 ${task.targetDate} → ${targetDate}；${photo ? '证件照已更换' : removePhoto ? '证件照已移除' : '证件照保留'}。请核对官网信息后手动启动；本地修改不代表官网已更新。`;
    const log = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
    const updated = { ...task, targetDate, targetCenters, status: 'idle', selection: null,
      lockedCenter: null, lockExpiry: null, lastLog: log,
      photoPath: photo ? photoFile : removePhoto ? '' : task.photoPath };
    const nextDB = { ...db, tasks: db.tasks.map(t => t.id === task.id ? updated : t),
      logs: { ...db.logs, [task.id]: [...(db.logs[task.id] || []), log].slice(-100) } };
    saveDB(nextDB);
    db = nextDB;
    broadcast('task_updated', updated);
    broadcast('log', { taskId: task.id, log });
    res.json({ success: true, task: publicTask(updated) });
  } catch (err) {
    if (photoChanged && previousPhoto !== undefined) {
      if (previousPhoto) fs.writeFileSync(photoFile, previousPhoto);
      else if (fs.existsSync(photoFile)) fs.unlinkSync(photoFile);
    }
    if (fs.existsSync(photoFile + '.tmp')) fs.unlinkSync(photoFile + '.tmp');
    res.status(500).json({ error: '修改未保存，请检查本机磁盘后重试' });
  }
});

// 磁盘清理辅助函数：删除指定任务的截图与浏览器隔离目录
function cleanupTaskFiles(taskId) {
  try {
    const screenshotPath = path.join(DATA_DIR, `screenshot_${taskId}.jpg`);
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    const photoPath = path.join(DATA_DIR, `photo_${taskId}.jpg`);
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    const profileDir = path.join(DATA_DIR, `profile_${taskId}`);
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {}
}

// 本机版保留照片和登录状态，只有用户明确删除/完成任务时才清理。

// 4. 删除任务
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const worker = runningWorkers.get(id);
  if (worker) {
    try { await worker.stop(); } catch (e) {}
    runningWorkers.delete(id);
  }
  db.tasks = db.tasks.filter(t => t.id !== id);
  delete db.logs[id];
  saveDB(db);

  // 清理服务器磁盘残留文件与浏览器缓存
  cleanupTaskFiles(id);

  broadcast('task_deleted', { id });
  res.json({ success: true });
});

// 5. 启动任务
app.post('/api/tasks/:id/start', async (req, res) => {
  const { id } = req.params;
  const task = db.tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (runningWorkers.has(id)) return res.json({ success: true, message: '已经在运行中' });

  task.status = 'running';
  task.selection = null;
  saveDB(db);
  broadcast('task_updated', task);
  appendTaskLog(id, '收到启动指令，正在初始化自动化环境...');

  // 动态导入 engine，避免阻塞启动
  try {
    const { runTaskWorker } = require('./sat-engine');
    const worker = runTaskWorker({
      task,
      onLog: (msg) => appendTaskLog(id, msg),
      onPoll: () => {
        task.pollCount = (task.pollCount || 0) + 1;
        task.lastCheckTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        db.stats.totalPolls = (db.stats.totalPolls || 0) + 1;
        saveDB(db);
        broadcast('task_updated', task);
      },
      onNeedsAction: (centerName, selection) => {
        task.status = 'needs_action';
        task.selection = selection;
        task.lockedCenter = centerName;
        task.lockExpiry = null;
        saveDB(db);
        broadcast('task_updated', task);
        appendTaskLog(id, selection.message);
      },
      onResume: () => {
        task.status = 'running';
        task.selection = null;
        task.lockedCenter = null;
        saveDB(db);
        broadcast('task_updated', task);
      },
      onExit: () => {
        if (runningWorkers.get(id) !== worker) return;
        runningWorkers.delete(id);
        if (task.status === 'running' || task.status === 'needs_action') {
          task.status = 'idle';
          appendTaskLog(id, '浏览器任务已结束；请核对官网结果后决定是否重新启动');
          broadcast('task_updated', task);
        }
      },
      onError: (errMsg) => {
        runningWorkers.delete(id);
        task.status = 'error';
        task.lastLog = `❌ 运行异常: ${errMsg}`;
        saveDB(db);
        broadcast('task_updated', task);
        appendTaskLog(id, `❌ 运行异常: ${errMsg}`);

        // 微信主动推送故障原因
        const currentSettings = db.settings || {};
        const notifyToken = task.pushplusToken || currentSettings.pushplusToken;
        if (notifyToken) {
          const { sendPushplus } = require('./sat-engine');
          sendPushplus(
            notifyToken,
            `⚠️ SAT 监控异常报警 [${task.name}]`,
            `考生姓名：${task.name}<br>当前状态：已中断退出<br>具体原因：<b style="color:#d9534f;">${errMsg}</b><br>排查建议：请根据上述原因检查SAT账号/密码或人工登录解除风控后再点击启动。`
          ).catch(() => {});
        }
      }
    });

    runningWorkers.set(id, worker);
    res.json({ success: true });
  } catch (err) {
    task.status = 'error';
    saveDB(db);
    broadcast('task_updated', task);
    res.status(500).json({ error: err.message });
  }
});

// 6. 暂停/停止任务
app.post('/api/tasks/:id/stop', async (req, res) => {
  const { id } = req.params;
  const task = db.tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const worker = runningWorkers.get(id);
  if (worker) {
    try { await worker.stop(); } catch (e) {}
    runningWorkers.delete(id);
  }

  task.status = 'idle';
  saveDB(db);
  broadcast('task_updated', task);
  appendTaskLog(id, '任务已手动停止');
  res.json({ success: true });
});

// 6.1 标记任务完成
app.post('/api/tasks/:id/complete', async (req, res) => {
  const { id } = req.params;
  const task = db.tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const worker = runningWorkers.get(id);
  if (worker) {
    try { await worker.stop(); } catch (e) {}
    runningWorkers.delete(id);
  }

  task.status = 'completed';
  task.lastLog = '✅ 任务已确认完成';
  saveDB(db);
  broadcast('task_updated', task);
  appendTaskLog(id, '✅ 任务已确认完成，本地浏览器缓存及文件已清理回收');
  cleanupTaskFiles(id);
  res.json({ success: true });
});

// 7. 获取任务日志
app.get('/api/tasks/:id/logs', (req, res) => {
  const { id } = req.params;
  res.json({ logs: db.logs[id] || [] });
});

// 8. 获取当前截图
app.get('/api/tasks/:id/screenshot', (req, res) => {
  const { id } = req.params;
  const screenshotPath = path.join(DATA_DIR, `screenshot_${id}.jpg`);
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).send('暂无截图');
  }
});

// 调试接口：只读执行页面表达式，用于排查官网页面结构（不修改任何状态）。
app.get('/api/debug/eval', async (req, res) => {
  try {
    const { getActivePage } = require('./sat-engine');
    const page = getActivePage && getActivePage();
    if (!page || page.isClosed()) return res.json({ error: '当前没有活动页面' });
    const expr = String(req.query.expr || '1');
    if (expr.length > 4000) return res.status(400).json({ error: '表达式过长' });
    const frameHint = String(req.query.frame || '');
    // frame 参数用于在指定子框架（如验证码 iframe）里执行只读查询。
    const target = frameHint ? page.frames().find(f => f.url().includes(frameHint)) : page.mainFrame();
    if (!target) return res.json({ error: `未找到包含 ${frameHint} 的框架`, frames: page.frames().map(f => f.url().slice(0, 60)) });
    // click=<选择器> 时执行一次真实鼠标点击（用于验证码等只吃真实事件的控件），坐标按页面绝对位置换算。
    const clickSel = String(req.query.click || '');
    if (clickSel) {
      const frame = frameHint ? page.frames().find(f => f.url().includes(frameHint)) : page.mainFrame();
      const handle = await frame.$(clickSel);
      if (!handle) return res.json({ error: `框架内未找到 ${clickSel}`, url: frame.url().slice(0, 120) });
      const box = await handle.boundingBox();
      if (!box) return res.json({ error: '元素无可点击区域' });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return res.json({ clicked: true, at: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } });
    }
    const result = await target.evaluate(expr);
    res.json({ result, url: target.url().slice(0, 120) });
  } catch (e) {
    res.status(500).json({ error: e.message.split('\n')[0] });
  }
});

// 9. 获取系统设置
app.get('/api/settings', (req, res) => {
  res.json({ settings: db.settings || {} });
});

// 10. 保存系统设置
app.post('/api/settings', (req, res) => {
  db.settings = { ...(db.settings || {}), ...(req.body || {}) };
  saveDB(db);
  res.json({ success: true, settings: db.settings });
});

// 11. 查看指定任务考生的证件照
app.get('/api/tasks/:id/photo', (req, res) => {
  const photoFile = path.join(DATA_DIR, `photo_${req.params.id}.jpg`);
  if (fs.existsSync(photoFile)) {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(photoFile);
  } else {
    res.status(404).send('该任务暂无证件照');
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，请检查已有控制台或关闭占用程序。` : err.message);
  process.exit(1);
});

async function shutdown() {
  if (shutdown.started) return;
  shutdown.started = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  const workers = [...runningWorkers.values()];
  const taskIds = [...runningWorkers.keys()];
  runningWorkers.clear();
  await Promise.allSettled(workers.map(worker => worker.stop()));
  for (const task of db.tasks) {
    if (taskIds.includes(task.id) && task.status !== 'completed') {
      task.status = 'idle';
      task.lockExpiry = null;
      task.lastLog = '本机服务已停止，请核对官网状态后再启动';
    }
  }
  saveDB(db);
  for (const client of sseClients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`===============================================`);
  console.log(`⚡ SAT 监控调度系统已启动`);
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`💻 本机控制台: ${url}`);
  console.log('保持此窗口开启；按 Ctrl+C 停止服务和任务。无需安装浏览器插件。');
  console.log(`===============================================`);
  if (process.env.SAT_OPEN_BROWSER === '1' && process.platform === 'win32') {
    require('child_process').execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (err) => {
      if (err) console.log(`请手动打开：${url}`);
    });
  }
});
