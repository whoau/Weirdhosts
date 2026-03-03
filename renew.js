const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = "/usr/bin/google-chrome";
const USER_DATA_DIR = '/tmp/chrome_user_data';
const DEBUG_PORT = 9222;

// --- 你原始代码中的注入脚本 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

// 辅助函数：检测端口是否开放
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

// 核心功能：CDP 模拟点击 Turnstile
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    // 获取用户数据
    let users = [];
    try {
        users = JSON.parse(process.env.USERS_JSON || '[]');
    } catch (e) {
        console.error('USERS_JSON 解析失败');
        process.exit(1);
    }

    // 1. 启动原生 Chrome
    console.log('🚀 启动 Chrome...');
    const chrome = spawn(CHROME_PATH, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-address=0.0.0.0'
    ], { detached: true, stdio: 'ignore' });
    chrome.unref();

    // 2. 连接并等待初始化
    let browser;
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) {
            try {
                browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
                break;
            } catch (e) { }
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!browser) {
        console.error('❌ Chrome 连接失败');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        // 关键修复：防止因读取不到 username 导致的 replace 报错
        const currentName = user.username || user.user || `Account_${i}`;
        console.log(`\n=== 正在处理账户: ${currentName} ===`);

        try {
            // 注入 Cookie 实现登录
            if (user.cookies) {
                await context.addCookies(user.cookies.map(c => ({
                    ...c,
                    domain: 'hub.weirdhost.xyz'
                })));
                console.log('   >> Cookies 已注入');
            }

            await page.goto('https://hub.weirdhost.xyz/dashboard', { waitUntil: 'networkidle' });

            // 检查 Renew 按钮
            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            try { await renewBtn.waitFor({ state: 'visible', timeout: 10000 }); } catch (e) {}

            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                console.log('   >> 已点击 Renew 按钮');

                // 绕过 Turnstile
                let solved = false;
                for (let attempt = 0; attempt < 15; attempt++) {
                    solved = await attemptTurnstileCdp(page);
                    if (solved) {
                        console.log('   >> ✅ Turnstile 点击成功');
                        break;
                    }
                    await page.waitForTimeout(1000);
                }

                await page.waitForTimeout(3000);

                // 点击最终确认
                const confirmBtn = page.locator('#renew-modal button:has-text("Renew")');
                if (await confirmBtn.isVisible()) {
                    await confirmBtn.click();
                    console.log('   >> 最终确认已点击');
                    await page.waitForTimeout(4000);
                }
            } else {
                console.log('   >> 未发现 Renew 按钮（可能已续期或 Cookie 无效）');
            }
        } catch (err) {
            console.error(`   >> 处理出错: ${err.message}`);
        }
    }

    await browser.close();
    console.log('\n任务结束。');
    process.exit(0);
})();
