#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - 带 README 更新功能
"""

import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

# ==================== 配置 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 按钮文本 (韩文/英文/中文)
BUTTON_TEXTS = ["시간 추가", "시간추가", "Renew", "Extend", "Add Time"]

# 环境变量读取
COOKIE_REMEMBER = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
COOKIE_SESSION = os.getenv('PTERODACTYL_SESSION', '').strip()
EMAIL = os.getenv('WEIRDHOST_EMAIL', '').strip()
PASSWORD = os.getenv('WEIRDHOST_PASSWORD', '').strip()
SERVER_URLS_STR = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()

HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
DEFAULT_TIMEOUT = 60000 
SCREENSHOT_DIR = "screenshots"

class RenewBot:
    def __init__(self):
        self.browser = None
        self.context = None
        self.page = None

    def log(self, msg, level="INFO"):
        ts = datetime.now().strftime('%H:%M:%S')
        icon = {"INFO": "ℹ️", "SUCCESS": "✅", "WARNING": "⚠️", "ERROR": "❌", "DEBUG": "🔍"}.get(level, "")
        print(f"[{ts}] {icon} [{level}] {msg}")

    def save_debug(self, name):
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            self.page.screenshot(path=f"{SCREENSHOT_DIR}/{name}.png", full_page=True)
        except: pass

    def init_browser(self, p):
        self.log(f"启动浏览器 (Headless: {HEADLESS})...")
        self.browser = p.chromium.launch(
            headless=HEADLESS,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        self.context = self.browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR"
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(DEFAULT_TIMEOUT)
        
        self.page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
        """)

    def check_cf(self):
        try:
            if "challenges.cloudflare.com" in self.page.content() or "Just a moment" in self.page.title():
                self.log("检测到 Cloudflare，等待 5 秒...", "WARNING")
                time.sleep(5)
                frames = self.page.frames
                for frame in frames:
                    try:
                        cb = frame.locator("input[type='checkbox']")
                        if cb.count() > 0:
                            cb.first.click(timeout=2000)
                    except: pass
                time.sleep(5)
        except: pass

    def is_logged_in(self):
        url = self.page.url
        if "/auth/login" in url: return False
        try:
            if self.page.locator(".fa-sign-out-alt, a[href*='/auth/logout']").count() > 0:
                return True
        except: pass
        return True

    def login(self):
        # Cookie 登录
        if COOKIE_REMEMBER:
            self.log("尝试 Cookie 登录...", "INFO")
            cookies = [{
                'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d',
                'value': COOKIE_REMEMBER,
                'domain': 'hub.weirdhost.xyz',
                'path': '/'
            }]
            if COOKIE_SESSION:
                cookies.append({'name': 'pterodactyl_session', 'value': COOKIE_SESSION, 'domain': 'hub.weirdhost.xyz', 'path': '/'})
            
            self.context.add_cookies(cookies)
            
            try:
                self.page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
                self.check_cf()
                if self.is_logged_in():
                    self.log("Cookie 登录成功", "SUCCESS")
                    return True
                else:
                    self.log("Cookie 失效", "WARNING")
            except:
                self.log("Cookie 验证超时", "WARNING")

        # 账号密码登录
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
        server_id = url.split("/")[-1]
        self.log(f"--- 开始处理: {server_id} ---", "INFO")
        
        try:
            self.page.goto(url, wait_until="networkidle", timeout=60000)
            self.check_cf()
            
            if "/auth/login" in self.page.url:
                self.log("登录失效", "ERROR")
                return {"id": server_id, "status": "❌ 登录失效", "msg": "Login Lost"}

            # 查找按钮
            btn = None
            for txt in BUTTON_TEXTS:
                loc = self.page.locator(f"button:has-text('{txt}'), a:has-text('{txt}')")
                if loc.count() > 0:
                    btn = loc.first
                    self.log(f"找到按钮: {txt}", "SUCCESS")
                    break
            
            if not btn:
                self.log(f"未找到按钮", "ERROR")
                self.save_debug(f"no_button_{server_id}")
                return {"id": server_id, "status": "❌ 未找到按钮", "msg": "No Button"}

            if not btn.is_enabled():
                self.log("按钮不可点击 (可能已续期)", "WARNING")
                return {"id": server_id, "status": "ℹ️ 已续期", "msg": "Already Renewed"}

            # 点击
            btn.click()
            self.log("已点击续期按钮", "SUCCESS")
            time.sleep(3)
            
            # 确认弹窗
            try:
                confirm = self.page.locator("button:has-text('확인'), button:has-text('Yes')")
                if confirm.count() > 0 and confirm.first.is_visible():
                    confirm.first.click()
            except: pass
            
            return {"id": server_id, "status": "✅ 续期成功", "msg": "Success"}

        except Exception as e:
            self.log(f"处理出错: {e}", "ERROR")
            self.save_debug(f"error_{server_id}")
            return {"id": server_id, "status": "💥 出错", "msg": str(e)[:20]}

    def update_readme(self, results):
        """更新 README.md 文件"""
        beijing_time = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
        
        content = f"# Weirdhost 自动续期报告\n\n"
        content += f"> **最后更新时间**: `{beijing_time}` (北京时间)\n\n"
        content += "## 📊 运行状态\n\n"
        content += "| 服务器 ID | 状态 | 说明 |\n"
        content += "| :--- | :--- | :--- |\n"
        
        for res in results:
            content += f"| `{res['id']}` | {res['status']} | {res['msg']} |\n"
            
        content += "\n---\n"
        content += "*本报告由 GitHub Actions 自动生成*\n"
        
        try:
            with open("README.md", "w", encoding="utf-8") as f:
                f.write(content)
            self.log("README.md 更新成功", "SUCCESS")
        except Exception as e:
            self.log(f"README.md 更新失败: {e}", "ERROR")

    def run(self):
        if not SERVER_URLS_STR:
            self.log("未设置 WEIRDHOST_SERVER_URLS", "ERROR")
            sys.exit(1)
        
        urls = [u.strip() for u in SERVER_URLS_STR.split(',') if u.strip()]
        self.log(f"读取到 {len(urls)} 个服务器", "INFO")

        results = []

        with sync_playwright() as p:
            self.init_browser(p)
            
            if not self.login():
                self.log("无法登录，脚本终止", "ERROR")
                self.save_debug("login_failed")
                sys.exit(1)
            
            for url in urls:
                res = self.process_server(url)
                results.append(res)
                time.sleep(2)
            
            self.browser.close()
            
            # 更新 README
            self.update_readme(results)
            
            # 判断最终状态
            failed = any(r['status'].startswith('❌') or r['status'].startswith('💥') for r in results)
            if failed:
                sys.exit(1)
            else:
                sys.exit(0)

if __name__ == "__main__":
    RenewBot().run()
