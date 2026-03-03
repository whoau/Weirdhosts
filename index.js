/**
 * WeirdHost 自动续期脚本（GitHub Actions 版）
 *
 * 功能说明：
 *   1. 通过 Cookie 登录（无需账号密码）
 *   2. 自动点击韩文 "시간 추가"（添加时间）按钮进行续期
 *   3. 使用 CDP 绕过 Cloudflare Turnstile 人机验证
 *   4. 通过 Telegram 发送结果通知 + 截图
 *   5. 支持多账号批量续期
 *
 * 环境变量（GitHub Secrets）：
 *   USERS_JSON   - 用户 Cookie 列表（JSON 数组）
 *   HTTP_PROXY   - （可选）代理地址
 *   TG_BOT_TOKEN - （可选）Telegram Bot Token
 *   TG_CHAT_ID   - （可选）Telegram Chat ID
 *
 * WeirdHost 是韩国服务器托管平台，网站界面为韩文
 * 续期按钮文字："시간 추가" = "添加时间"
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// ==================== 配置区 ====================

const SITE_BASE_URL = 'https://hub.weirdhost.xyz';
const SITE_DOMAIN = 'hub.weirdhost.xyz';
const DASHBOARD_URL = SITE_BASE_URL;

// 韩文续期按钮文字："시간 추가" = "添加时间"
const RENEW_BUTTON_TEXT = '시간 추가';

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// 启用 stealth 插件（防检测）
chromium.use(stealth);

// ==================== 代理配置 ====================

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        };
        console.log(`[代理] 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效，期望：http://user:pass@host:port');
        process.exit(1);
    }
}

// ==================== 注入脚本 ====================
// 劫持 attachShadow 来捕获 Turnstile 验证码的 checkbox 坐标
// 这样就能通过 CDP 精确点击它

const INJECTED_SCRIPT = `
(function() {
    // 只在 iframe 中运行（Turnstile 验证码在 iframe 里）
    if (window.self === window.top) return;

    // 1. 伪装鼠标屏幕坐标（增加真实性）
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) {}

    // 2. Hook attachShadow，捕获 Turnstile checkbox 位置
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
                            // 计算 checkbox 中心点相对于视口的比例
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            // 存储到全局变量，供外部 Playwright 读取
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
    } catch (e) {}
})();
`;

// ==================== Telegram 通知 ====================

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    // 发送文字消息
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
        });
        console.log('[Telegram] 消息已发送。');
    } catch (e) {
        console.error('[Telegram] 消息发送失败:', e.message);
    }

    // 发送截图（如果有）
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise((resolve) => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] 图片发送失败:', err.message);
                else console.log('[Telegram] 图片已发送。');
                resolve();
            });
        });
    }
}

// ==================== 工具函数 ====================

// 验证代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    console.log('[代理] 正在验证连接...');
    try {
        const cfg = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: parseInt(new URL(PROXY_CONFIG.server).port),
            },
            timeout: 10000,
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            cfg.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', cfg);
        console.log('[代理] 连接成功！');
        return true;
    } catch (e) {
        console.error(`[代理] 连接失败: ${e.message}`);
        return false;
    }
}

// 检测 Chrome 调试端口是否开放
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

// 启动 Chrome 浏览器
async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已在运行。');
        return;
    }
    console.log(`正在启动 Chrome（路径: ${CHROME_PATH}）...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--window-size=1280,720',
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_weirdhost_data',
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('等待 Chrome 启动...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (!(await checkPort(DEBUG_PORT))) throw new Error('Chrome 启动失败');
    console.log('Chrome 启动完成。');
}

/**
 * 将浏览器 Cookie 字符串解析为 Playwright 格式的数组
 * 输入: "key1=val1; key2=val2; key3=val3"
 * 输出: [{ name: "key1", value: "val1", domain: "...", path: "/" }, ...]
 */
function parseCookieString(cookieStr, domain) {
    const cookies = [];
    const pairs = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;
        const name = pair.substring(0, eqIdx).trim();
        const value = pair.substring(eqIdx + 1).trim();
        if (!name) continue;
        cookies.push({ name, value, domain, path: '/' });
    }
    return cookies;
}

// 获取用户列表（优先环境变量，其次 login.json）
function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : parsed.users || [];
        }
    } catch (e) {
        console.error('USERS_JSON 解析错误:', e);
    }
    try {
        const data = fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8');
        const json = JSON.parse(data);
        return Array.isArray(json) ? json : json.users || [];
    } catch (e) {}
    return [];
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 生成安全文件名（支持韩文和中文字符）
function safeFilename(str) {
    return str.replace(/[^a-z0-9\u4e00-\u9fff\uac00-\ud7af]/gi, '_');
}

