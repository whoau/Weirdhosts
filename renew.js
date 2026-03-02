const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- 环境变量 ---
const COOKIE_VALUE = process.env.COOKIE_VALUE;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 启用 Stealth 插件 (隐藏自动化特征)
chromium.use(stealth);

// --- 辅助函数：TG 发送 ---
async function sendTelegramMessage(text, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: text, parse_mode: 'Markdown'
        });
        if (imagePath && fs.existsSync(imagePath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
            await new Promise(resolve => exec(cmd, resolve));
        }
    } catch (e) { console.error('TG 发送失败:', e.message); }
}

// --- 注入脚本：用于检测 CF 盾位置 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const check = () => {
                    const cb = shadowRoot.querySelector('input[type="checkbox"]');
                    if (cb && cb.getBoundingClientRect().width > 0) {
                        const r = cb.getBoundingClientRect();
                        window.__turnstile_data = { x: r.left + r.width/2, y: r.top + r.height/2 };
                        return true;
                    }
                };
                if (!check()) {
                    new MutationObserver((_, obs) => { if(check()) obs.disconnect(); })
                        .observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {}
})();
`;

(async () => {
    if (!COOKIE_VALUE) {
        console.error('❌ 未设置 COOKIE_VALUE');
        process.exit(1);
    }

    console.log('🚀 启动浏览器...');
    const browser = await chromium.launch({ headless: true }); // GitHub Actions 推荐 headless
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });

    // 注入 Cookie
    await context.addCookies([{
        name: 'pterodactyl_session', // 面板标准 Cookie 名
        value: COOKIE_VALUE,
        domain: 'hub.weirdhost.xyz',
        path: '/',
        secure: true
    }]);

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    const photoDir = 'screenshots';
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir);

    try {
        console.log('🔗 正在访问 hub.weirdhost.xyz ...');
        await page.goto('https://hub.weirdhost.xyz/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // --- 1. 处理 Cloudflare ---
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 检测到 Cloudflare 盾，尝试绕过...');
            let cfPassed = false;
            
            for (let i = 0; i < 10; i++) {
                // 查找注入的坐标数据
                const frames = page.frames();
                for (const frame of frames) {
                    const data = await frame.evaluate(() => window.__turnstile_data).catch(()=>null);
                    if (data) {
                        // 使用 CDP 模拟真实点击
                        const session = await context.newCDPSession(page);
                        // 必须加上 frame 的偏移量 (这里简化处理，通常全屏模式下相对坐标即绝对坐标)
                        // 若 headless 模式下 frame.evaluate 返回的是视口坐标，直接点击即可
                        console.log(`🖱️ 点击 Turnstile: ${data.x}, ${data.y}`);
                        await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: data.x, y: data.y, button: 'left', clickCount: 1 });
                        await new Promise(r => setTimeout(r, 100));
                        await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: data.x, y: data.y, button: 'left', clickCount: 1 });
                        await session.detach();
                        break;
                    }
                }
                
                await page.waitForTimeout(2000);
                if (!(await page.title()).includes('Just a moment')) {
                    cfPassed = true;
                    break;
                }
            }
            
            const cfShot = `${photoDir}/1_cf_pass.png`;
            await page.screenshot({ path: cfShot });
            if (!cfPassed) throw new Error("无法绕过 CF 盾");
            await sendTelegramMessage("🛡️ Cloudflare 验证通过", cfShot);
        }

        // --- 2. 检查登录状态 ---
        await page.waitForTimeout(2000);
        if (page.url().includes('login')) {
            const loginShot = `${photoDir}/login_fail.png`;
            await page.screenshot({ path: loginShot });
            await sendTelegramMessage("⚠️ **Cookie 已失效**\n请更新 Secrets 中的 COOKIE_VALUE", loginShot);
            throw new Error("Cookie 失效");
        }

        // --- 3. 仪表盘截图 ---
        console.log('✅ 进入仪表盘');
        // 滚动到底部以展示所有服务器
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        const dashShot = `${photoDir}/2_dashboard.png`;
        await page.screenshot({ path: dashShot, fullPage: true });
        // 发送包含剩余时间的截图
        await sendTelegramMessage("📊 **当前状态** (请查看截图中的剩余时间)", dashShot);

        // --- 4. 执行续期 ---
        const renewBtns = page.getByRole('button', { name: 'Renew', exact: false });
        const count = await renewBtns.count();

        if (count === 0) {
            console.log('ℹ️ 未找到 Renew 按钮');
            await sendTelegramMessage("ℹ️ 未找到可续期的服务器 (可能尚未到期)");
        } else {
            console.log(`发现 ${count} 个服务器需要续期`);
            for (let i = 0; i < count; i++) {
                const btn = renewBtns.nth(i);
                if (await btn.isVisible()) {
                    await btn.click();
                    await page.waitForTimeout(2000); // 等待模态框

                    // 处理模态框内的确认
                    // 某些模态框内可能有 Turnstile，也可能有 Confirm 按钮
                    // 这里尝试盲点确认
                    const confirmBtn = page.locator('.modal.show, .modal-open').getByRole('button', { name: 'Renew', exact: false });
                    if (await confirmBtn.isVisible()) {
                        await confirmBtn.click();
                        console.log('已点击确认续期');
                        await page.waitForTimeout(3000);
                    }
                }
            }
            
            const resultShot = `${photoDir}/3_renew_result.png`;
            await page.screenshot({ path: resultShot, fullPage: true });
            await sendTelegramMessage("✅ **续期操作执行完毕**", resultShot);
        }

    } catch (e) {
        console.error('Error:', e);
        await sendTelegramMessage(`❌ **脚本错误**: ${e.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
