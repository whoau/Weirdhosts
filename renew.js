const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

chromium.use(stealth);

// --- 配置参数 ---
const TARGET_URL = 'https://hub.weirdhost.xyz/dashboard';
const DEBUG_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

/**
 * 注入脚本：在页面所有 Frame 中运行，监听 Turnstile 复选框
 */
const INJECTED_SCRIPT = `
(function() {
    const findCheckbox = () => {
        // 尝试在所有 Shadow Root 中查找
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            if (el.shadowRoot) {
                const cb = el.shadowRoot.querySelector('input[type="checkbox"]');
                if (cb) {
                    const rect = cb.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        window.__turnstile_data = {
                            xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                            yRatio: (rect.top + rect.height / 2) / window.innerHeight
                        };
                        return true;
                    }
                }
            }
        }
        return false;
    };
    setInterval(findCheckbox, 1000);
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
    } catch (e) { console.error('[TG] Failed to send notification'); }
}

async function solveTurnstile(page) {
    console.log('   >> 正在探测 Turnstile 验证码...');
    for (let i = 0; i < 20; i++) {
        const frames = page.frames();
        for (const frame of frames) {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                try {
                    const iframe = await frame.frameElement();
                    const box = await iframe.boundingBox();
                    if (box) {
                        const x = box.x + box.width * data.xRatio;
                        const y = box.y + box.height * data.yRatio;
                        const client = await page.context().newCDPSession(page);
                        // CDP 原生模拟点击
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 100));
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                        await client.detach();
                        console.log(`   >> ✅ 坐标点击成功: (${x.toFixed(0)}, ${y.toFixed(0)})`);
                        return true;
                    }
                } catch (e) {}
            }
        }
        await page.waitForTimeout(1500);
    }
    return false;
}

(async () => {
    let accounts = [];
    try {
        accounts = JSON.parse(process.env.USERS_JSON || '[]');
    } catch (e) {
        console.error('❌ USERS_JSON 解析错误');
        process.exit(1);
    }

    if (accounts.length === 0) {
        console.log('⚠️ 没有发现待处理的账户');
        process.exit(0);
    }

    // --- 启动并连接 Chrome ---
    let chromePath;
    try {
        chromePath = execSync('which google-chrome').toString().trim();
    } catch (e) {
        chromePath = '/usr/bin/google-chrome'; // 备用路径
    }
    
    console.log(`🚀 启动 Chrome: ${chromePath}`);
    const chrome = spawn(chromePath, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data',
        '--window-size=1280,720',
        '--remote-debugging-address=0.0.0.0' // 关键：允许连接
    ], { stdio: 'ignore', detached: true });
    chrome.unref();

    let browser;
    for (let i = 0; i < 15; i++) {
        try {
            // 关键：强制 127.0.0.1 避免 IPv6 解析错误
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
            console.log('✅ 成功连接到 Chrome 调试端口');
            break;
        } catch (e) {
            console.log(`⏳ 等待 Chrome 初始化 (${i+1}/15)...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('❌ 无法连接到 Chrome，程序退出');
        process.exit(1);
    }

    const context = browser.contexts()[0];

    for (const acc of accounts) {
        const safeName = acc.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n--- 账户处理中: ${acc.username} ---`);
        
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        await page.addInitScript(INJECTED_SCRIPT);

        try {
            // 1. 注入 Cookie (必须设置 domain)
            if (acc.cookies && Array.isArray(acc.cookies)) {
                await context.addCookies(acc.cookies.map(c => ({
                    ...c,
                    domain: 'hub.weirdhost.xyz'
                })));
                console.log('   >> Cookies 注入成功');
            }

            await page.goto(TARGET_URL, { waitUntil: 'networkidle' });

            // 检查是否跳转回登录页
            if (page.url().includes('/login')) {
                console.log('   >> ❌ Cookie 已失效，无法登录');
                continue;
            }

            // 2. 查找 Renew 按钮
            const renewBtn = page.locator('button:has-text("Renew")').first();
            try {
                await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
            } catch (e) {}

            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                console.log('   >> 已点击 Renew 按钮，等待模态框...');

                // 3. 处理 Turnstile 验证码
                const solved = await solveTurnstile(page);
                if (!solved) console.log('   >> ⚠️ 未探测到验证码或点击失败，尝试直接确认...');

                await page.waitForTimeout(3000);
                const preShot = path.join(SCREENSHOT_DIR, `${safeName}_modal.png`);
                await page.screenshot({ path: preShot });

                // 4. 点击最终确认 Renew
                const confirmBtn = page.locator('#renew-modal button:has-text("Renew")');
                if (await confirmBtn.isVisible()) {
                    await confirmBtn.click();
                    console.log('   >> 最终确认按钮已点击');
                    
                    await page.waitForTimeout(5000);
                    const finalShot = path.join(SCREENSHOT_DIR, `${safeName}_result.png`);
                    await page.screenshot({ path: finalShot, fullPage: true });

                    // 判断结果
                    const successMsg = page.getByText('successfully');
                    if (await successMsg.isVisible()) {
                        await notify(`✅ *${acc.username}* 续期成功！`, finalShot);
                    } else {
                        await notify(`❓ *${acc.username}* 续期动作已完成，请检查截图确认结果`, finalShot);
                    }
                }
            } else {
                console.log('   >> ℹ️ 未发现 Renew 按钮（可能已经续期过）');
            }
        } catch (err) {
            console.error(`   >> ❌ 发生错误: ${err.message}`);
        } finally {
            await page.close();
        }
    }

    await browser.close();
    console.log('\n所有任务处理完毕。');
    process.exit(0);
})();
