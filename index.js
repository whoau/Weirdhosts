const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

const COOKIE_VALUE = process.env.COOKIE_VALUE;

chromium.use(stealth);

// 写入 MD 报告 (在 GitHub Actions 摘要页显示)
function writeToMd(status, message) {
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const md = `### 🟢 WeirdHost 续期报告\n- **状态**: ${status}\n- **信息**: ${message}\n- **时间**: ${time}\n`;
    
    fs.writeFileSync('result.md', md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    }
    console.log(`[Report] ${status}: ${message}`);
}

// 注入脚本：用于定位 CF 盾坐标
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

// 点击 CF 盾逻辑
async function clickTurnstile(page, context) {
    console.log('🛡️ 扫描并尝试点击 CF 盾...');
    for (let i = 0; i < 6; i++) {
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
        await page.waitForTimeout(600);
    }
    return false;
}

(async () => {
    // 1. 检查配置
    if (!COOKIE_VALUE) {
        writeToMd("失败", "Secrets 中未设置 COOKIE_VALUE");
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

    // 注入 Cookie
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
        
        // 0. 首页全屏盾处理 (Just a moment)
        if ((await page.title()).includes('Just a moment')) {
            console.log('🛡️ 检测到首页全屏盾，尝试通过...');
            await clickTurnstile(page, context);
            await page.waitForTimeout(3000);
        }

        // 1. 检查是否需要登录 (Cookie 失效)
        if (page.url().includes('login') || (await page.title()).toLowerCase().includes('login')) {
            await page.screenshot({ path: path.join(shotDir, 'error_login.png') });
            throw new Error("Cookie 已失效，跳转到了登录页");
        }

        // 2. 进入服务器详情
        const serverLink = page.locator('a[href*="/server/"]').first();
        if (await serverLink.count() > 0) {
            console.log('🖱️ 点击进入服务器...');
            await serverLink.click();
            await page.waitForLoadState('networkidle');
        } else {
            // 没找到服务器，截图留证
            await page.screenshot({ path: path.join(shotDir, 'error_no_server.png') });
            throw new Error("找不到服务器入口 (可能是列表为空或加载失败)");
        }

        // 缩放页面，防止截图截不全
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(1000);

        // 3. 寻找并点击续期按钮
        console.log('⚡ 寻找续期按钮 (시간 추가 / Renew)...');
        // 同时匹配韩文和英文
        const renewBtns = page.locator('button').filter({ hasText: /시간 추가|Renew|Extend/i });
        
        if (await renewBtns.count() > 0) {
            const btn = renewBtns.last();
            console.log('🖱️ 点击续期按钮...');
            await btn.click();
            
            // 等待模态框弹出
            try {
                await page.waitForSelector('.modal.show, .modal-open, [role="dialog"]', { timeout: 6000 });
                await page.waitForTimeout(1000);
            } catch (e) { console.log('⚠️ 模态框似乎未弹出'); }

            // ==========================================
            // 📸 截图 1: CF 盾出现 (Shield)
            // ==========================================
            console.log('📸 [1/3] 截图: CF 盾出现');
            await page.screenshot({ path: path.join(shotDir, '1_cf_shield.png') });

            // 处理 CF 盾
            console.log('🛡️ 尝试点击模态框内的 CF 盾...');
            await clickTurnstile(page, context);
            await page.waitForTimeout(2000);

            // 点击确认 (Confirm/확인)
            const confirmBtn = page.locator('.modal.show button, [role="dialog"] button')
                .filter({ hasText: /Confirm|확인|Yes|Renew/i }).last();
            
            if (await confirmBtn.isVisible()) {
                console.log('🖱️ 点击确认按钮...');
                await confirmBtn.click();
            }

            // ==========================================
            // 📸 截图 2: 结果反馈 (Result)
            // ==========================================
            console.log('⏳ 等待结果反馈...');
            await page.waitForTimeout(2000); // 等待 SweetAlert 或 Toast
            
            console.log('📸 [2/3] 截图: 续期结果');
            await page.screenshot({ path: path.join(shotDir, '2_result.png') });
            
            // 提取结果文字写入 MD
            let resText = "操作已提交";
            try {
                const text = await page.locator('.swal2-title, .alert, .toast-body').first().innerText({timeout: 1000});
                if (text) resText = text;
            } catch(e) {}
            writeToMd("执行完成", resText);

        } else {
            console.log('⚠️ 未找到续期按钮 (无需续期?)');
            writeToMd("跳过", "未找到续期按钮");
            // 没找到按钮也截一张图
            await page.screenshot({ path: path.join(shotDir, '2_no_button.png') });
        }

        // ==========================================
        // 📸 截图 3: 最终时间 (Time)
        // ==========================================
        console.log('🔄 刷新页面获取最新时间...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.body.style.zoom = '0.75');
        await page.waitForTimeout(1500);

        console.log('📸 [3/3] 截图: 最终时间');
        await page.screenshot({ path: path.join(shotDir, '3_time.png') });

    } catch (e) {
        console.error(e);
        writeToMd("出错", e.message);
        // 报错时截图
        await page.screenshot({ path: path.join(shotDir, 'error_final.png') }).catch(()=>{});
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
