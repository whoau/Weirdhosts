#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - 通用修复版
1. 修复 SPA 页面加载导致找不到按钮的问题
2. 移除所有硬编码的服务器 URL，改为环境变量读取
"""

import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# ==================== 基础配置 ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"

# 按钮文本 (韩文/英文/中文 可能的变化)
BUTTON_TEXTS = ["시간 추가", "시간추가", "Renew", "Extend", "Add Time"]

# 环境变量读取
COOKIE_REMEMBER = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
COOKIE_SESSION = os.getenv('PTERODACTYL_SESSION', '').strip() # 可选
EMAIL = os.getenv('WEIRDHOST_EMAIL', '').strip()
PASSWORD = os.getenv('WEIRDHOST_PASSWORD', '').strip()
# 获取服务器列表 (逗号分隔)
SERVER_URLS_STR = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()

# 设置
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
DEFAULT_TIMEOUT = 60000 # 60秒
SCREENSHOT_DIR = "screenshots"

class RenewBot:
    def __init__(self):
        self.browser = None
        self.context = None
        self.page = None
        self.log_buffer = []

    def log(self, msg, level="INFO"):
        """日志输出"""
        ts = datetime.now().strftime('%H:%M:%S')
        icon = {"INFO": "ℹ️", "SUCCESS": "✅", "WARNING": "⚠️", "ERROR": "❌", "DEBUG": "🔍"}.get(level, "")
        print(f"[{ts}] {icon} [{level}] {msg}")

    def save_debug(self, name):
        """保存截图和HTML用于调试"""
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            self.page.screenshot(path=f"{SCREENSHOT_DIR}/{name}.png", full_page=True)
            with open(f"{SCREENSHOT_DIR}/{name}.html", "w", encoding="utf-8") as f:
                f.write(self.page.content())
            self.log(f"已保存调试文件: {name}", "DEBUG")
        except:
            pass

    def init_browser(self, p):
        """初始化浏览器，配置反检测"""
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
        
        # 注入反检测脚本
        self.page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            window.chrome = { runtime: {} };
        """)

    def check_cf(self):
        """简单的 CF 检测与等待"""
        try:
            if "challenges.cloudflare.com" in self.page.content() or "Just a moment" in self.page.title():
                self.log("检测到 Cloudflare，等待 5 秒...", "WARNING")
                time.sleep(5)
                # 尝试点击 Cloudflare 里的 checkbox（如果有）
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
        """严格检查登录状态"""
        url = self.page.url
        if "/auth/login" in url:
            return False
        # 检查页面是否有典型的已登录元素 (比如登出按钮，或者侧边栏)
        # Pterodactyl 面板通常有 sidebar
        try:
            if self.page.locator(".fa-sign-out-alt, a[href*='/auth/logout']").count() > 0:
                return True
        except: pass
        
        # 如果不是登录页，且没有跳转，暂且认为已登录
        return True

    def login(self):
        """登录逻辑"""
        # 1. Cookie 登录
        if COOKIE_REMEMBER:
            self.log("尝试 Cookie 登录...", "INFO")
            cookies = [{
                'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d', # 核心Cookie名
                'value': COOKIE_REMEMBER,
                'domain': 'hub.weirdhost.xyz',
                'path': '/'
            }]
            if COOKIE_SESSION:
                cookies.append({'name': 'pterodactyl_session', 'value': COOKIE_SESSION, 'domain': 'hub.weirdhost.xyz', 'path': '/'})
            
            self.context.add_cookies(cookies)
            
            # 访问主页验证
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

        # 2. 账号密码登录
        if EMAIL and PASSWORD:
            self.log("尝试账号密码登录...", "INFO")
            try:
                self.page.goto(LOGIN_URL, wait_until="domcontentloaded")
                self.check_cf()
                
                self.page.fill("input[name='username'], input[name='email']", EMAIL)
                self.page.fill("input[name='password']", PASSWORD)
                self.page.click("button[type='submit']")
                
                self.page.wait_for_load_state("networkidle") # 等待跳转完成
                self.check_cf()

                if self.is_logged_in():
                    self.log("账号密码登录成功", "SUCCESS")
                    return True
            except Exception as e:
                self.log(f"登录失败: {e}", "ERROR")
        
        return False

    def process_server(self, url):
        """处理单个服务器"""
        server_id = url.split("/")[-1]
        self.log(f"--- 开始处理: {server_id} ---", "INFO")
        
        try:
            # 关键修改：使用 networkidle 等待 SPA 加载完成
            self.page.goto(url, wait_until="networkidle", timeout=60000)
            self.check_cf()
            
            # 再次检查是否掉线（被重定向到登录页）
            if "/auth/login" in self.page.url:
                self.log("访问服务器页面时登录失效，跳过", "ERROR")
                return "login_lost"

            # 调试：打印当前页面标题，确保没跑偏
            self.log(f"当前标题: {self.page.title()}", "DEBUG")

            # 查找按钮 (模糊匹配)
            btn = None
            for txt in BUTTON_TEXTS:
                # 查找包含文本的按钮
                loc = self.page.locator(f"button:has-text('{txt}'), a:has-text('{txt}')")
                if loc.count() > 0:
                    btn = loc.first
                    self.log(f"找到按钮: {txt}", "SUCCESS")
                    break
            
            if not btn:
                # 再次尝试：列出页面所有文本，看看是不是加载出了问题
                body_text = self.page.inner_text("body")[:100].replace('\n', ' ')
                self.log(f"未找到按钮。页面预览: {body_text}...", "ERROR")
                self.save_debug(f"no_button_{server_id}")
                return "no_button"

            if not btn.is_enabled():
                self.log("按钮不可点击 (可能已续期)", "WARNING")
                return "already_renewed"

            # 点击
            btn.click()
            self.log("已点击续期按钮", "SUCCESS")
            time.sleep(3) # 等待反应
            
            # 处理可能的确认弹窗
            try:
                confirm = self.page.locator("button:has-text('확인'), button:has-text('Yes')")
                if confirm.count() > 0 and confirm.first.is_visible():
                    confirm.first.click()
                    self.log("点击了确认弹窗", "INFO")
            except: pass
            
            return "success"

        except Exception as e:
            self.log(f"处理出错: {e}", "ERROR")
            self.save_debug(f"error_{server_id}")
            return "error"

    def run(self):
        if not SERVER_URLS_STR:
            self.log("未设置 WEIRDHOST_SERVER_URLS 环境变量", "ERROR")
            sys.exit(1)
        
        urls = [u.strip() for u in SERVER_URLS_STR.split(',') if u.strip()]
        self.log(f"读取到 {len(urls)} 个服务器", "INFO")

        with sync_playwright() as p:
            self.init_browser(p)
            
            if not self.login():
                self.log("无法登录，脚本终止", "ERROR")
                self.save_debug("login_failed")
                sys.exit(1)
            
            results = []
            for url in urls:
                res = self.process_server(url)
                results.append(res)
                time.sleep(2) # 缓冲
            
            self.browser.close()
            
            # 总结
            success_cnt = results.count("success") + results.count("already_renewed")
            if success_cnt == len(urls):
                self.log("所有服务器处理完毕", "SUCCESS")
                sys.exit(0)
            else:
                self.log("部分服务器处理失败", "WARNING")
                sys.exit(1)

if __name__ == "__main__":
    RenewBot().run()
