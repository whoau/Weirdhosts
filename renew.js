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
const RENEW_BTN_TEXT = '시간 추가'; // 韩国服务器续期文字

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- 代理配置 ---
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
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port');
        process.exit(1);
    }
}

// ================= 辅助功能 =================

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
        console.log('[Telegram] 文本消息已发送。');
    } catch (e) {
        console.error('[Telegram] 发送消息失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] 正在发送截图...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 发送图片失败:', err.message);
                else console.log('[Telegram] 图片已发送。');
                resolve();
            });
        });
    }
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: getRandomInt(800, 1200) });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: getRandomInt(400, 600) });
    } catch (e) { }

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
    } catch (e) { console.error('[注入] Hook attachShadow 失败:', e); }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log(`检查 Chrome 是否已在端口 ${DEBUG_PORT} 上运行...`);
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }
    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu',
        '--window-size=1280,720', '--no-sandbox', '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
}

// === 修改点：通过 Cookie 格式读取账号 ===
function getAccounts() {
    // 预期格式: [{"id": "user1", "cookies": [{"name":"session", "value":"xxx", "domain":".weirdhost.xyz", "path":"/"}]}]
    try {
        if (process.env.COOKIES_JSON) {
            const parsed = JSON.parse(process.env.COOKIES_JSON);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (e) {
        console.error('解析 COOKIES_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                
                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// ================= 主逻辑 =================

(async () => {
    const accounts = getAccounts();
    if (accounts.length === 0) {
        console.log('未在 process.env.COOKIES_JSON 中找到账号 Cookie');
        process.exit(1);
    }

    if (PROXY_CONFIG && !(await checkProxy())) {
        console.error('[代理] 代理无效，终止运行。');
        process.exit(1);
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const accountId = account.id || `account_${i+1}`;
        console.log(`\n=== 正在处理账号 ${i + 1}/${accounts.length} (${accountId}) ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // 清理上一个账号的会话并注入当前账号的 Cookie
            await context.clearCookies();
            if (account.cookies && account.cookies.length > 0) {
                await context.addCookies(account.cookies);
                console.log(`>> 已成功注入 Cookie`);
            } else {
                console.log(`>> ⚠️ 账号 ${accountId} 没有提供 Cookie 数据，跳过。`);
                continue;
            }

            // 前往目标站点仪表盘
            console.log(`>> 正在访问 ${TARGET_URL}...`);
            await page.goto(TARGET_URL);
            await page.waitForTimeout(3000);

            // 检查是否登录失败 (被弹回了 login 页面)
            if (page.url().includes('login')) {
                console.error(`>> ❌ 登录失败: Cookie 可能已过期 (${accountId})`);
                const failShotPath = path.join(photoDir, `${accountId}_cookie_expired.png`);
                try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                await sendTelegramMessage(`❌ *登录失败*\n账号: ${accountId}\n原因: Cookie 可能已失效，请重新提取`, failShotPath);
                continue;
            }

            // 如果存在类似 "See" 或者 "Manage" 服务器的中间步骤，这里做一个容错点击
            // 若页面直接展示 "시간 추가"，则此步会自动跳过
            try {
                // 如果网站有中间一层的服务器详情点击，可根据实际情况修改这段，例如找 "관리" (Manage) 等
                // await page.getByRole('link', { name: 'Manage' }).first().click(); 
                // await page.waitForTimeout(2000);
            } catch (e) { }

            let renewSuccess = false;
            
            // --- 尝试进行时间追加 (시간 추가) 循环 ---
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 [${RENEW_BTN_TEXT}] 按钮...`);

                // 模糊匹配包含 '시간 추가' 的按钮
                const renewBtn = page.getByRole('button', { name: new RegExp(RENEW_BTN_TEXT, 'i') }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log(`[${RENEW_BTN_TEXT}] 按钮已点击。等待模态框...`);

                    // 等待模态框，这里沿用原有的 selector 或者找对应的对话框
                    const modal = page.locator('.modal, #renew-modal, dialog').first(); // 增加了兼容性 class
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // 鼠标晃动增加真实度
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // --- 处理 Turnstile ---
                    console.log('正在检查 Turnstile (使用 CDP 绕过)...');
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        await page.waitForTimeout(1000);
                    }

                    if (cdpClickResult) {
                        console.log('   >> CDP 点击生效。等待 8秒 Cloudflare 检查...');
                        await page.waitForTimeout(8000);
                    } else {
                        console.log('   >> 重试后仍未确认 Turnstile 复选框。');
                    }

                    // 检查 Turnstile 成功标志
                    const frames = page.frames();
                    for (const f of frames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    console.log('   >> 在 Turnstile iframe 中检测到 "Success!"。');
                                    break;
                                }
                            } catch (e) { }
                        }
                    }

                    // 准备点击模态框内的确认按钮 (通常也是 "시간 추가" 或者是确认类的词)
                    // 由于不确定内部按钮具体文本，我们取模态框内可见的带有该文字的按钮，或者直接寻找主按钮
                    const confirmBtn = modal.getByRole('button', { name: new RegExp(RENEW_BTN_TEXT, 'i') }).first();
                    
                    if (await confirmBtn.isVisible()) {
                        const tsScreenshotName = `${accountId}_Turnstile_${attempt}.png`;
                        try { await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true }); } catch (e) { }

                        console.log(`   >> 点击模态框内的确认按钮...`);
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. 验证码错误检测
                                if (await page.getByText('Please complete the captcha', { exact: false }).isVisible()) {
                                    console.log('   >> ⚠️ 检测到验证码错误提示。');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. 时间限制错误检测 (可能不同于英文原版，添加了中文和常见英文的正则)
                                const notTimeLoc = page.getByText(/You can't renew|You will be able to as of|아직 서버를 갱신할 수 없습니다/i);
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    console.log(`   >> ⏳ 暂无法续期，服务器提示: ${text.substring(0, 50)}...`);

                                    const skipShotPath = path.join(photoDir, `${accountId}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n账号: ${accountId}\n原因: 还没到时间/限制触发`, skipShotPath);

                                    renewSuccess = true; 
                                    try {
                                        const closeBtn = modal.getByLabel('Close').or(modal.getByRole('button', {name: /close|닫기/i}));
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> 验证码错误。刷新页面重置 Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        // 验证是否成功关闭模态框
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ 模态框已关闭。续期成功！');
                            const successShotPath = path.join(photoDir, `${accountId}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }
                            await sendTelegramMessage(`✅ *续期成功*\n账号: ${accountId}\n状态: 服务器时间已成功增加 [${RENEW_BTN_TEXT}]！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无明确错误。重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的确认按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } else {
                    console.log(`未找到 [${RENEW_BTN_TEXT}] 按钮 (服务器可能已续期，或不在该页面)。`);
                    break;
                }
            }

        } catch (err) {
            console.error(`处理账号 ${accountId} 时发生异常:`, err);
        }

        // 保存当前账号最终状态快照
        const finalScreenshotPath = path.join(photoDir, `${accountId}_final.png`);
        try {
            await page.screenshot({ path: finalScreenshotPath, fullPage: true });
            console.log(`账号结束快照已保存: ${finalScreenshotPath}`);
        } catch (e) { }

        console.log(`账号 ${accountId} 处理完成\n`);
    }

    console.log('所有账号处理完成，正在退出。');
    await browser.close();
    process.exit(0);
})();
