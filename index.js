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

// 写入 MD 报告
function writeToMd(status, message) {
    const md = `### 🟢 WeirdHost 续期报告\n- **状态**: ${status}\n- **信息**: ${message}\n- **时间**: ${new Date().toISOString()}`;
    fs.writeFileSync('result.md', md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

// 注入 CF 坐标定位脚本
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

// 点击 CF 盾
async function clickTurnstile(page, context) {
    console.log('🛡️ 扫描 CF 盾...');
    for (let i = 0; i < 8; i++) {
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
    page.setDefaultTimeout(60000);
    await page.addInitScript(INJECTED_SCRIPT);

    try {
        console.log('🔗 访问 Dashboard...');
        await page.goto('https://hub.weirdhost.xyz/', { waitUntil: 'domcontentloaded' });
        
        // 0. 首页全屏盾处理
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 处理首页全屏盾...');
            await clickTurnstile(page, context);
            await page.waitForTimeout(3000);
        }

        // 1. 点击服务器进入详情
        // Pterodactyl 面板的服务器链接通常包含 /server/
        console.log('🖱️ 寻找服务器入口...');
        const serverLink = page.locator('a[href*="/server/"]').first();
        if (await serverLink.count() > 0) {
            await serverLink.click();
            console.log('✅ 已点击服务器，等待加载...');
            await page.waitForLoadState('networkidle');
        } else {
            throw new Error("❌ 未找到服务器入口 (Cookie 可能失效或无服务器)");
        }

        // 缩放页面，防止截图截不全
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(2000);

        // 2. 寻找续期按钮 (시간 추가 / Renew)
        // 既然安装了字体，现在可以直接匹配韩文了
        console.log('⚡ 寻找续期按钮...');
        const renewBtns = page.locator('button').filter({ hasText: /시간 추가|Renew|Extend/i });
        
        if (await renewBtns.count() > 0) {
            const btn = renewBtns.last(); // 这是一个技巧，通常功能按钮在最后
            if (await btn.isVisible()) {
                console.log('🖱️ 点击续期按钮，触发弹窗...');
                await btn.click();
                
                // 等待模态框动画
                await page.waitForTimeout(2500);

                // ==========================================
                // 📸 截图 1: CF 盾出现 (Verification Shield)
                // ==========================================
                console.log('📸 截图 1: CF 盾出现');
                const shot1 = path.join(shotDir, '1_cf_shield.png');
                await page.screenshot({ path: shot1 });
                await sendTg('1️⃣ CF 盾出现 (Shield Check)', shot1);

                // 处理 CF 盾
                console.log('🛡️ 开始过盾...');
                await clickTurnstile(page, context);
                await page.waitForTimeout(2000);

                // 点击模态框里的确认按钮 (如果有)
                // 韩文确认: 확인, 英文: Confirm/Renew
                const confirmBtn = page.locator('.modal.show button').filter({ hasText: /확인|Confirm|Yes|Renew/i }).last();
                if (await confirmBtn.isVisible()) {
                    console.log('🖱️ 点击确认按钮...');
                    await confirmBtn.click();
                }

                // ==========================================
                // 📸 截图 2: 续期结果 (Success/Result)
                // ==========================================
                console.log('⏳ 等待结果提示...');
                await page.waitForTimeout(1500); // 等待 SweetAlert 弹窗
                console.log('📸 截图 2: 续期结果');
                const shot2 = path.join(shotDir, '2_result.png');
                await page.screenshot({ path: shot2 });
                
                // 尝试读取结果文本写入 MD
                let resText = "操作已执行";
                try {
                    const alertText = await page.locator('.swal2-title, .alert, .toast-body').first().innerText({timeout: 1000});
                    if (alertText) resText = alertText;
                } catch(e) {}
                
                writeToMd("执行完成", resText);
                await sendTg(`2️⃣ 续期结果: ${resText}`, shot2);

            }
        } else {
            console.log('⚠️ 未找到续期按钮 (可能无需续期)');
            writeToMd("跳过", "未找到续期按钮");
        }

        // ==========================================
        // 📸 截图 3: 剩余时间 (Time Remaining)
        // ==========================================
        console.log('🔄 刷新页面获取最新时间...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(2000);

        console.log('📸 截图 3: 最终时间');
        const shot3 = path.join(shotDir, '3_time.png');
        await page.screenshot({ path: shot3 });
        await sendTg('3️⃣ 最终剩余时间', shot3);

    } catch (e) {
        console.error(e);
        writeToMd("出错", e.message);
        const errShot = path.join(shotDir, 'error.png');
        await page.screenshot({ path: errShot }).catch(()=>{});
        await sendTg(`❌ 脚本出错: ${e.message}`, errShot);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
