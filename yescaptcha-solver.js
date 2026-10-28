// YesCaptcha 验证码解算模块
const YESCAPTCHA_HOST = 'https://api.yescaptcha.com';

async function getBalance(clientKey) {
  try {
    const res = await fetch(`${YESCAPTCHA_HOST}/getBalance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey })
    });
    return await res.json();
  } catch (err) {
    return { errorId: 1, errorDescription: err.message };
  }
}

async function solveFunCaptcha({ clientKey, websiteURL, websitePublicKey }) {
  console.log(`[YesCaptcha] 正在提交 Arkose / FunCaptcha 打码任务...`);
  
  // 1. 创建任务
  const createRes = await fetch(`${YESCAPTCHA_HOST}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey,
      task: {
        type: 'FunCaptchaTaskProxyLess',
        websiteURL: websiteURL || 'https://satreg.collegeboard.org/register/testCenterSearch',
        websitePublicKey: websitePublicKey || 'B7D8911C-5CC8-A9A3-35B0-554ACEE604DA'
      }
    })
  });

  const createData = await createRes.json();
  if (createData.errorId !== 0) {
    throw new Error(`创建打码任务失败: ${createData.errorDescription || createData.errorCode}`);
  }

  const taskId = createData.taskId;
  console.log(`[YesCaptcha] 任务创建成功, taskId: ${taskId}, 正在等待解算...`);

  // 2. 轮询结果 (最多等 60 秒)
  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    await new Promise(r => setTimeout(r, 3000));
    
    const resultRes = await fetch(`${YESCAPTCHA_HOST}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId })
    });

    const resultData = await resultRes.json();
    if (resultData.status === 'ready') {
      console.log(`[YesCaptcha] 🎉 验证码解算成功！`);
      return resultData.solution.token;
    } else if (resultData.status === 'processing') {
      console.log(`[YesCaptcha] 正在运算识别中...`);
    } else {
      throw new Error(`打码失败: ${resultData.errorDescription || '未知错误'}`);
    }
  }

  throw new Error('打码超时 (超过 60 秒)');
}

// 官网报名确认页用的是 hCaptcha（不是 Arkose），需要单独的任务类型与返回值字段。
async function solveHCaptcha({ clientKey, websiteURL, websiteKey }) {
  if (!websiteKey) throw new Error('缺少 hCaptcha sitekey');
  const createRes = await fetch(`${YESCAPTCHA_HOST}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey,
      task: { type: 'HCaptchaTaskProxyless', websiteURL, websiteKey }
    })
  });
  const createData = await createRes.json();
  if (createData.errorId !== 0) {
    throw new Error(`创建 hCaptcha 任务失败: ${createData.errorDescription || createData.errorCode}`);
  }
  const taskId = createData.taskId;
  const startTime = Date.now();
  while (Date.now() - startTime < 90000) {
    await new Promise(r => setTimeout(r, 3000));
    const resultRes = await fetch(`${YESCAPTCHA_HOST}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId })
    });
    const resultData = await resultRes.json();
    if (resultData.status === 'ready') {
      return resultData.solution.gRecaptchaResponse || resultData.solution.token;
    }
    if (resultData.status !== 'processing') {
      throw new Error(`hCaptcha 打码失败: ${resultData.errorDescription || '未知错误'}`);
    }
  }
  throw new Error('hCaptcha 打码超时 (超过 90 秒)');
}

module.exports = {
  getBalance,
  solveFunCaptcha,
  solveHCaptcha
};
