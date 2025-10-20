#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - GitHub Actions 版本
重构版 - 通过精确捕获操作后的提示信息来判断续期结果，增强了健壮性和准确性。
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional, Any

from playwright.sync_api import sync_playwright, Page, BrowserContext, Locator, TimeoutError, Playwright

# --- 常量定义 ---

# 运行状态
STATUS_SUCCESS = "success"
STATUS_ALREADY_RENEWED = "already_renewed"
STATUS_NO_BUTTON = "no_button_found"
STATUS_BUTTON_DISABLED = "button_disabled"
STATUS_LOGIN_FAILED = "login_failed"
STATUS_ERROR = "error"
STATUS_CLICK_ERROR = "click_error"
STATUS_UNKNOWN = "unknown_result"
STATUS_NO_AUTH = "no_auth"
STATUS_NO_SERVERS = "no_servers"
STATUS_TIMEOUT = "timeout"
STATUS_RUNTIME_ERROR = "runtime_error"

# Playwright 选择器
RENEW_BUTTON_SELECTORS = [
    'button:has-text("시간추가")',
    'button:has-text("시간 추가")',
]
# 用于判断登录状态的选择器 (例如：登出按钮、用户头像等)
LOGGED_IN_INDICATOR = 'a[href*="auth/logout"]'
# 操作后可能出现的提示框选择器
NOTIFICATION_SELECTOR = '[role="alert"], .alert, .toast, .notification'

# 续期结果文本模式
RENEWAL_ERROR_PATTERNS = ["already renewed", "can't renew", "only once", "이미", "한번", "불가능"]
RENEWAL_SUCCESS_PATTERNS = ["success", "성공", "added", "추가됨", "연장"]


