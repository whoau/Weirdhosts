#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - 修复版
修复问题：显示成功但实际未增加时间
新增功能：自动点击二次确认弹窗、检测成功提示
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

# ==================== 配置常量 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 识别续期按钮的文本
BUTTON_TEXTS = ["시간 추가", "시간추가", "Renew", "Extend", "Add Time"]

# 识别确认弹窗按钮的文本 (关键修复)
CONFIRM_TEXTS = ["확인", "Yes", "Confirm", "OK", "예"]

# 环境变量读取
COOKIE_REMEMBER = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
COOKIE_SESSION = os.getenv('PTERODACTYL_SESSION', '').strip()
EMAIL = os.getenv('WEIRDHOST_EMAIL', '').strip()
PASSWORD = os.getenv('WEIRDHOST_PASSWORD', '').strip()
SERVER_URLS_STR = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()

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
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        self.context = self.browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR"
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(60000)
        
        self.page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
        """)

    def check_cf(self):
        try:
            if "challenges.cloudflare.com" in self.page.content():
                self.log("检测到 Cloudflare，等待中...", "WARNING")
                time.sleep(5)
                for frame in self.page.frames:
                    try: frame.locator("input[type='checkbox']").first.click(timeout=3000)
                    except: pass
                time.sleep(5)
        except: pass

    def is_logged_in(self):
        if "/auth/login" in self.page.url: return False
        try:
            if self.page.locator("a[href*='/auth/logout']").count() > 0: return True
        except: pass
        return True

    def login(self):
        if COOKIE_REMEMBER:
            self.log("尝试 Cookie 登录...", "INFO")
            cookies = [{'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d', 'value': COOKIE_REMEMBER, 'domain': 'hub.weirdhost.xyz', 'path': '/'}]
            if COOKIE_SESSION:
                cookies.append({'name': 'pterodactyl_session', 'value': COOKIE_SESSION, 'domain': 'hub.weirdhost.xyz', 'path': '/'})
            self.context.add_cookies(cookies)
            try:
                self.page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
                self.check_cf()
                if self.is_logged_in():
                    self.log("Cookie 登录成功", "SUCCESS")
                    return True
            except: pass

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
            self.check_cf()
            
            if "/auth/login" in self.page.url:
                return {"id": server_id, "status": "❌ 掉线", "msg": "Login Lost"}

            # 1. 查找续期按钮
            btn = None
            for txt in BUTTON_TEXTS:
                # 精确查找按钮，避免点到文字说明
                loc = self.page.locator(f"button:has-text('{txt}')")
                if loc.count() > 0:
                    btn = loc.first
                    self.log(f"找到按钮: {txt}", "INFO")
                    break
            
            if not btn:
                self.save_debug(f"no_btn_{server_id}")
                return {"id": server_id, "status": "❌ 无按钮", "msg": "Button Not Found"}

            if not btn.is_enabled():
                return {"id": server_id, "status": "ℹ️ 已续期", "msg": "Button Disabled"}

            # 2. 点击续期按钮
            self.log("点击续期...", "INFO")
            btn.click()
            time.sleep(2) # 等待弹窗

            # 3. ★关键修复★：查找并点击确认弹窗 (SweetAlert2)
            # 这一步是为了解决“点了没反应”的问题
            confirm_clicked = False
            try:
                # 查找常见的确认按钮
                for c_txt in CONFIRM_TEXTS:
                    # 查找弹窗里的确认按钮 (通常在 .swal2-container 里)
                    c_btn = self.page.locator(f"button.swal2-confirm:has-text('{c_txt}'), button:has-text('{c_txt}')")
                    # 排除掉刚才那个续期按钮自己，只找可见的、新的按钮
                    if c_btn.count() > 0:
                        for i in range(c_btn.count()):
                            if c_btn.nth(i).is_visible():
                                self.log(f"发现确认弹窗: {c_txt}，点击确认...", "INFO")
                                c_btn.nth(i).click()
                                confirm_clicked = True
                                time.sleep(3) # 等待服务器响应
                                break
                    if confirm_clicked: break
            except Exception as e:
                self.log(f"处理弹窗时微小错误: {e}", "DEBUG")

            # 4. 验证结果 (通过检测页面提示)
            self.save_debug(f"result_{server_id}") # 截图看结果
            
            # 检测成功提示 (Toast 或 Alert)
            success_indicators = ["성공", "Success", "완료", "Completed", "added"]
            page_content = self.page.content()
            
            # 检查是否有成功提示
            if any(s in page_content for s in success_indicators):
                self.log("检测到成功提示", "SUCCESS")
                return {"id": server_id, "status": "✅ 成功", "msg": "Success"}
            
            # 检查是否有失败提示 (如 Already renewed)
            fail_indicators = ["already", "이미", "cool down", "limit"]
            if any(f in page_content.lower() for f in fail_indicators):
                self.log("检测到冷却/已续期提示", "WARNING")
                return {"id": server_id, "status": "⏳ 冷却/已满", "msg": "Limit Reached"}

            # 如果没有明确提示，但点了确认，我们谨慎返回
            if confirm_clicked:
                return {"id": server_id, "status": "✅ 成功(盲)", "msg": "Confirmed"}
            
            return {"id": server_id, "status": "❓ 未知", "msg": "No response"}

        except Exception as e:
            self.log(f"出错: {e}", "ERROR")
            return {"id": server_id, "status": "💥 出错", "msg": str(e)[:20]}

    def update_readme(self, results):
        bj_time = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
        content = f"# Weirdhost 续期报告\n> 更新: `{bj_time}`\n\n| ID | 状态 | 说明 |\n|---|---|---|\n"
        for r in results: content += f"| {r['id']} | {r['status']} | {r['msg']} |\n"
        try:
            with open("README.md", "w", encoding="utf-8") as f: f.write(content)
        except: pass

    def run(self):
        if not SERVER_URLS_STR: sys.exit(1)
        urls = [u.strip() for u in SERVER_URLS_STR.split(',') if u.strip()]
        
        with sync_playwright() as p:
            self.init_browser(p)
            if not self.login(): sys.exit(1)
            
            results = []
            for url in urls:
                results.append(self.process_server(url))
                time.sleep(3)
            
            self.browser.close()
            self.update_readme(results)

if __name__ == "__main__":
    RenewBot().run()
