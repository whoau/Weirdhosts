#!/usr/bin/env node
/**
 * Weirdhost 自动续期 - JavaScript + Playwright Stealth 版本
 * 核心逻辑：通过对比前后"到期时间"来判断是否成功。
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

// 使用 stealth 插件
chromium.use(stealth);

// ==================== 配置 ====================
const BASE_URL = "https://hub.weirdhost.xyz";
const LOGIN_URL = `${BASE_URL}/auth/login`;

// 环境变量
const COOKIE_REMEMBER = (process.env.REMEMBER_WEB_COOKIE || '').trim();
const COOKIE_SESSION = (process.env.PTERODACTYL_SESSION || '').trim();
const EMAIL = (process.env.WEIRDHOST_EMAIL || '').trim();
const PASSWORD = (process.env.WEIRDHOST_PASSWORD || '').trim();
const SERVER_URLS_STR = (process.env.WEIRDHOST_SERVER_URLS || '').trim();

// 设置为 true 为无头模式(服务器用)，false 为显示浏览器(本地调试用)
const HEADLESS = (process.env.HEADLESS || 'false').toLowerCase() === 'true';
const SCREENSHOT_DIR = "screenshots";

// ==================== 工具函数 ====================
function getBjTime() {
  const now = new Date();
  const bjOffset = 8 * 60 * 60 * 1000; // 北京时间 offset
  const bjTime = new Date(now.getTime() + bjOffset);
  return bjTime.toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg, level = "INFO") {
  const icons = {
    INFO: "ℹ️",
    SUCCESS: "✅",
    WARNING: "⚠️",
    ERROR: "❌",
    DEBUG: "🔍"
  };
  const icon = icons[level] || "";
  console.log(`[${getBjTime()}] ${icon} [${level}] ${msg}`);
}

async function captureScreenshot(page, step, serverId) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    const timestamp = Date.now();
    const filename = `${serverId}_${step}_${timestamp}.png`;
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
    log(`截图已保存: ${filename}`, "DEBUG");
  } catch (e) {
    // ignore
  }
}

function clearScreenshotDir() {
  try {
    if (fs.existsSync(SCREENSHOT_DIR)) {
      for (const file of fs.readdirSync(SCREENSHOT_DIR)) {
        fs.unlinkSync(path.join(SCREENSHOT_DIR, file));
      }
    } else {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  } catch (e) {
    // ignore
  }
}

// ==================== 主逻辑 ====================
class RenewBot {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initBrowser() {
    log(`启动浏览器 (Headless: ${HEADLESS})...`);
    this.browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled"
      ]
    });
    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(60000);
  }

  async checkCf() {
    try {
      const title = await this.page.title();
      if (title && title.includes("Just a moment")) {
        log("检测到 CF 盾，尝试等待...", "WARNING");
        await new Promise(r => setTimeout(r, 5000));
        // 尝试点击复选框
        const frames = this.page.frames();
        for (const frame of frames) {
          try {
            const checkbox = frame.locator("input[type='checkbox']").first();
            if (await checkbox.isVisible()) {
              await checkbox.click();
            }
          } catch (e) {
            // ignore
          }
        }
        // 等待 CF 盾消失
        await new Promise(r => setTimeout(r, 3000));
        const newTitle = await this.page.title();
        return !newTitle.includes("Just a moment");
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  async login() {
    // 1. Cookie 登录
    if (COOKIE_REMEMBER) {
      log("尝试 Cookie 登录...", "INFO");
      const cookies = [
        {
          name: 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d',
          value: COOKIE_REMEMBER,
          domain: 'hub.weirdhost.xyz',
          path: '/'
        }
      ];
      if (COOKIE_SESSION) {
        cookies.push({
          name: 'pterodactyl_session',
          value: COOKIE_SESSION,
          domain: 'hub.weirdhost.xyz',
          path: '/'
        });
      }

      try {
        await this.page.context().addCookies(cookies);
        await this.page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
        if (!this.page.url().includes('/auth/login')) {
          log("Cookie 登录成功", "SUCCESS");
          return true;
        }
      } catch (e) {
        // ignore
      }
    }

    // 2. 账号密码登录
    if (EMAIL && PASSWORD) {
      log("尝试账号密码登录...", "INFO");
      try {
        await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        const cfResolved = await this.checkCf();
        if (cfResolved) {
          await captureScreenshot(this.page, "cf-success", "login");
        }
        await this.page.fill("input[name='username'], input[name='email']", EMAIL);
        await this.page.fill("input[name='password']", PASSWORD);
        await this.page.click("button[type='submit']");
        await this.page.waitForLoadState("networkidle");
        if (!this.page.url().includes('/auth/login')) {
          log("账号密码登录成功", "SUCCESS");
          return true;
        }
      } catch (e) {
        log(`登录失败: ${e}`, "ERROR");
      }
    }
    return false;
  }

  async getExpiryTime() {
    try {
      // 获取页面所有文本
      const text = await this.page.locator("body").innerText();
      // 正则匹配日期格式：202X-XX-XX XX:XX:XX
      // 例如：유통기한 2026-02-16 09:35:54
      const match = text.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/);
      if (match) {
        const dateStr = match[1];
        // 解析为 Date 对象
        const dt = new Date(dateStr.replace(' ', 'T'));
        return dt;
      }
    } catch (e) {
      log(`获取时间失败: ${e}`, "DEBUG");
    }
    return null;
  }

  async processServer(url) {
    const serverId = url.trim().replace(/\/$/, '').split('/').pop();
    log(`--- 处理: ${serverId} ---`, "INFO");

    try {
      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      const cfResolved = await this.checkCf();
      if (cfResolved) {
        await captureScreenshot(this.page, "cf-success", serverId);
      }

      if (this.page.url().includes('/auth/login')) {
        await captureScreenshot(this.page, "final-offline", serverId);
        return { id: serverId, status: "❌ 掉线", msg: "需登录" };
      }

      // 步骤 1: 获取【续期前】的时间
      const oldTime = await this.getExpiryTime();
      await captureScreenshot(this.page, "expiry-read", serverId);

      if (oldTime) {
        log(`当前到期时间: ${oldTime.toISOString().replace('T', ' ').substring(0, 19)}`, "INFO");
      } else {
        log("⚠️ 未能提取到当前时间，将盲跑...", "WARNING");
      }

      // 步骤 2: 查找并点击续期按钮
      let btn = null;
      const buttonTexts = ["시간 추가", "시간추가", "Renew", "Extend"];
      for (const txt of buttonTexts) {
        const loc = this.page.locator(`button:has-text('${txt}')`);
        const count = await loc.count();
        if (count > 0 && await loc.first().isVisible()) {
          btn = loc.first();
          break;
        }
      }

      if (!btn) {
        await captureScreenshot(this.page, "final-no-button", serverId);
        return { id: serverId, status: "❌ 无按钮", msg: "Button Not Found" };
      }

      log("点击【续期】...", "INFO");
      try {
        await btn.click();
      } catch (e) {
        await btn.click({ force: true });
      }

      // 步骤 3: 等待 10 秒 (过盾/处理)
      log("等待 10 秒 (等待系统处理)...", "WARNING");
      await new Promise(r => setTimeout(r, 10000));

      // 尝试点击可能存在的确认按钮
      try {
        const confirm = this.page.locator("button.swal2-confirm, button:has-text('확인')").first();
        if (await confirm.isVisible()) {
          log("检测到确认弹窗，顺手点一下...", "DEBUG");
          await confirm.click();
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        // ignore
      }

      // 步骤 4: 刷新页面并获取【续期后】的时间
      log("刷新页面检查结果...", "INFO");
      try {
        await this.page.reload({ waitUntil: 'networkidle' });
        await this.checkCf();
      } catch (e) {
        // ignore
      }

      const newTime = await this.getExpiryTime();

      if (newTime) {
        log(`最新到期时间: ${newTime.toISOString().replace('T', ' ').substring(0, 19)}`, "INFO");
      } else {
        // 如果刷新后拿不到时间，可能是网页挂了
        await captureScreenshot(this.page, "final-unknown", serverId);
        return { id: serverId, status: "❓ 未知", msg: "Time read fail" };
      }

      // 步骤 5: 对比时间判断结果
      if (oldTime && newTime) {
        if (newTime > oldTime) {
          log("✅ 时间已增加！续期成功", "SUCCESS");
          const newTimeStr = newTime.toISOString().replace('T', ' ').substring(0, 19);
          await captureScreenshot(this.page, "final-success", serverId);
          return { id: serverId, status: "✅ 成功", msg: `-> ${newTimeStr}` };
        } else if (newTime.getTime() === oldTime.getTime()) {
          log("⏳ 时间未变化 (可能是冷却中)", "WARNING");
          await captureScreenshot(this.page, "final-cooldown", serverId);
          return { id: serverId, status: "⏳ 冷却中", msg: "Time No Change" };
        } else {
          await captureScreenshot(this.page, "final-anomaly", serverId);
          return { id: serverId, status: "⚠️ 异常", msg: "Time Decreased?" };
        }
      }

      // 如果没有旧时间做对比，只能返回成功(盲)
      const currentTimeStr = newTime.toISOString().replace('T', ' ').substring(0, 19);
      await captureScreenshot(this.page, "final-blind", serverId);
      return { id: serverId, status: "❓ 完成", msg: `Current: ${currentTimeStr}` };

    } catch (e) {
      log(`出错: ${e}`, "ERROR");
      await captureScreenshot(this.page, "final-error", serverId);
      return { id: serverId, status: "💥 出错", msg: String(e).substring(0, 20) };
    }
  }

  updateReadme(results) {
    const bjTime = getBjTime();
    let content = `# Weirdhost 续期报告\n> 更新: \`${bjTime}\`\n\n| ID | 状态 | 说明 |\n|---|---|---|\n`;
    for (const r of results) {
      content += `| ${r.id} | ${r.status} | ${r.msg} |\n`;
    }
    try {
      fs.writeFileSync("README.md", content, "utf-8");
    } catch (e) {
      // ignore
    }
  }

  async run() {
    if (!SERVER_URLS_STR) {
      log("未配置 SERVER_URLS", "ERROR");
      process.exit(1);
    }
    const urls = SERVER_URLS_STR.split(',').map(u => u.trim()).filter(u => u);

    clearScreenshotDir();

    await this.initBrowser();
    const loginSuccess = await this.login();
    if (!loginSuccess) {
      log("登录失败", "ERROR");
      await this.browser.close();
      process.exit(1);
    }

    const results = [];
    for (const url of urls) {
      results.push(await this.processServer(url));
      await new Promise(r => setTimeout(r, 3000));
    }

    await this.browser.close();
    this.updateReadme(results);
  }
}

// ==================== 入口 ====================
new RenewBot().run().catch(e => {
  log(`Fatal error: ${e}`, "ERROR");
  process.exit(1);
});