class WeirdhostManager:
    """
    管理 Weirdhost 服务器续期任务的核心类。
    """
    def __init__(self):
        """初始化，从环境变量读取配置。"""
        self.base_url = os.getenv('WEIRDHOST_URL', 'https://hub.weirdhost.xyz')
        self.login_url = f"{self.base_url}/auth/login"
        
        # 认证信息
        self.remember_web_cookie = os.getenv('REMEMBER_WEB_COOKIE', '')
        self.email = os.getenv('WEIRDHOST_EMAIL', '')
        self.password = os.getenv('WEIRDHOST_PASSWORD', '')
        
        # 浏览器配置
        self.headless = os.getenv('HEADLESS', 'true').lower() == 'true'
        
        # 解析服务器URL列表
        server_urls_str = os.getenv('WEIRDHOST_SERVER_URLS', '')
        self.server_list = [url.strip() for url in server_urls_str.split(',') if url.strip()]

    @staticmethod
    def log(message: str, level: str = "INFO"):
        """格式化日志输出。"""
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp}] [{level}] {message}")

    def _login_with_cookies(self, context: BrowserContext) -> bool:
        """使用 Cookies 登录。"""
        if not self.remember_web_cookie:
            return False
            
        self.log("尝试使用 Cookie 登录...")
        try:
            cookie = {
                'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d',
                'value': self.remember_web_cookie,
                'domain': '.weirdhost.xyz',
                'path': '/',
                'expires': int(time.time()) + 365 * 24 * 3600,
                'httpOnly': True,
                'secure': True,
                'sameSite': 'Lax'
            }
            context.add_cookies([cookie])
            self.log("Cookie 已添加。")
            return True
        except Exception as e:
            self.log(f"设置 Cookie 时出错: {e}", "ERROR")
            return False

    def _login_with_email(self, page: Page) -> bool:
        """使用邮箱密码登录。"""
        if not (self.email and self.password):
            return False

        self.log("尝试使用邮箱和密码登录...")
        try:
            page.goto(self.login_url, wait_until="domcontentloaded", timeout=60000)
            
            page.fill('input[name="username"]', self.email)
            page.fill('input[name="password"]', self.password)
            
            with page.expect_navigation(wait_until="domcontentloaded", timeout=60000):
                page.click('button[type="submit"]')
            
            is_logged_in = page.locator(LOGGED_IN_INDICATOR).is_visible()
            if not is_logged_in:
                 # 检查是否仍在登录页面
                if "login" in page.url or "auth" in page.url:
                    self.log("邮箱密码登录失败，可能凭据错误。", "ERROR")
                    return False
            
            self.log("邮箱密码登录成功。")
            return True
        except TimeoutError:
            self.log("登录页面加载或登录过程超时。", "ERROR")
            return False
        except Exception as e:
            self.log(f"邮箱密码登录时发生未知错误: {e}", "ERROR")
            return False

    def _check_login_status(self, page: Page) -> bool:
        """通过检查特定元素（如登出按钮）来确认登录状态。"""
        try:
            page.goto(self.base_url, wait_until="domcontentloaded")
            page.wait_for_selector(LOGGED_IN_INDICATOR, timeout=10000)
            self.log("登录状态确认：已登录。")
            return True
        except TimeoutError:
            self.log("登录状态确认失败，未找到登录标识。", "WARNING")
            return False

    def _find_renew_button(self, page: Page) -> Optional[Locator]:
        """在页面上查找续期按钮。"""
        self.log("正在查找续期按钮...")
        for selector in RENEW_BUTTON_SELECTORS:
            try:
                button = page.locator(selector).first
                if button.is_visible(timeout=5000):
                    self.log(f"找到按钮，选择器: '{selector}'")
                    return button
            except TimeoutError:
                continue
        self.log("未找到可见的续期按钮。", "WARNING")
        return None

    def _click_and_verify_renewal(self, page: Page, button: Locator, server_id: str) -> Dict[str, str]:
        """点击续期按钮并验证结果。"""
        try:
            if not button.is_enabled():
                self.log(f"服务器 {server_id}: 续期按钮不可点击。", "WARNING")
                return {"status": STATUS_BUTTON_DISABLED, "server_id": server_id}
            
            self.log(f"服务器 {server_id}: 点击续期按钮...")
            button.click()

            # 等待操作后的提示消息出现
            try:
                notification = page.locator(NOTIFICATION_SELECTOR).first
                notification.wait_for(state="visible", timeout=10000)
                
                msg_text = notification.text_content().lower()
                self.log(f"服务器 {server_id}: 检测到提示消息: '{msg_text}'")

                if any(pattern in msg_text for pattern in RENEWAL_ERROR_PATTERNS):
                    self.log(f"服务器 {server_id}: 已续期或无法续期。")
                    return {"status": STATUS_ALREADY_RENEWED, "server_id": server_id}
                
                if any(pattern in msg_text for pattern in RENEWAL_SUCCESS_PATTERNS):
                    self.log(f"服务器 {server_id}: 续期成功！", "SUCCESS")
                    return {"status": STATUS_SUCCESS, "server_id": server_id}

                self.log(f"服务器 {server_id}: 出现未知提示消息。", "WARNING")
                return {"status": STATUS_UNKNOWN, "server_id": server_id}

            except TimeoutError:
                self.log(f"服务器 {server_id}: 点击后未在10秒内检测到任何提示消息。", "WARNING")
                # 增加一次页面刷新后的检查，以防万一
                page.reload(wait_until="networkidle")
                return self._process_single_server(page, page.url) # 重新检查当前页面状态
                
        except Exception as e:
            self.log(f"服务器 {server_id}: 点击或验证过程中发生错误: {e}", "ERROR")
            return {"status": STATUS_CLICK_ERROR, "server_id": server_id}

    def _process_single_server(self, page: Page, server_url: str) -> Dict[str, str]:
        """处理单个服务器的续期流程。"""
        server_id = server_url.strip('/').split('/')[-1]
        self.log(f"--- 开始处理服务器: {server_id} ---")
        
        try:
            page.goto(server_url, wait_until="networkidle", timeout=60000)
            
            button = self._find_renew_button(page)
            if not button:
                return {"status": STATUS_NO_BUTTON, "server_id": server_id}

            return self._click_and_verify_renewal(page, button, server_id)

        except TimeoutError:
            self.log(f"服务器 {server_id}: 访问页面超时。", "ERROR")
            return {"status": STATUS_TIMEOUT, "server_id": server_id}
        except Exception as e:
            self.log(f"服务器 {server_id}: 处理时发生未知错误: {e}", "ERROR")
            return {"status": STATUS_ERROR, "server_id": server_id}

    def run(self) -> List[Dict[str, str]]:
        """执行整个续期任务的主函数。"""
        self.log("开始 Weirdhost 自动续期任务。")
        
        if not self.remember_web_cookie and not (self.email and self.password):
            self.log("未提供任何认证信息（Cookie或邮箱密码）。", "ERROR")
            return [{"status": STATUS_NO_AUTH}]
            
        if not self.server_list:
            self.log("服务器URL列表为空，请配置 WEIRDHOST_SERVER_URLS。", "ERROR")
            return [{"status": STATUS_NO_SERVERS}]

        results = []
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=self.headless)
                context = browser.new_context(user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36")
                page = context.new_page()
                page.set_default_timeout(60000)

                # 登录流程
                logged_in = False
                if self._login_with_cookies(context):
                    if self._check_login_status(page):
                        logged_in = True
                
                if not logged_in and self._login_with_email(page):
                    logged_in = True

                if not logged_in:
                    self.log("所有登录方式均失败。", "ERROR")
                    browser.close()
                    # 为每个服务器生成登录失败的结果
                    return [{"status": STATUS_LOGIN_FAILED, "server_id": url.strip('/').split('/')[-1]} for url in self.server_list]
                
                # 依次处理服务器
                self.log(f"登录成功，开始处理 {len(self.server_list)} 个服务器...")
                for i, server_url in enumerate(self.server_list):
                    result = self._process_single_server(page, server_url)
                    results.append(result)
                    self.log(f"服务器 {result.get('server_id', 'N/A')} 处理完成，状态: {result['status']}")
                    if i < len(self.server_list) - 1:
                        time.sleep(3)  # 在服务器之间短暂休息，模拟人类行为

                browser.close()
        except Exception as e:
            self.log(f"Playwright 运行时发生严重错误: {e}", "CRITICAL")
            return [{"status": STATUS_RUNTIME_ERROR, "error_message": str(e)}]
        
        self.log("所有服务器处理完毕。")
        return results

def write_readme(results: List[Dict[str, str]]):
    """根据运行结果生成README.md文件。"""
    
    status_map = {
        STATUS_SUCCESS: "✅ 续期成功",
        STATUS_ALREADY_RENEWED: "ℹ️ 已是最新状态（或今日已续）",
        STATUS_NO_BUTTON: "❌ 未找到续期按钮",
        STATUS_BUTTON_DISABLED: "⚠️ 续期按钮不可点击",
        STATUS_CLICK_ERROR: "💥 点击或验证时出错",
        STATUS_UNKNOWN: "❓ 未知结果",
        STATUS_ERROR: "💥 处理时发生错误",
        STATUS_LOGIN_FAILED: "❌ 登录失败",
        STATUS_NO_AUTH: "❌ 认证信息缺失",
        STATUS_NO_SERVERS: "❌ 服务器列表未配置",
        STATUS_TIMEOUT: "⏰ 操作超时",
        STATUS_RUNTIME_ERROR: "💥 脚本运行时发生严重错误"
    }

    try:
        beijing_time = datetime.now(timezone(timedelta(hours=8)))
        timestamp = beijing_time.strftime('%Y-%m-%d %H:%M:%S %Z')
        
        content = f"# Weirdhost 自动续期报告\n\n"
        content += f"**最后更新时间**: `{timestamp}`\n\n"
        content += "## 运行结果\n\n"
        
        if not results:
            content += "- 🤷‍♂️ 没有提供任何运行结果。\n"
        else:
            for res in results:
                status = res.get("status", STATUS_UNKNOWN)
                server_id = res.get("server_id")
                status_text = status_map.get(status, f"❓ 未知状态: {status}")
                
                if server_id:
                    content += f"- **服务器 `{server_id}`**: {status_text}\n"
                else:
                    # 处理全局错误，如登录失败、无配置等
                    content += f"- **全局状态**: {status_text}\n"
                    if "error_message" in res:
                        content += f"  - `详情: {res['error_message']}`\n"
        
        with open('README.md', 'w', encoding='utf-8') as f:
            f.write(content)
        print("📝 README.md 文件已成功更新。")

    except Exception as e:
        print(f"🔥 写入 README.md 文件时出错: {e}")

def main():
    """脚本入口函数。"""
    print("🚀 Weirdhost 自动续期脚本启动")
    print("=" * 50)

    # 预检环境变量
    if not os.getenv('REMEMBER_WEB_COOKIE') and not (os.getenv('WEIRDHOST_EMAIL') and os.getenv('WEIRDHOST_PASSWORD')):
        print("❌ 错误：未设置认证信息！请在 GitHub Secrets 中设置 `REMEMBER_WEB_COOKIE` 或 `WEIRDHOST_EMAIL` 与 `WEIRDHOST_PASSWORD`。")
        write_readme([{"status": STATUS_NO_AUTH}])
        sys.exit(1)
        
    if not os.getenv('WEIRDHOST_SERVER_URLS'):
        print("❌ 错误：未设置服务器URL列表！请在 GitHub Secrets 中设置 `WEIRDHOST_SERVER_URLS`。")
        write_readme([{"status": STATUS_NO_SERVERS}])
        sys.exit(1)

    manager = WeirdhostManager()
    results = manager.run()

    write_readme(results)
    
    print("=" * 50)
    print("📊 运行结果汇总:")
    for res in results:
        server_id = res.get('server_id', '全局')
        print(f"  - [{server_id}]: {res['status']}")

    # 如果有任何非成功或非“已续期”的状态，则认为任务部分失败
    has_failures = any(
        res['status'] not in [STATUS_SUCCESS, STATUS_ALREADY_RENEWED]
        for res in results
    )
    
    if has_failures:
        print("\n⚠️ 注意：部分或全部任务未能成功完成。请检查上面的日志和更新后的 README.md。")
        sys.exit(1)
    else:
        print("\n🎉 所有任务均已成功完成！")
        sys.exit(0)

if __name__ == "__main__":
    main()
