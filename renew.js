const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

chromium.use(stealth);

// 配置常量
const TARGET_URL = 'https://hub.weirdhost.xyz/dashboard';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 注入脚本：用于捕获 Turnstile 复选框位置
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
                        if (rect.width > 0 && rect.height > 0) {
                            window.__turnstile_data = {
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                observer.observe(shadowRoot, { childList: true, subtree: true });
            }
            return shadowRoot;
        };
    } catch (e) {}
})();
`;

async function sendTelegram(msg, imgPath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown'
        });
        if (imgPath && fs.existsSync(imgPath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`;
            exec(cmd);
        }
    } catch (e) { console.error('[TG] Send failed'); }
}

async function attemptTurnstileClick(page) {
    for (const frame of page.frames()) {
        const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
        if (data) {
            const iframe = await frame.frameElement();
            const box = await iframe.boundingBox();
            if (box) {
                const client = await page.context().newCDPSession(page);
                const x = box.x + box.width * data.xRatio;
                const y = box.y + box.height * data.yRatio;
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        }
    }
    return false;
}

(async () => {
    // 获取环境变量中的 Cookie JSON
    const accounts = JSON.parse(process.env.ACCOUNTS_JSON || '[]');
    if (accounts.length === 0) process.exit(1);

    // 启动 Chrome
    const chrome = spawn(CHROME_PATH, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox', '--user-data-dir=/tmp/chrome_data'
    ]);
    await new Promise(r => setTimeout(r, 5000));

    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];

    for (const acc of accounts) {
        console.log(`\n>>> Processing: ${acc.user}`);
        const page = await context.newPage();
        await page.addInitScript(INJECTED_SCRIPT);
        
        // 1. 注入 Cookie
        await context.addCookies(acc.cookies.map(c => ({ ...c, domain: 'hub.weirdhost.xyz' })));
        
        try {
            await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
            
            // 2. 查找 Renew 按钮
            const renewBtn = page.locator('button:has-text("Renew")').first();
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                
                // 3. 处理 Turnstile
                let clicked = false;
                for (let i = 0; i < 10; i++) {
                    clicked = await attemptTurnstileClick(page);
                    if (clicked) break;
                    await page.waitForTimeout(2000);
                }

                // 4. 截图并点击确认
                const shotPath = `shot_${acc.user}.png`;
                await page.screenshot({ path: shotPath });
                
                const confirmBtn = page.locator('#renew-modal button:has-text("Renew")');
                await confirmBtn.click();
                await page.waitForTimeout(3000);

                // 5. 结果判断
                if (await page.getByText('Please complete the captcha').isVisible()) {
                    await sendTelegram(`❌ ${acc.user} 续期失败：验证码未通过`, shotPath);
                } else if (await page.getByText('successfully').isVisible() || !(await confirmBtn.isVisible())) {
                    await sendTelegram(`✅ ${acc.user} 续期成功`, shotPath);
                }
            } else {
                console.log('Renew button not found, maybe already renewed.');
            }
        } catch (e) { console.error(e); }
        await page.close();
    }
    await browser.close();
})();
