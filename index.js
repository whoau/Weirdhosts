const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

// --- 环境变量 ---
// 直接填 Cookie 的值，不要 Key
const COOKIE_VALUE = process.env.COOKIE_VALUE; 
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

// --- 辅助：发送 TG 消息和图片 ---
async function sendTg(text, imgPath) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        console.log(`[TG] 发送消息: ${text}`);
        // 发文字
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: text, parse_mode: 'Markdown'
        });
        // 发图片 (使用 curl 上传，最稳定)
        if (imgPath && fs.existsSync(imgPath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`;
            await new Promise(resolve => exec(cmd, resolve));
        }
    } catch (e) { console.error('[TG] 发送失败:', e.message); }
}

// --- 注入脚本：用于定位 Turnstile 坐标 ---
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
                        // 计算相对于视口的坐标
                        window.__turnstile_data = { 
                            x: r.left + r.width/2, 
                            y: r.top + r.height/2 
                        };
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
    // 1. 检查 Cookie
    if (!COOKIE_VALUE) {
        console.error('❌ 请在 Secrets 中设置 COOKIE_VALUE');
        process.exit(1);
    }

    // 2. 准备截图目录
    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    // 3. 启动浏览器
    console.log('🚀 启动浏览器...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });

    // 4. 注入 Cookie
    // WeirdHost 的 Session Cookie 通常叫 'pterodactyl_session' 或 'laravel_session'
    // 这里我们两个都试一下，确保兼容
    await context.addCookies([
        {
            name: 'pterodactyl_session', 
            value: COOKIE_VALUE,
            domain: 'hub.weirdhost.xyz',
            path: '/',
            secure: true
        },
        {
            name: 'laravel_session', //以此防备不同的面板配置
            value: COOKIE_VALUE,
            domain: 'hub.weirdhost.xyz',
            path: '/',
            secure: true
        }
    ]);

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log('🔗 访问网站...');
        await page.goto('https://hub.weirdhost.xyz/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // --- 阶段一：处理 Cloudflare ---
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 遇到 CF 盾，尝试突破...');
            
            for (let i = 0; i < 15; i++) {
                // 寻找注入的坐标
                let clicked = false;
                for (const frame of page.frames()) {
                    const data = await frame.evaluate(() => window.__turnstile_data).catch(()=>null);
                    if (data) {
                        const iframeEl = await frame.frameElement();
                        const box = await iframeEl.boundingBox();
                        if (box) {
                            // 转换坐标：iframe位置 + 内部相对位置
                            const x = box.x + data.x;
                            const y = box.y + data.y;
                            
                            const session = await context.newCDPSession(page);
                            await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                            await new Promise(r => setTimeout(r, 100)); // 模拟按压时间
                            await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                            await session.detach();
                            console.log(`🖱️ 已点击 Turnstile (${x}, ${y})`);
                            clicked = true;
                            break;
                        }
                    }
                }

                await page.waitForTimeout(2000);
                // 检查是否通过
                if (!(await page.title()).includes('Just a moment')) {
                    console.log('✅ CF 盾已通过');
                    break;
                }
            }
        }

        // --- 截图1：CF 通过后的状态 ---
        const cfShot = path.join(shotDir, '1_cf_passed.png');
        await page.screenshot({ path: cfShot });
        // 如果还在 CF 页面，说明失败
        if ((await page.title()).includes('Just a moment')) {
            await sendTg('❌ 无法绕过 Cloudflare 盾', cfShot);
            throw new Error('CF Bypass Failed');
        } else {
            await sendTg('🛡️ Cloudflare 验证通过', cfShot);
        }

        // --- 阶段二：检查登录 ---
        await page.waitForTimeout(2000);
        if (page.url().includes('login')) {
            const loginShot = path.join(shotDir, 'error_login.png');
            await page.screenshot({ path: loginShot });
            await sendTg('⚠️ Cookie 已失效，请更新 Secrets', loginShot);
            throw new Error('Cookie Expired');
        }

        // --- 阶段三：仪表盘截图 (包含时间) ---
        console.log('📊 进入仪表盘，截取剩余时间...');
        // 滚动到底部确保服务器卡片加载
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
        
        const dashShot = path.join(shotDir, '2_dashboard_time.png');
        await page.screenshot({ path: dashShot, fullPage: true });
        await sendTg('📅 当前服务器状态 (见图)', dashShot);

        // --- 阶段四：执行续期 ---
        const renewBtns = page.getByRole('button', { name: 'Renew', exact: false });
        const count = await renewBtns.count();

        if (count === 0) {
            console.log('ℹ️ 没有发现需要续期的按钮');
            await sendTg('ℹ️ 无需续期');
        } else {
            console.log(`⚡ 发现 ${count} 个续期按钮`);
            for (let i = 0; i < count; i++) {
                const btn = renewBtns.nth(i);
                if (await btn.isVisible()) {
                    await btn.click();
                    await page.waitForTimeout(2000); // 等待弹窗

                    // 处理弹窗确认
                    const modalBtn = page.locator('.modal.show, .modal-open').getByRole('button', { name: 'Renew', exact: false });
                    if (await modalBtn.isVisible()) {
                        await modalBtn.click();
                        console.log('✅ 点击确认续期');
                        await page.waitForTimeout(3000); // 等待请求完成
                    }
                }
            }
            
            // --- 截图3：续期结果 ---
            const resultShot = path.join(shotDir, '3_renew_result.png');
            await page.screenshot({ path: resultShot, fullPage: true });
            await sendTg('✅ 续期操作完成', resultShot);
        }

    } catch (e) {
        console.error('运行错误:', e);
        const errShot = path.join(shotDir, '99_error.png');
        await page.screenshot({ path: errShot }).catch(()=>{});
        await sendTg(`❌ 脚本出错: ${e.message}`, errShot);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
