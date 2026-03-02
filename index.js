const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

// 环境变量
const COOKIE_VALUE = process.env.COOKIE_VALUE;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

// TG 发送工具
async function sendTg(text, imgPath) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        console.log(`[TG] ${text}`);
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: text, parse_mode: 'Markdown'
        });
        if (imgPath && fs.existsSync(imgPath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imgPath}"`;
            await new Promise(resolve => exec(cmd, resolve));
        }
    } catch (e) { console.error('TG Error:', e.message); }
}

// 注入脚本：用于 CF 盾坐标定位
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
        console.error('❌ 请配置 COOKIE_VALUE');
        process.exit(1);
    }

    const shotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });

    console.log('🚀 启动浏览器...');
    const browser = await chromium.launch({ headless: true });
    // 设置较大分辨率确保内容可见
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1400, height: 1200 }
    });

    // 注入 Cookie
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
        
        // --- 1. Cloudflare 过盾处理 ---
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 正在尝试绕过 CF 盾...');
            for (let i = 0; i < 15; i++) {
                // 遍历所有 Frame 寻找 Turnstile
                for (const frame of page.frames()) {
                    const data = await frame.evaluate(() => window.__turnstile_data).catch(()=>null);
                    if (data) {
                        const box = await (await frame.frameElement()).boundingBox();
                        if (box) {
                            const x = box.x + data.x;
                            const y = box.y + data.y;
                            const s = await context.newCDPSession(page);
                            await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                            await new Promise(r => setTimeout(r, 100));
                            await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                            await s.detach();
                            break;
                        }
                    }
                }
                await page.waitForTimeout(2000);
                if (!(await page.title()).includes('Just a moment')) break;
            }
        }

        // 验证 CF 是否通过
        const cfShot = path.join(shotDir, '1_cf_pass.png');
        await page.screenshot({ path: cfShot });
        if ((await page.title()).includes('Just a moment')) {
            await sendTg('❌ CF 验证失败', cfShot);
            throw new Error('CF Failed');
        }

        // --- 2. 检查登录状态 ---
        await page.waitForTimeout(3000);
        if (page.url().includes('login')) {
            const logShot = path.join(shotDir, 'login_fail.png');
            await page.screenshot({ path: logShot });
            await sendTg('⚠️ Cookie 已失效 (Login Failed)', logShot);
            throw new Error('Cookie Expired');
        }

        console.log('✅ 登录成功，等待页面加载...');
        await page.waitForLoadState('networkidle');

        // 缩小页面，防止截图不全
        await page.evaluate(() => document.body.style.zoom = '0.7');
        await page.waitForTimeout(1000);

        // --- 3. 寻找并点击 "시간 추가" (增加时间) ---
        // 你的截图显示按钮文字是 "시간 추가"
        console.log('🔍 正在寻找韩文续期按钮: 시간 추가 ...');
        
        // 截图当前界面（含剩余时间）
        const dashShot = path.join(shotDir, '2_dashboard_kr.png');
        await page.screenshot({ path: dashShot });
        await sendTg('📅 当前面板状态 (查看剩余时间)', dashShot);

        // 定位包含 "시간 추가" 的元素
        const renewBtns = page.getByText('시간 추가');
        const count = await renewBtns.count();

        if (count > 0) {
            console.log(`⚡ 发现 ${count} 个续期按钮`);
            
            // 遍历点击（防止有多个服务器）
            for (let i = 0; i < count; i++) {
                const btn = renewBtns.nth(i);
                if (await btn.isVisible()) {
                    console.log(`🖱️ 点击第 ${i+1} 个按钮...`);
                    await btn.click();
                    
                    // 等待弹窗或反应
                    await page.waitForTimeout(2000);

                    // --- 4. 处理确认弹窗 (如果有) ---
                    // 韩文确认通常是 "확인" (Confirm) 或 "연장" (Extend) 或 "Yes"
                    // 我们尝试点击模态框里的确认按钮
                    const modalBtn = page.locator('.modal.show button, .modal-open button')
                        .filter({ hasText: /확인|연장|Confirm|Yes/i }).first();
                    
                    if (await modalBtn.isVisible()) {
                        console.log('✅ 点击确认/확인');
                        await modalBtn.click();
                        await page.waitForTimeout(3000);
                    }
                }
            }

            // --- 5. 截图结果 ---
            const resultShot = path.join(shotDir, '3_renew_result.png');
            await page.screenshot({ path: resultShot });
            await sendTg('✅ 韩文续期操作完成', resultShot);

        } else {
            // 如果没找到按钮，可能是因为需要先点进服务器详情
            console.log('⚠️ 首页未找到按钮，尝试点击进入服务器详情...');
            
            // 尝试点击第一个类似服务器卡片的元素或链接
            const serverLink = page.locator('a[href*="/server/"]').first();
            if (await serverLink.count() > 0) {
                await serverLink.click();
                await page.waitForTimeout(3000);
                
                // 在详情页再次寻找 "시간 추가"
                const innerBtn = page.getByText('시간 추가').first();
                if (await innerBtn.isVisible()) {
                    await innerBtn.click();
                    await page.waitForTimeout(2000);
                    // 再次尝试确认
                    const modalBtn = page.locator('.modal.show button').filter({ hasText: /확인|연장/i }).first();
                    if (await modalBtn.isVisible()) await modalBtn.click();
                    
                    const innerResultShot = path.join(shotDir, '3_inner_renew.png');
                    await page.screenshot({ path: innerResultShot });
                    await sendTg('✅ (详情页) 续期完成', innerResultShot);
                } else {
                    console.log('详情页也没找到按钮');
                    await sendTg('ℹ️ 未找到可续期按钮 (无需续期?)');
                }
            } else {
                console.log('未找到服务器链接');
                await sendTg('ℹ️ 未找到服务器或按钮');
            }
        }

    } catch (e) {
        console.error(e);
        const errShot = path.join(shotDir, 'error.png');
        await page.screenshot({ path: errShot }).catch(()=>{});
        await sendTg(`❌ 脚本出错: ${e.message}`, errShot);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
