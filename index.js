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

// 注入脚本
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

async function clickTurnstile(page, context) {
    console.log('🛡️ 尝试过盾...');
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
                    const s = await context.newCDPSession(page);
                    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await new Promise(r => setTimeout(r, 100));
                    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                    await s.detach();
                    return true;
                }
            }
        }
        await page.waitForTimeout(500);
    }
    return false;
}

(async () => {
    if (!COOKIE_VALUE) {
        console.error('❌ 未设置 Cookie');
        process.exit(1);
    }

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    console.log('🚀 启动浏览器...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1600, height: 1600 }
    });

    await context.addCookies([{
        name: 'pterodactyl_session', value: COOKIE_VALUE, domain: 'hub.weirdhost.xyz', path: '/', secure: true
    }, {
        name: 'laravel_session', value: COOKIE_VALUE, domain: 'hub.weirdhost.xyz', path: '/', secure: true
    }]);

    const page = await context.newPage();
    page.setDefaultTimeout(30000); // 30秒超时
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log('🔗 访问 Dashboard...');
        await page.goto('https://hub.weirdhost.xyz/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // 强制等待加载

        // --- 诊断 1: 检查是否还在 CF 盾页面 ---
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 遇到 CF 盾，尝试通过...');
            await clickTurnstile(page, context);
            await page.waitForTimeout(5000);
            
            // 再次检查
            if ((await page.title()).includes('Just a moment')) {
                throw new Error("❌ 无法绕过 Cloudflare 盾，脚本终止");
            }
        }

        // --- 诊断 2: 检查是否退回了登录页 ---
        if (page.url().includes('login') || (await page.title()).toLowerCase().includes('login')) {
            throw new Error("⚠️ Cookie 已失效 (跳转到了登录页)，请更新 Secrets!");
        }

        // --- 诊断 3: 截图当前页面看看是什么鬼样子 ---
        const debugShot = path.join(shotDir, 'debug_status.png');
        await page.screenshot({ path: debugShot });
        // console.log('📸 已保存当前页面截图，正在查找服务器入口...');

        // 尝试寻找服务器入口
        const serverLink = page.locator('a[href*="/server/"]').first();
        if (await serverLink.count() === 0) {
            // 如果找不到，发图给用户看
            await sendTg('❌ 找不到服务器入口，当前页面如下：', debugShot);
            throw new Error("找不到服务器入口 (详情见截图)");
        }

        console.log('✅ 找到服务器，点击进入...');
        await serverLink.click();
        await page.waitForLoadState('networkidle');

        // 缩放
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(2000);

        // --- 正常流程：找续期按钮 ---
        console.log('⚡ 寻找续期按钮...');
        const renewBtns = page.locator('button').filter({ hasText: /시간 추가|Renew|Extend/i });
        
        if (await renewBtns.count() > 0) {
            const btn = renewBtns.last();
            await btn.click();
            await page.waitForTimeout(2000);

            // 1. 截图：出盾
            const shot1 = path.join(shotDir, '1_shield.png');
            await page.screenshot({ path: shot1 });
            await sendTg('1️⃣ CF 盾出现', shot1);

            // 过盾
            await clickTurnstile(page, context);
            await page.waitForTimeout(2000);

            // 确认
            const confirmBtn = page.locator('.modal.show button').filter({ hasText: /Confirm|확인|Yes|Renew/i }).last();
            if (await confirmBtn.isVisible()) await confirmBtn.click();

            // 2. 截图：结果
            await page.waitForTimeout(2000);
            const shot2 = path.join(shotDir, '2_result.png');
            await page.screenshot({ path: shot2 });
            await sendTg('2️⃣ 续期结果', shot2);
        } else {
            console.log('⚠️ 未找到续期按钮');
        }

        // 3. 截图：时间
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.body.style.zoom = '0.75');
        const shot3 = path.join(shotDir, '3_time.png');
        await page.screenshot({ path: shot3 });
        await sendTg('3️⃣ 最终时间', shot3);

    } catch (e) {
        console.error(e);
        // 报错时，强制截一张当前的图，让你知道发生了什么
        const errShot = path.join(shotDir, 'final_error.png');
        await page.screenshot({ path: errShot, fullPage: true }).catch(()=>{});
        await sendTg(`❌ 运行出错: ${e.message}`, errShot);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
