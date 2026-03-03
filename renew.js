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

// --- 代理配置省略 (保持原样即可) ---
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

        // 核心更新：如果 JSON 里配置了 server_id，直接拼装 URL，绝对保密！
        if (account.server_id) {
            console.log(`>> 读取到专属 Server ID，开启安全直达模式...`);
            targetUrls.push(`${TARGET_URL}server/${account.server_id}`);
        } else {
            console.log(`>> 未配置 Server ID，将尝试在主页抓取...`);
            await page.goto(TARGET_URL);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(3000);
            if (page.url().includes('login')) { console.error(`>> ❌ Cookie失效`); continue; }
            const serverHrefs = await page.locator('a[href*="/server/"]').evaluateAll(elements => elements.map(el => el.href));
            targetUrls = [...new Set(serverHrefs)];
        }

        if (targetUrls.length === 0) {
            console.log(`>> ⚠️ 没找到服务器地址。`);
            await page.screenshot({ path: path.join(photoDir, `${accountId}_no_server_found.png`), fullPage: true });
            continue;
        }

        for (let sIdx = 0; sIdx < targetUrls.length; sIdx++) {
            const serverUrl = targetUrls[sIdx];
            const serverIdSnippet = serverUrl.split('/').pop(); 
            console.log(`\n>> 强行跳转至服务器: ${serverUrl.replace(serverIdSnippet, '********')}`); // 控制台日志也打码保护
            
            await page.goto(serverUrl);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(3000);

            if (page.url().includes('login')) {
                console.error(`>> ❌ Cookie失效，已退回登录页`);
                break; // 跳出当前服务器的循环
            }

            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`>> 正在寻找 [${RENEW_BTN_TEXT}]...`);
                const renewBtn = page.locator(`text=${RENEW_BTN_TEXT}`).first();
                
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                    await renewBtn.evaluate(node => node.style.border = '3px solid red');
                    await page.screenshot({ path: path.join(photoDir, `${accountId}_1_found_button.png`), fullPage: true });

                    console.log(`>> 点击续期按钮`);
                    await renewBtn.click();
                    await page.waitForTimeout(2000);

                    console.log(`>> 等待弹窗和 CF 盾...`);
                    await page.screenshot({ path: path.join(photoDir, `${accountId}_2_modal_opened.png`), fullPage: true });

                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 20; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        await page.waitForTimeout(1000);
                    }

                    if (cdpClickResult) await page.waitForTimeout(5000);

                    const frames = page.frames();
                    for (const f of frames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 1000 })) {
                                    console.log('>> ✅ CF 验证成功');
                                    await page.screenshot({ path: path.join(photoDir, `${accountId}_3_cf_success.png`), fullPage: true });
                                    break;
                                }
                            } catch (e) {}
                        }
                    }

                    const confirmBtn = page.locator(`button:has-text("${RENEW_BTN_TEXT}")`).last();
                    if (await confirmBtn.isVisible()) {
                        await confirmBtn.click();
                        await page.waitForTimeout(3000);
                        
                        if (await page.getByText(/You can't renew|아직 서버를 갱신할 수 없습니다/i).isVisible()) {
                            console.log(`>> ⏳ 还没到续期时间`);
                            const skipShot = path.join(photoDir, `${accountId}_4_skip_not_time.png`);
                            await page.screenshot({ path: skipShot, fullPage: true });
                            await sendTelegramMessage(`⏳ *暂无法续期*\n账号: ${accountId}`, skipShot);
                            break;
                        }

                        console.log('>> ✅ 续期指令已发送！');
                        const successShot = path.join(photoDir, `${accountId}_5_renew_success.png`);
                        await page.screenshot({ path: successShot, fullPage: true });
                        await sendTelegramMessage(`✅ *续期成功*\n账号: ${accountId}`, successShot);
                        break;
                    } else {
                        console.log('>> 未找到弹窗内的确认按钮，可能界面有变');
                        break;
                    }

                } catch (e) {
                    console.log(`>> 没找到续期按钮或报错: ${e.message}`);
                    await page.screenshot({ path: path.join(photoDir, `${accountId}_error_page.png`), fullPage: true });
                    break;
                }
            }
        }
    }

    console.log('全部结束。');
    await browser.close();
    process.exit(0);
})();
