const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

chromium.use(stealth);

// 配置区
const TARGET_URL = 'https://hub.weirdhost.xyz/dashboard';
const DEBUG_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// --- 坐标劫持脚本 ---
const INJECTED_SCRIPT = `
(function() {
    setInterval(() => {
        const iframes = document.querySelectorAll('iframe[src*="cloudflare"]');
        for (const frame of iframes) {
            const shadowRoot = frame.contentDocument || frame.contentWindow?.document;
            if (!shadowRoot) continue;
            const cb = shadowRoot.querySelector('input[type="checkbox"]');
            if (cb && !window.__turnstile_data) {
                const rect = cb.getBoundingClientRect();
                window.__turnstile_data = {
                    xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                    yRatio: (rect.top + rect.height / 2) / window.innerHeight
                };
            }
        }
    }, 500);
})();
`;

async function notify(msg, imgPath = null) {
    console.log(`[Notification] ${msg}`);
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' });
        if (imgPath && fs.existsSync(imgPath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`;
            execSync(cmd);
        }
    } catch (e) { console.error('[TG] Failed to notify'); }
}

async function solveTurnstile(page) {
    console.log('   >> 正在尝试寻找 Turnstile 坐标...');
    for (let i = 0; i < 15; i++) {
        const frames = page.frames();
        for (const frame of frames) {
            const data = await frame.evaluate(() => {
                const cb = document.querySelector('input[type="checkbox"]');
                if (cb) {
                    const rect = cb.getBoundingClientRect();
                    return {
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight
                    };
                }
                return null;
            }).catch(() => null);

            if (data) {
                const iframe = await frame.frameElement();
                const box = await iframe.boundingBox();
                if (box) {
                    const x = box.x + box.width * data.xRatio;
                    const y = box.y + box.height * data.yRatio;
                    const client = await page.context().newCDPSession(page);
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 100));
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                    await client.detach();
                    console.log(`   >> 成功触发模拟点击: (${x}, ${y})`);
                    return true;
                }
            }
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

(async () => {
    let accounts;
    try {
        // 兼容你之前的 USERS_JSON 命名
        accounts = JSON.parse(process.env.USERS_JSON || '[]');
    } catch (e) {
        console.error('USERS_JSON 解析失败');
        process.exit(1);
    }

    // 启动原生 Chrome
    const chromePath = execSync('which google-chrome').toString().trim();
    const chrome = spawn(chromePath, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data'
    ]);

    await new Promise(r => setTimeout(r, 5000));

    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];

    for (const acc of accounts) {
        const safeName = acc.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 账户: ${acc.username} ===`);
        
        const page = await context.newPage();
        await page.addInitScript(INJECTED_SCRIPT);

        try {
            // 1. 注入 Cookie
            if (acc.cookies) {
                await context.addCookies(acc.cookies.map(c => ({
                    ...c,
                    domain: 'hub.weirdhost.xyz'
                })));
            }

            await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

            // 检查是否登录成功（WeirdHost 如果没登录会跳回 /login）
            if (page.url().includes('/login')) {
                console.error('   >> Cookie 失效，无法进入 Dashboard');
                continue;
            }

            // 2. 查找 Renew 按钮 (WeirdHost 逻辑)
            const renewBtn = page.locator('button:has-text("Renew")').first();
            if (await renewBtn.isVisible({ timeout: 10000 })) {
                await renewBtn.click();
                console.log('   >> 已点击 Renew，等待弹出框...');

                await page.waitForTimeout(2000);
                
                // 3. 处理验证码
                await solveTurnstile(page);
                await page.waitForTimeout(5000); // 等待验证状态同步

                const shotPath = path.join(SCREENSHOT_DIR, `${safeName}_before_confirm.png`);
                await page.screenshot({ path: shotPath, fullPage: true });

                // 4. 点击模态框内的最终 Renew 确认
                const confirmBtn = page.locator('#renew-modal button:has-text("Renew")');
                if (await confirmBtn.isVisible()) {
                    await confirmBtn.click();
                    console.log('   >> 点击了最终确认按钮');
                    
                    await page.waitForTimeout(3000);
                    const finalShot = path.join(SCREENSHOT_DIR, `${safeName}_final.png`);
                    await page.screenshot({ path: finalShot });

                    if (await page.getByText('successfully').isVisible()) {
                        await notify(`✅ ${acc.username} 续期成功`, finalShot);
                    } else {
                        await notify(`⚠️ ${acc.username} 续期操作完成，请检查截图确认结果`, finalShot);
                    }
                }
            } else {
                console.log('   >> 未找到 Renew 按钮，可能已续期');
            }
        } catch (e) {
            console.error(`   >> 处理失败: ${e.message}`);
        } finally {
            await page.close();
        }
    }

    await browser.close();
    process.exit(0);
})();
