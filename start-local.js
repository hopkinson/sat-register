const fs = require('fs');

try {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    throw new Error('请先安装 Node.js 18 或更新版本。');
  }
  require.resolve('express');
  const { chromium } = require('playwright');
  if (!fs.existsSync(chromium.executablePath())) {
    throw new Error('缺少浏览器，请在项目目录运行：npx playwright install chromium');
  }
  process.env.SAT_OPEN_BROWSER = '1';
  require('./server');
} catch (err) {
  console.error(`启动失败：${err.code === 'MODULE_NOT_FOUND' ? '缺少依赖，请在项目目录运行 npm install' : err.message}`);
  process.exit(1);
}
