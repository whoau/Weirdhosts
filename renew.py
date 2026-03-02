#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期 - 时间比对版
核心逻辑：不再依赖弹窗文字，通过对比前后“到期时间”来判断是否成功。
"""

import os
import sys
import time
import re
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync

# ==================== 配置 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 环境变量
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
            timestamp = int(time.time() * 1000)
            self.page.screenshot(path=f"{SCREENSHOT_DIR}/{name}_{timestamp}.png", full_page=True)
            self.log(f"截图已保存: {name}_{timestamp}.png", "DEBUG")
        except: pass

    def clear_screenshot_dir(self):
        try:
            if os.path.exists(SCREENSHOT_DIR):
                for file in os.listdir(SCREENSHOT_DIR):
                    file_path = os.path.join(SCREENSHOT_DIR, file)
                    if os.path.isfile(file_path):
                        os.unlink(file_path)
            else:
                os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        except: pass

    def init_browser(self, p):
        self.log(f"启动浏览器 (Headless: {HEADLESS})...")
        self.browser = p.chromium.launch(
            headless=HEADLESS,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        self.context = self.browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        )
        self.page = self.context.new_page()
        stealth_sync(self.page)
        self.page.set_default_timeout(60000)

    def check_cf(self):
        """简单的 CF 检查"""
        try:
            if "Just a moment" in self.page.title():
                self.log("检测到 CF 盾，尝试等待...", "WARNING")
                time.sleep(5)
                # 尝试点击复选框
                for frame in self.page.frames:
                    try: 
                        box = frame.locator("input[type='checkbox']").first
                        if box.is_visible(): box.click()
                    except: pass
        except: pass

    def login(self):
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
            except: pass

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
                if "/auth/login" not in self.page.url:
                    self.log("账号密码登录成功", "SUCCESS")
                    return True
            except Exception as e:
                self.log(f"登录失败: {e}", "ERROR")
        return False

    def get_expiry_time(self):
        """从页面提取到期时间"""
        try:
            # 获取页面所有文本
            text = self.page.locator("body").inner_text()
            # 正则匹配日期格式：202X-XX-XX XX:XX:XX
            # 你的例子：유통기한 2026-02-16 09:35:54
            match = re.search(r"(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})", text)
            if match:
                date_str = match.group(1)
                # 解析为 datetime 对象
                dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
                return dt
        except Exception as e:
            self.log(f"获取时间失败: {e}", "DEBUG")
        return None

    def process_server(self, url):
        server_id = url.strip('/').split("/")[-1]
        self.log(f"--- 处理: {server_id} ---", "INFO")

        try:
            self.page.goto(url, wait_until="networkidle", timeout=60000)
            self.check_cf()

            if "/auth/login" in self.page.url:
                self.save_debug(f"{server_id}_final_offline")
                return {"id": server_id, "status": "❌ 掉线", "msg": "需登录"}

            # =================================================
            # 步骤 1: 获取【续期前】的时间
            # =================================================
            old_time = self.get_expiry_time()
            self.save_debug(f"{server_id}_before_renewal")

            if old_time:
                self.log(f"当前到期时间: {old_time}", "INFO")
            else:
                self.log("⚠️ 未能提取到当前时间，将盲跑...", "WARNING")

            # =================================================
            # 步骤 2: 查找并点击续期按钮
            # =================================================
            btn = None
            for txt in ["시간 추가", "시간추가", "Renew", "Extend"]:
                loc = self.page.locator(f"button:has-text('{txt}')")
                if loc.count() > 0 and loc.first.is_visible():
                    btn = loc.first
                    break
            
            if not btn:
                self.save_debug(f"{server_id}_final_no_button")
                return {"id": server_id, "status": "❌ 无按钮", "msg": "Button Not Found"}

            self.log("点击【续期】...", "INFO")
            try:
                btn.click()
            except:
                btn.click(force=True)

            # =================================================
            # 步骤 3: 等待 10 秒 (过盾/处理)
            # =================================================
            self.log("等待 10 秒 (等待系统处理)...", "WARNING")
            time.sleep(10)

            # 截图 2: 点击续期后，刷新前
            self.save_debug(f"{server_id}_after_click")

            # 尝试点击可能存在的确认按钮 (作为保险，点了总比不点好)
            # 即使你不需要，有些时候 CF 盾是在弹窗里的
            try:
                confirm = self.page.locator("button.swal2-confirm, button:has-text('확인')").first
                if confirm.is_visible():
                    self.log("检测到确认弹窗，顺手点一下...", "DEBUG")
                    confirm.click()
                    time.sleep(2)
            except: pass

            # =================================================
            # 步骤 4: 刷新页面并获取【续期后】的时间
            # =================================================
            self.log("刷新页面检查结果...", "INFO")
            try:
                self.page.reload(wait_until="networkidle")
                self.check_cf()
            except: pass

            # 截图 3: 刷新后，最终状态
            self.save_debug(f"{server_id}_final_state")

            new_time = self.get_expiry_time()

            if new_time:
                self.log(f"最新到期时间: {new_time}", "INFO")
            else:
                # 如果刷新后拿不到时间，可能是网页挂了
                self.save_debug(f"{server_id}_final_unknown")
                return {"id": server_id, "status": "❓ 未知", "msg": "Time read fail"}

            # =================================================
            # 步骤 5: 对比时间判断结果
            # =================================================
            if old_time and new_time:
                if new_time > old_time:
                    self.log("✅ 时间已增加！续期成功", "SUCCESS")
                    self.save_debug(f"{server_id}_final_success")
                    return {"id": server_id, "status": "✅ 成功", "msg": f"-> {new_time}"}
                elif new_time == old_time:
                    self.log("⏳ 时间未变化 (可能是冷却中)", "WARNING")
                    self.save_debug(f"{server_id}_final_cooldown")
                    return {"id": server_id, "status": "⏳ 冷却中", "msg": "Time No Change"}
                else:
                    self.save_debug(f"{server_id}_final_anomaly")
                    return {"id": server_id, "status": "⚠️ 异常", "msg": "Time Decreased?"}

            # 如果没有旧时间做对比，只能返回成功(盲)
            self.save_debug(f"{server_id}_final_blind")
            return {"id": server_id, "status": "❓ 完成", "msg": f"Current: {new_time}"}

        except Exception as e:
            self.log(f"出错: {e}", "ERROR")
            self.save_debug(f"{server_id}_final_error")
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

        self.clear_screenshot_dir()

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