// ==================== Turnstile CDP 绕过核心逻辑 ====================

/**
 * 遍历页面所有 Frame，查找被注入脚本标记的 Turnstile 坐标，
 * 计算绝对屏幕坐标，并通过 CDP 发送原生鼠标点击事件
 */
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            // 检查此 Frame 是否捕获到了 Turnstile 数据
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 在 Frame 中发现 Turnstile，坐标比例:', data);

                // 获取 iframe 在主页面中的位置
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;

                // 计算绝对坐标：iframe左上角 + (iframe宽高 × 比例)
                const clickX = box.x + box.width * data.xRatio;
                const clickY = box.y + box.height * data.yRatio;
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                // 创建 CDP 会话发送原生鼠标事件
                const client = await page.context().newCDPSession(page);

                // 按下鼠标
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1,
                });

                // 模拟人类点击持续时间（50~150ms）
                await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

                // 释放鼠标
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1,
                });

                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) {
            // 忽略跨域 Frame 访问错误
        }
    }
    return false;
}

/**
 * 处理 Turnstile 验证：反复尝试查找并点击，然后等待成功标志
 * @param {Page} page - Playwright 页面对象
 * @param {number} maxFind - 最大查找次数
 */
async function handleTurnstile(page, maxFind = 30) {
    console.log(`   >> 正在查找 Turnstile（最多 ${maxFind} 次）...`);

    let cdpClicked = false;
    for (let i = 0; i < maxFind; i++) {
        cdpClicked = await attemptTurnstileCdp(page);
        if (cdpClicked) break;
        if ((i + 1) % 5 === 0) console.log(`   >> [${i + 1}/${maxFind}] 尚未找到 Turnstile...`);
        await page.waitForTimeout(1000);
    }

    let isSuccess = false;
    if (cdpClicked) {
        console.log('   >> CDP 点击完成，等待 8 秒验证...');
        await page.waitForTimeout(8000);

        // 检查 Cloudflare iframe 中是否出现 "Success!"
        for (const f of page.frames()) {
            if (f.url().includes('cloudflare')) {
                try {
                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                        console.log('   >> ✅ Turnstile 验证通过！');
                        isSuccess = true;
                        break;
                    }
                } catch (e) {}
            }
        }
    } else {
        console.log(`   >> ${maxFind} 次尝试后仍未找到 Turnstile。`);
    }

    return { cdpClicked, isSuccess };
}

