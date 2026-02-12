#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - 最终修复版 (2024)
功能：
1. 点击续期 -> 强制等待10秒(CF验���) -> 智能查找确认按钮 -> 点击确认
2. 精准识别：成功、冷却中(时间未到)、错误
3. 截图调试：每一步的关键节点都会截图，方便排查
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright

# ==================== 配置区域 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 环境变量
COOKIE_REMEMBER = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
COOKIE_SESSION = os.getenv('PTERODACTYL_SESSION', '').strip()
EMAIL = os.getenv('WEIRDHOST_EMAIL', '').strip()
PASSWORD = os.getenv('WEIRDHOST_PASSWORD', '').strip()
SERVER_URLS_STR = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()

# Headless: True=无界面(服务器用), False=显示浏览器(调试用)
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
        """保存截图用于调试"""
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            path = f"{SCREENSHOT_DIR}/{name}.png"
            self.page.screenshot(path=path, full_page=True)
            # self.log(f"已保存截图: {path}", "DEBUG")
        except: pass

    def init_browser(self, p):
        self.log(f"启动浏览器 (Headless: {HEADLESS})...")
        self.browser = p.chromium.launch(
            headless=HEADLESS, 
            # 关键：隐藏自动化特征，防止 CF 直接拦截
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
        
        # 注入 JS 进一步抹除 WebDriver 痕迹
        self.page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
        """)

    def check_cf(self):
        """通用 Cloudflare 检查"""
        try:
            title = self.page.title()
            if "Just a moment" in title or "Cloudflare" in title:
                self.log("检测到 Cloudflare 验证页...", "WARNING")
                time.sleep(3)
                
                # 尝试点击 iframe 里的复选框
                frames = self.page.frames
                for frame in frames:
                    if "challenges" in frame.url or "turnstile" in frame.url:
                        try:
                            box = frame.locator("input[type='checkbox']").first
                            if box.is_visible():
                                box.click()
                                self.log("尝试点击 CF 验证框", "INFO")
                        except: pass
                
                # 等待跳转
                try:
                    self.page.wait_for_url(lambda u: "auth" in u or "server" in u, timeout=8000)
                    self.log("CF 验证通过", "SUCCESS")
                except: pass
        except: pass

    def login(self):
        """登录逻辑：优先 Cookie，其次账号密码"""
        # 1. Cookie 登录
        if COOKIE_REMEMBER:
            self.log("尝试 Cookie 登录...", "INFO")
            cookies = [{'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d', 'value': COOKIE_REMEMBER, 'domain': 'hub.weirdhost.xyz', 'path': '/'}]
            if COOKIE_SESSION:
                cookies.append({'name': 'pterodactyl_session', 'value': COOKIE_SESSION, 'domain': 'hub.weirdhost.xyz', 'path': '/'})
            
            try:
                self.context.add_cookies(cookies)
                self.page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
                
                if "/auth/login" not in self.page.url:
                    self.log("Cookie 登录成功", "SUCCESS")
                    return True
            except Exception as e:
                self.log(f"Cookie 登录异常: {e}", "DEBUG")

        # 2. 账号密码登录
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
                
                if "/auth/login" not in self.page.url:
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
                return {"id": server_id, "status": "❌ 掉线", "msg": "需重新登录"}

            # =================================================
            # 1. 寻找【时间追加】按钮
            # =================================================
            btn = None
            target_texts = ["시간 추가", "시간추가", "Renew", "Extend"]
            for txt in target_texts:
                loc = self.page.locator(f"button:has-text('{txt}')")
                if loc.count() > 0:
                    for i in range(loc.count()):
                        if loc.nth(i).is_visible() and loc.nth(i).is_enabled():
                            btn = loc.nth(i)
                            self.log(f"找到续期按钮: {txt}", "INFO")
                            break
                if btn: break
            
            if not btn:
                self.save_debug(f"error_no_btn_{server_id}")
                return {"id": server_id, "status": "❌ 无按钮", "msg": "Button Not Found"}

            # =================================================
            # 2. 点击续期 & 强制等待 10 秒
            # =================================================
            self.log("点击续期按钮...", "INFO")
            btn.click()

            self.log("等待 10 秒 (等待 CF 盾 / 冷却)...", "WARNING")
            time.sleep(10)

            # 截图调试：看看10秒后屏幕上是什么
            self.save_debug(f"debug_after_wait_{server_id}")

            # 检查是否有 CF 干扰（iframe里的勾选框）
            try:
                frames = self.page.frames
                for frame in frames:
                    if "challenges" in frame.url or "turnstile" in frame.url:
                        box = frame.locator("input[type='checkbox']").first
                        if box.is_visible():
                            self.log("检测到 CF 验证框，尝试点击...", "DEBUG")
                            box.click()
                            time.sleep(2)
            except: pass

            # =================================================
            # 3. 寻找并点击【确认】按钮 (宽容模式)
            # =================================================
            confirm_btn = None
            try:
                # 组合选择器：同时查找 Class 和 文字内容
                # 这样即使没有 swal2-confirm 类，只要有 "확인" 字样也能找到
                selector = "button.swal2-confirm, button:has-text('확인'), button:has-text('Confirm'), button:has-text('Yes')"
                
                # 等待按钮出现 (最多等 5 秒)
                self.page.wait_for_selector(selector, state="visible", timeout=5000)
                confirm_btn = self.page.locator(selector).first
                
                if confirm_btn.is_visible():
                    txt = confirm_btn.inner_text().strip() if confirm_btn.inner_text() else "Icon"
                    self.log(f"找到确认按钮 [{txt}]，点击...", "INFO")
                    
                    # 尝试监听点击后的网络请求
                    with self.page.expect_response(lambda r: r.request.method == "POST", timeout=5000):
                        confirm_btn.click()
                else:
                    raise Exception("按钮不可见")

            except Exception as e:
                self.log(f"寻找确认按钮失败: {e}", "WARNING")
                self.save_debug(f"error_no_confirm_{server_id}")
                # 注意：如果找不到按钮，可能是因为不需要确认直接成功了？继续往下检查文字

            # =================================================
            # 4. 分析结果
            # =================================================
            time.sleep(3) # 等待提示出现
            self.save_debug(f"result_{server_id}")

            # 获取弹窗内容
            swal_title = self.page.locator("#swal2-title").inner_text() if self.page.locator("#swal2-title").is_visible() else ""
            swal_content = self.page.locator("#swal2-html-container").inner_text() if self.page.locator("#swal2-html-container").is_visible() else ""
            full_text = (swal_title + " " + swal_content).strip()
            
            self.log(f"服务器反馈: [{full_text}]", "DEBUG")

            # --- 判定逻辑 ---
            
            # A. 成功
            if self.page.locator(".swal2-success").is_visible() or any(s in full_text for s in ["Success", "completed", "완료", "성공"]):
                self.log("✅ 续期成功！", "SUCCESS")
                return {"id": server_id, "status": "✅ 成功", "msg": "Renewed"}

            # B. 冷却中 (时间未到)
            # 你的特定韩语提示
            if "아직 서버를 갱신할 수 없습니다" in full_text:
                self.log("检测到冷却提示：时间未到", "WARNING")
                return {"id": server_id, "status": "⏳ 冷却中", "msg": "Wait (Too Early)"}

            # C. 其他失败
            fail_keywords = ["already", "이미", "cool down", "limit", "error", "failed"]
            if any(f in full_text.lower() for f in fail_keywords):
                return {"id": server_id, "status": "⏳ 其他限制", "msg": full_text[:15]}

            # D. 未知
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
            self.log("错误：未设置 SERVER_URLS 环境变量", "ERROR")
            sys.exit(1)
            
        urls = [u.strip() for u in SERVER_URLS_STR.split(',') if u.strip()]
        
        with sync_playwright() as p:
            self.init_browser(p)
            if not self.login():
                self.log("无法登录，请检查 Cookie 或账号密码", "ERROR")
                sys.exit(1)
            
            results = []
            for url in urls:
                results.append(self.process_server(url))
                time.sleep(3) 
            
            self.browser.close()
            self.update_readme(results)

if __name__ == "__main__":
    RenewBot().run()
