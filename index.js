const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

const COOKIE_VALUE = process.env.COOKIE_VALUE;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

// TG 发送工具
async function sendTg(text, imgPath) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        console.log(`[TG] 发送: ${text}`);
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: text, parse_mode: 'Markdown'
        });
        if (imgPath && fs.existsSync(imgPath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`;
            await new Promise(resolve => exec(cmd, resolve));
        }
    } catch (e) { console.error('TG Error:', e.message); }
}

// 注入脚本：定位 Turnstile 坐标
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

// 点击 CF 盾的函数
async function clickTurnstile(page, context) {
    console.log('🛡️ 扫描 CF 盾...');
    for (let i = 0; i < 5; i++) {
        const frames = page.frames();
        for (const frame of frames) {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(()=>null);
            if (data) {
                const el = await frame.frameElement();
                const box = await el.boundingBox();
                if (box) {
                    const x = box.x + data.x;
                    const y = box.y + data.y;
                    console.log(`🖱️ 点击 CF 盾坐标: ${x.toFixed(0)}, ${y.toFixed(0)}`);
                    const s = await context.newCDPSession(page);
                    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 150));
                    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                    await s.detach();
                    return true;
                }
            }
        }
        await page.waitForTimeout(800);
    }
    return false;
}

(async () => {
    if (!COOKIE_VALUE) process.exit(1);

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    console.log('🚀 启动浏览器...');
    const browser = await chromium.launch({ headless: true });
    // 设置高分辨率视口
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1600, height: 1600 },
        deviceScaleFactor: 1
    });

    await context.addCookies([{
        name: 'pterodactyl_session',
        value: COOKIE_VALUE,
        domain: 'hub.weirdhost.xyz',
        path: '/',
        secure: true
    }, {
        name: 'laravel_session',
        value: COOKIE_VALUE,
        domain: 'hub.weirdhost.xyz',
        path: '/',
        secure: true
    }]);

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log('🔗 访问 Dashboard...');
        await page.goto('https://hub.weirdhost.xyz/', { waitUntil: 'domcontentloaded' });
        
        // 0. 首页全屏盾处理 (Just a moment) - 防止进不去
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 处理首页全屏盾...');
            await clickTurnstile(page, context);
            await page.waitForTimeout(3000);
        }

        // 进入服务器详情
        const serverLink = page.locator('a[href*="/server/"]').first();
        if (await serverLink.count() > 0) {
            console.log('🖱️ 进入服务器详情页...');
            await serverLink.click();
            await page.waitForLoadState('networkidle');
        }

        // 缩放页面
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(1000);

        // 寻找续期按钮 (韩文/英文)
        console.log('⚡ 寻找续期按钮...');
        const renewBtns = page.locator('button').filter({ hasText: /시간 추가|Renew|Extend/i });
        
        if (await renewBtns.count() > 0) {
            // 点击续期按钮，触发弹窗
            const btn = renewBtns.last();
            if (await btn.isVisible()) {
                console.log('🖱️ 点击续期按钮，等待弹窗...');
                await btn.click();
                
                // 等待模态框弹出 (里面包含 CF 盾)
                await page.waitForTimeout(3000);

                // ==========================================
                // 📸 截图 1: CF 盾出现 (弹窗已打开)
                // ==========================================
                console.log('📸 截图 1: CF 盾状态');
                const shot1 = path.join(shotDir, '1_cf_shield.png');
                await page.screenshot({ path: shot1 });
                await sendTg('1️⃣ CF 盾出现 (Verification Shield)', shot1);

                // 处理 CF 盾
                console.log('🛡️ 正在过盾...');
                await clickTurnstile(page, context);
                await page.waitForTimeout(2000);

                // 点击弹窗里的“确认”按钮 (如果有)
                const confirmBtn = page.locator('.modal.show button').filter({ hasText: /Confirm|확인|Yes|Renew/i }).last();
                if (await confirmBtn.isVisible()) {
                    console.log('🖱️ 点击确认按钮...');
                    await confirmBtn.click();
                    await page.waitForTimeout(2000);
                }

                // ==========================================
                // 📸 截图 2: 续期结果 (Success/Fail 弹窗)
                // ==========================================
                console.log('📸 截图 2: 续期结果');
                // 等待一下 SweetAlert 或 Toast 消息
                await page.waitForTimeout(1000);
                const shot2 = path.join(shotDir, '2_renew_result.png');
                await page.screenshot({ path: shot2 });
                await sendTg('2️⃣ 续期结果 (Result)', shot2);
            }
        } else {
            console.log('⚠️ 未找到续期按钮');
        }

        // ==========================================
        // 📸 截图 3: 剩余时间 (刷新页面后)
        // ==========================================
        console.log('🔄 刷新页面获取最新时间...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        
        // 再次缩放以截取全屏信息
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(1500);

        console.log('📸 截图 3: 剩余时间');
        const shot3 = path.join(shotDir, '3_time_remaining.png');
        await page.screenshot({ path: shot3 });
        await sendTg('3️⃣ 最终剩余时间 (Time Remaining)', shot3);

    } catch (e) {
        console.error(e);
        const errShot = path.join(shotDir, 'error.png');
        await page.screenshot({ path: errShot }).catch(()=>{});
        await sendTg(`❌ 出错: ${e.message}`, errShot);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