// ==================== 主流程 ====================

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未找到用户。请设置 USERS_JSON 环境变量或创建 login.json');
        process.exit(1);
    }
    console.log(`共发现 ${users.length} 个用户。\n`);

    // 验证代理
    if (PROXY_CONFIG && !(await checkProxy())) {
        console.error('[代理] 代理无效，终止运行。');
        await sendTelegramMessage('❌ *代理连接失败*\n自动续期终止。');
        process.exit(1);
    }

    // 启动 Chrome
    await launchChrome();

    // 连接 Chrome
    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败，2秒后重试...`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    if (!browser) {
        console.error('Chrome 连接失败，退出。');
        await sendTelegramMessage('❌ *Chrome 连接失败*');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    // 代理认证
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    } else {
        await context.setHTTPCredentials(null);
    }

    // 注入 Hook 脚本
    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');
    ensureDir(SCREENSHOT_DIR);

    // ==================== 遍历每个用户 ====================

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const displayName = user.name || `用户_${i + 1}`;
        const safeName = safeFilename(displayName);

        console.log('\n' + '='.repeat(60));
        console.log(`  处理用户 ${i + 1}/${users.length}: ${displayName}`);
        console.log('='.repeat(60));

        // 检查 cookie 字段是否存在
        if (!user.cookie) {
            console.error('   >> ❌ 缺少 cookie 字段，跳过此用户。');
            await sendTelegramMessage(`❌ *缺少 Cookie*\n用户: \`${displayName}\``);
            continue;
        }

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // ========== 第一步：设置 Cookie 登录 ==========

            // 清除旧 Cookie（确保账号隔离）
            console.log('清除旧 Cookie...');
            await context.clearCookies();
            await page.waitForTimeout(500);

            // 解析并注入新 Cookie
            console.log('设置新 Cookie...');
            const cookies = parseCookieString(user.cookie, SITE_DOMAIN);
            if (cookies.length === 0) {
                console.error('   >> ❌ Cookie 解析失败（无有效键值对），跳过。');
                await sendTelegramMessage(`❌ *Cookie 解析失败*\n用户: \`${displayName}\``);
                continue;
            }
            console.log(`   >> 已加载 ${cookies.length} 个 Cookie: [${cookies.map(c => c.name).join(', ')}]`);
            await context.addCookies(cookies);

            // ========== 第二步：访问面板，验证登录状态 ==========

            console.log('正在访问面板...');
            await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // 如果被重定向到登录页 → Cookie 已过期
            const currentUrl = page.url();
            if (currentUrl.includes('/auth/login') || currentUrl.includes('/login')) {
                console.error('   >> ❌ Cookie 已过期或无效（被重定向到登录页）');

                const failShot = path.join(SCREENSHOT_DIR, `${safeName}_cookie_expired.png`);
                try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) {}

                await sendTelegramMessage(
                    `❌ *Cookie 已过期*\n用户: \`${displayName}\`\n请重新获取 Cookie 并更新 Secret`,
                    failShot
                );
                continue;
            }

            console.log('   >> ✅ Cookie 登录成功！当前URL:', currentUrl);

            // 截图：登录后的面板
            const dashShot = path.join(SCREENSHOT_DIR, `${safeName}_dashboard.png`);
            try { await page.screenshot({ path: dashShot, fullPage: true }); } catch (e) {}

            // ========== 第三步：找到并点击 "See"（查看详情）链接 ==========

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
                console.log('"See" 已点击，进入详情页。');
                await page.waitForTimeout(2000);
            } catch (e) {
                console.log('"See" 链接未找到，尝试在当前页面继续...');
                const noSeeShot = path.join(SCREENSHOT_DIR, `${safeName}_no_see.png`);
                try { await page.screenshot({ path: noSeeShot, fullPage: true }); } catch (e2) {}

                if (page.url().includes('/auth/')) {
                    await sendTelegramMessage(
                        `❌ *接入失败*\n用户: \`${displayName}\`\n原因: 未找到 See 按钮`,
                        noSeeShot
                    );
                    continue;
                }
            }

            // ========== 第四步：시간 추가（添加时间）续期循环 ==========
            // 最多重试 20 次（每次失败刷新页面重来）

            let renewSuccess = false;

            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[尝试 ${attempt}/20] 正在查找 "${RENEW_BUTTON_TEXT}"（시간 추가/添加时间）按钮...`);

                // 查找续期按钮（韩文："시간 추가"）
                const renewBtn = page.getByRole('button', { name: RENEW_BUTTON_TEXT, exact: true }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) {}

                if (!(await renewBtn.isVisible())) {
                    // 精确匹配失败，尝试模糊匹配
                    const partialBtn = page.getByRole('button', { name: RENEW_BUTTON_TEXT }).first();
                    try {
                        await partialBtn.waitFor({ state: 'visible', timeout: 3000 });
                        if (await partialBtn.isVisible()) {
                            await partialBtn.click();
                            console.log(`"${RENEW_BUTTON_TEXT}" 按钮（模糊匹配）已点击。`);
                        } else {
                            console.log(`未找到 "${RENEW_BUTTON_TEXT}" 按钮（可能已续期或页面异常）。`);
                            break;
                        }
                    } catch (e2) {
                        console.log(`未找到 "${RENEW_BUTTON_TEXT}" 按钮。`);
                        break;
                    }
                } else {
                    await renewBtn.click();
                    console.log(`"${RENEW_BUTTON_TEXT}" 按钮已点击，等待弹窗...`);
                }

                // 等待模态框出现
                let modal = page.locator('#renew-modal');
                try {
                    await modal.waitFor({ state: 'visible', timeout: 3000 });
                } catch (e) {
                    // 可能不是 #renew-modal，尝试其他选择器
                    modal = page.locator('.modal.show, .modal[style*="display: block"], [role="dialog"]').first();
                    try {
                        await modal.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e2) {
                        console.log('弹窗未出现，重试...');
                        continue;
                    }
                }
                console.log('弹窗已出现。');

                // A. 在弹窗区域移动鼠标（模拟真实操作）
                try {
                    const box = await modal.boundingBox();
                    if (box) {
                        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    }
                } catch (e) {}

                // B. 处理 Turnstile 人机验证
                const turnstileResult = await handleTurnstile(page, 30);

                // C. 截图（点击确认前）
                const tsShot = path.join(SCREENSHOT_DIR, `${safeName}_turnstile_${attempt}.png`);
                try { await page.screenshot({ path: tsShot, fullPage: true }); } catch (e) {}
                console.log(`   >> 📸 截图: ${path.basename(tsShot)}`);

                // D. 查找弹窗内的确认按钮
                let confirmBtn = modal.getByRole('button', { name: RENEW_BUTTON_TEXT });
                if (!(await confirmBtn.isVisible().catch(() => false))) {
                    // 尝试其他可能的确认按钮文字
                    for (const altText of ['Renew', 'Confirm', '확인', 'Submit', 'OK']) {
                        confirmBtn = modal.getByRole('button', { name: altText });
                        if (await confirmBtn.isVisible().catch(() => false)) break;
                    }
                }

                if (!(await confirmBtn.isVisible().catch(() => false))) {
                    console.log('   >> 弹窗内未找到确认按钮，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }

                // 无论 Turnstile 是否通过，都先点击确认（如果验证失败会被拦截，循环重试）
                console.log('   >> 点击确认按钮（无论 Turnstile 状态）...');
                await confirmBtn.click();

                // E. 检测结果（3秒内循环检测）
                const startVerify = Date.now();
                while (Date.now() - startVerify < 3000) {
                    // 情况1：验证码未完成
                    try {
                        if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                            console.log('   >> ⚠️ 错误："请完成验证码"');
                            hasCaptchaError = true;
                            break;
                        }
                    } catch (e) {}

                    // 情况2：还没到续期时间
                    try {
                        const notTimeLoc = page.getByText("You can't renew your server yet");
                        if (await notTimeLoc.isVisible()) {
                            const text = await notTimeLoc.innerText();
                            const match = text.match(/as of\s+(.*?)\s+\(/);
                            const dateStr = match ? match[1] : '未知';
                            console.log(`   >> ⏳ 暂时无法续期，下次可续期时间: ${dateStr}`);

                            const skipShot = path.join(SCREENSHOT_DIR, `${safeName}_skip.png`);
                            try { await page.screenshot({ path: skipShot, fullPage: true }); } catch (e) {}

                            await sendTelegramMessage(
                                `⏳ *暂时无法续期*\n用户: \`${displayName}\`\n下次可续期: ${dateStr}`,
                                skipShot
                            );

                            renewSuccess = true; // 标记为已处理，不再重试
                            try {
                                const closeBtn = modal.getByLabel('Close');
                                if (await closeBtn.isVisible()) await closeBtn.click();
                            } catch (e) {}
                            break;
                        }
                    } catch (e) {}

                    await page.waitForTimeout(200);
                }

                if (renewSuccess) break; // 不需要重试了

                if (hasCaptchaError) {
                    console.log('   >> 刷新页面重置 Turnstile...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue; // 重新开始循环
                }

                // F. 检查成功（弹窗消失 = 续期成功）
                await page.waitForTimeout(2000);
                if (!(await modal.isVisible().catch(() => true))) {
                    console.log('   >> ✅ 弹窗已关闭，续期成功！');

                    const successShot = path.join(SCREENSHOT_DIR, `${safeName}_success.png`);
                    try { await page.screenshot({ path: successShot, fullPage: true }); } catch (e) {}

                    await sendTelegramMessage(
                        `✅ *续期成功*\n用户: \`${displayName}\`\n状态: 服务器时间已添加！`,
                        successShot
                    );
                    renewSuccess = true;
                    break;
                } else {
                    console.log('   >> 弹窗仍然打开，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(3000);
                    continue;
                }
            } // end 续期循环

            // 20次都失败了
            if (!renewSuccess) {
                console.log('   >> ❌ 20 次尝试后仍未成功续期。');
                const failShot = path.join(SCREENSHOT_DIR, `${safeName}_renew_fail.png`);
                try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) {}

                await sendTelegramMessage(
                    `❌ *续期失败*\n用户: \`${displayName}\`\n原因: 20 次尝试后仍未成功`,
                    failShot
                );
            }

        } catch (err) {
            console.error('处理用户时出错:', err);
            const errShot = path.join(SCREENSHOT_DIR, `${safeName}_error.png`);
            try { await page.screenshot({ path: errShot, fullPage: true }); } catch (e) {}

            await sendTelegramMessage(
                `❌ *脚本异常*\n用户: \`${displayName}\`\n错误: ${err.message}`,
                errShot
            );
        }

        // 每个用户处理完后的最终截图
        const finalShot = path.join(SCREENSHOT_DIR, `${safeName}_final.png`);
        try { await page.screenshot({ path: finalShot, fullPage: true }); } catch (e) {}
        console.log(`用户 ${displayName} 处理完成。\n`);
    }

    console.log('\n所有用户处理完成。');
    await browser.close();
    process.exit(0);
})();
