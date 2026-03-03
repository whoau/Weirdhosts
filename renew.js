const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// ================= 环境与配置 =================
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TARGET_URL = 'https://hub.weirdhost.xyz/';
const RENEW_BTN_TEXT = '시간 추가'; 

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- 代理配置省略 ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
    } catch (e) { process.exit(1); }
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try { await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }); } catch (e) {}
    if (imagePath && fs.existsSync(imagePath)) {
        await new Promise(resolve => exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`, resolve));
    }
}

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
                            window.__turnstile_data = { xRatio: (rect.left + rect.width / 2) / window.innerWidth, yRatio: (rect.top + rect.height / 2) / window.innerHeight };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

function getAccounts() {
    try {
        if (process.env.COOKIES_JSON) {
            const parsed = JSON.parse(process.env.COOKIES_JSON);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (e) { }
    return [];
}

async function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

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
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const accounts = getAccounts();
    if (accounts.length === 0) process.exit(1);

    if (!await checkPort(DEBUG_PORT)) {
        const args = [
            `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
            '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox', '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
        ];
        if (PROXY_CONFIG) { args.push(`--proxy-server=${PROXY_CONFIG.server}`); args.push('--proxy-bypass-list=<-loopback>'); }
        const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
        chrome.unref();
        for (let i = 0; i < 20; i++) {
            if (await checkPort(DEBUG_PORT)) break;
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    let browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const accountId = account.id || `account_${i+1}`;
        console.log(`\n=== 开始处理账号: ${accountId} ===`);

        await context.clearCookies();
        if (account.cookies) await context.addCookies(account.cookies);

        let targetUrls = [];

        if (account.server_id) {
            targetUrls.push(`${TARGET_URL}server/${account.server_id}`);
        } else {
            console.log(`>> 未配置 Server ID，将尝试在主页抓取...`);
            await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000);
            if (page.url().includes('login')) { console.error(`>> ❌ Cookie失效`); continue; }
            const serverHrefs = await page.locator('a[href*="/server/"]').evaluateAll(elements => elements.map(el => el.href));
            targetUrls = [...new Set(serverHrefs)];
        }

        if (targetUrls.length === 0) {
            console.log(`>> ⚠️ 没找到服务器地址。`);
            continue;
        }

        for (let sIdx = 0; sIdx < targetUrls.length; sIdx++) {
            const serverUrl = targetUrls[sIdx];
            const serverIdSnippet = serverUrl.split('/').pop(); 
            console.log(`\n>> 强行跳转至服务器: ${serverUrl.replace(serverIdSnippet, '********')}`); 
            
            await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(5000); // 等待左侧菜单和CF渲染

            if (page.url().includes('login')) {
                console.error(`>> ❌ Cookie失效，已退回登录页`);
                break; 
            }

            // 1. 直接破解页面左侧的 CF 盾
            console.log(`>> 正在破解左侧栏的 CF Turnstile...`);
            let cdpClickResult = false;
            for (let findAttempt = 0; findAttempt < 20; findAttempt++) {
                cdpClickResult = await attemptTurnstileCdp(page);
                if (cdpClickResult) break;
                await page.waitForTimeout(1000);
            }

            if (cdpClickResult) {
                console.log(`>> 已点击 CF，等待验证结果...`);
            } else {
                console.log(`>> 未找到需要点击的 CF 框，可能已自动通过或不存在。`);
            }

            // 2. 严密监控 CF 的 "成功" 标志 (支持英文、中文、韩文)
            let cfSuccess = false;
            for (let wait = 0; wait < 15; wait++) {
                const frames = page.frames();
                for (const f of frames) {
                    if (f.url().includes('cloudflare')) {
                        try {
                            // 根据你截图里的中文 "成功!" 或者英文 "Success" 匹配
                            if (await f.getByText(/Success!|成功|성공/i).isVisible({ timeout: 500 })) {
                                cfSuccess = true;
                                break;
                            }
                        } catch (e) {}
                    }
                }
                if (cfSuccess) break;
                await page.waitForTimeout(1000);
            }

            // 【关键点 1】：CF 成功截图！
            if (cfSuccess) {
                console.log('>> ✅ CF 验证成功！正在截图...');
                const cfShotPath = path.join(photoDir, `${accountId}_1_cf_success.png`);
                await page.screenshot({ path: cfShotPath, fullPage: true });
                // 如果需要把这步也发到TG，可以取消下面注释
                // await sendTelegramMessage(`✅ *CF 盾已通过*\n账号: ${accountId}`, cfShotPath);
            } else {
                console.log('>> ⚠️ 未明确检测到 CF 成功提示，继续尝试下一步...');
            }

            // 3. 点击续期按钮
            console.log(`>> 寻找续期按钮 [${RENEW_BTN_TEXT}]...`);
            try {
                // 不再找弹窗，直接在当前页面找这个按钮并点击
                const renewBtn = page.locator(`text=${RENEW_BTN_TEXT}`).first();
                await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                await renewBtn.click();
                console.log(`>> 已点击续期按钮，等待服务器响应...`);
                
                // 给服务器几秒钟处理续期请求和刷新页面数据
                await page.waitForTimeout(4000);

                // 4. 判断成功与否
                if (await page.getByText(/You can't renew|아직 서버를 갱신할 수 없습니다/i).isVisible()) {
                    console.log(`>> ⏳ 还没到续期时间`);
                    const skipShot = path.join(photoDir, `${accountId}_2_skip_not_time.png`);
                    await page.screenshot({ path: skipShot, fullPage: true });
                    await sendTelegramMessage(`⏳ *暂无法续期*\n账号: ${accountId}`, skipShot);
                } else {
                    console.log('>> ✅ 续期完成！');
                    // 【关键点 2】：最终续期成功截图！
                    const successShot = path.join(photoDir, `${accountId}_2_renew_success.png`);
                    await page.screenshot({ path: successShot, fullPage: true });
                    await sendTelegramMessage(`✅ *续期成功*\n账号: ${accountId}`, successShot);
                }
            } catch (e) {
                console.log(`>> 没找到续期按钮或执行报错: ${e.message}`);
                await page.screenshot({ path: path.join(photoDir, `${accountId}_error_page.png`), fullPage: true });
            }
        }
    }

    console.log('全部结束。');
    await browser.close();
    process.exit(0);
})();
