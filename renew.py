#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - 完美修复版
流程：点击续期 -> 等待10秒(过盾) -> 点击确认 -> 判定韩语结果
"""

import os
import sys
import time
import re
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

# ==================== 配置常量 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 环境变量读取
COOKIE_REMEMBER = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
COOKIE_SESSION = os.getenv('PTERODACTYL_SESSION', '').strip()
EMAIL = os.getenv('WEIRDHOST_EMAIL', '').strip()
PASSWORD = os.getenv('WEIRDHOST_PASSWORD', '').strip()
SERVER_URLS_STR = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()

# 设置为 True 为无头模式(服务器用)，False 为显示浏览器(本地调试用)
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
SCREENSHOT_DIR = "screenshots"

class RenewBot:
    def __init__(self):
        self.browser = None
        self.context = None
        self.page = None

    def log(self, msg, level="INFO"):
        bj_time = datetime.now(timezone(timedelta(hours=8))).strftime('%H:%M:%S')
        icon = {"INFO": "ℹ️", "SUCCESS": "✅", "WARNING": "⚠️", "ERROR": "❌", "DEBUG": "🔍"}.get(level, "")
        print(f"[{bj_time}] {icon} [{level}] {msg}")

    def save_debug(self, name):
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            self.page.screenshot(path=f"{SCREENSHOT_DIR}/{name}.png", full_page=True)
        except: pass

    def init_browser(self, p):
        self.log(f"启动浏览器 (Headless: {HEADLESS})...")
        self.browser = p.chromium.launch(
            headless=HEADLESS, 
            # 添加参数隐藏自动化特征，防止被 CF 秒杀
            args=[
                "--no-sandbox", 
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars"
            ]
        )
        self.context = self.browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR"
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(60000)
        
        # 注入 JS 进一步隐藏 webdriver 属性
        self.page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
        """)

    def check_cf(self):
        """检测并尝试通过 Cloudflare 盾"""
        try:
            title = self.page.title()
            if "Just a moment" in title or "Cloudflare" in title:
                self.log("检测到 Cloudflare 验证页，尝试通过...", "WARNING")
                time.sleep(5)
                
                # 尝试点击 iframe 里的复选框
                frames = self.page.frames
                for frame in frames:
                    if "challenges" in frame.url or "turnstile" in frame.url:
                        try:
                            box = frame.locator("input[type='checkbox']").first
                            if box.is_visible():
                                box.click()
                                self.log("点击了 CF 验证框", "INFO")
                        except: pass
                
                # 等待页面跳转
                try:
                    self.page.wait_for_url(lambda u: "auth" in u or "server" in u, timeout=10000)
                    self.log("Cloudflare 验证可能已通过", "SUCCESS")
                except: pass
        except: pass

    def is_logged_in(self):
        if "/auth/login" in self.page.url: return False
        try:
            # 检查是否有登出按钮，如果有说明已登录
            if self.page.locator("a[href*='/auth/logout']").count() > 0: return True
        except: pass
        return True

    def login(self):
        # 1. 优先使用 Cookie 登录 (推荐)
        if COOKIE_REMEMBER:
            self.log("尝试 Cookie 登录 (跳过 CF)...", "INFO")
            cookies = [{'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d', 'value': COOKIE_REMEMBER, 'domain': 'hub.weirdhost.xyz', 'path': '/'}]
            if COOKIE_SESSION:
                cookies.append({'name': 'pterodactyl_session', 'value': COOKIE_SESSION, 'domain': 'hub.weirdhost.xyz', 'path': '/'})
            self.context.add_cookies(cookies)
            try:
                self.page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
                if self.is_logged_in():
                    self.log("Cookie 登录成功", "SUCCESS")
                    return True
            except: pass

        # 2. 账号密码登录 (容易被 CF 拦截)
        if EMAIL and PASSWORD:
            self.log("尝试账号密码登录...", "INFO")
            try:
                self.page.goto(LOGIN_URL, wait_until="domcontentloaded")
                self.check_cf()
                self.page.fill("input[name='username'], input[name='email']", EMAIL)
                self.page.fill("input[name='password']", PASSWORD)
                self.page.click("button[type='submit']")
                self.page.wait_for_load_state("networkidle")
                self.check_cf()
                if self.is_logged_in():
                    self.log("账号密码登录成功", "SUCCESS")
                    return True
            except Exception as e:
                self.log(f"登录失败: {e}", "ERROR")
        return False

    def process_server(self, url):
        server_id = url.strip('/').split("/")[-1]
        self.log(f"--- 处理: {server_id} ---", "INFO")
        
        try:
            self.page.goto(url, wait_until="networkidle", timeout=60000)
            
            # 进页面后检查一次 CF
            self.check_cf()
            
            if "/auth/login" in self.page.url:
                return {"id": server_id, "status": "❌ 掉线", "msg": "Login Lost"}

            # -------------------------------------------------
            # 1. 寻找【时间追加】按钮
            # -------------------------------------------------
            btn = None
            # 按钮可能的文本 (韩文优先)
            target_texts = ["시간 추가", "시간추가", "Renew", "Extend"]
            for txt in target_texts:
                loc = self.page.locator(f"button:has-text('{txt}')")
                if loc.count() > 0:
                    for i in range(loc.count()):
                        # 确保按钮是可见且可点击的
                        if loc.nth(i).is_visible() and loc.nth(i).is_enabled():
                            btn = loc.nth(i)
                            self.log(f"找到续期按钮: {txt}", "INFO")
                            break
                if btn: break
            
            if not btn:
                self.save_debug(f"no_btn_{server_id}")
                return {"id": server_id, "status": "❌ 无按钮", "msg": "Button Not Found"}

            # -------------------------------------------------
            # 2. 点击按钮 & 等待 10 秒 (关键步骤)
            # -------------------------------------------------
            self.log("点击【续期】...", "INFO")
            btn.click()

            self.log("等待 10 秒 (等待 CF 盾自动验证)...", "WARNING")
            time.sleep(10)

            # 10秒后，为了保险，检查弹窗里是否有没过的 CF 勾选框
            try:
                frames = self.page.frames
                for frame in frames:
                    if "challenges" in frame.url or "turnstile" in frame.url:
                        box = frame.locator("input[type='checkbox']").first
                        if box.is_visible():
                            self.log("CF 盾未自动通过，手动点击...", "DEBUG")
                            box.click()
                            time.sleep(2)
            except: pass

            # -------------------------------------------------
            # 3. 点击【确认】按钮 (SweetAlert2)
            # -------------------------------------------------
            confirm_btn = self.page.locator("button.swal2-confirm:visible")
            
            if confirm_btn.count() > 0:
                self.log("点击【确认】...", "INFO")
                # 尝试监听网络请求，确保点击生效
                try:
                    with self.page.expect_response(lambda r: r.request.method == "POST", timeout=5000):
                        confirm_btn.first.click()
                except:
                    # 如果超时(没监听到包)，可能是前端拦截或已经在冷却，强制再点一次确保触发
                    confirm_btn.first.click()
            else:
                self.log("未找到确认按钮 (可能已被自动处理)", "WARNING")

            # -------------------------------------------------
            # 4. 分析结果 (读取韩语提示)
            # -------------------------------------------------
            time.sleep(3) # 等待提示出现
            self.save_debug(f"result_{server_id}")

            # 获取弹窗内容
            swal_title = self.page.locator("#swal2-title").inner_text() if self.page.locator("#swal2-title").is_visible() else ""
            swal_content = self.page.locator("#swal2-html-container").inner_text() if self.page.locator("#swal2-html-container").is_visible() else ""
            full_text = (swal_title + " " + swal_content).strip()
            
            self.log(f"服务器反馈: [{full_text}]", "DEBUG")

            # --- 判定逻辑 ---
            
            # A. 成功 (绿色图标 或 成功文字)
            if self.page.locator(".swal2-success").is_visible() or any(s in full_text for s in ["Success", "completed", "완료", "성공"]):
                self.log("✅ 续期成功！", "SUCCESS")
                return {"id": server_id, "status": "✅ 成功", "msg": "Renewed"}

            # B. 冷却中 (根据特定的韩语提示)
            # "아직 서버를 갱신할 수 없습니다" = 尚无法更新服务器
            if "아직 서버를 갱신할 수 없습니다" in full_text:
                self.log("检测到冷却提示：时间未到", "WARNING")
                return {"id": server_id, "status": "⏳ 冷却中", "msg": "Cooldown (Wait)"}

            # C. 其他失败 (已满/错误)
            fail_keywords = ["already", "이미", "cool down", "limit", "error", "failed"]
            if any(f in full_text.lower() for f in fail_keywords):
                return {"id": server_id, "status": "⏳ 其他限制", "msg": full_text[:15]}

            # D. 无明确结果
            if full_text:
                return {"id": server_id, "status": "❓ 未知结果", "msg": full_text[:20]}

            return {"id": server_id, "status": "❓ 无响应", "msg": "No Feedback"}

        except Exception as e:
            self.log(f"出错: {e}", "ERROR")
            return {"id": server_id, "status": "💥 出错", "msg": str(e)[:20]}

    def update_readme(self, results):
        bj_time = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
        content = f"# Weirdhost 续期报告\n> 更新时间: `{bj_time}`\n\n| ID | 状态 | 说明 |\n|---|---|---|\n"
        for r in results: content += f"| {r['id']} | {r['status']} | {r['msg']} |\n"
        try:
            with open("README.md", "w", encoding="utf-8") as f: f.write(content)
        except: pass

    def run(self):
        if not SERVER_URLS_STR:
            self.log("未设置 SERVER_URLS 环境变量", "ERROR")
            sys.exit(1)
            
        urls = [u.strip() for u in SERVER_URLS_STR.split(',') if u.strip()]
        
        with sync_playwright() as p:
            self.init_browser(p)
            if not self.login():
                self.log("无法登录，脚本退出", "ERROR")
                sys.exit(1)
            
            results = []
            for url in urls:
                results.append(self.process_server(url))
                time.sleep(3) # 两个服务器之间歇一下
            
            self.browser.close()
            self.update_readme(results)

if __name__ == "__main__":
    RenewBot().run()
