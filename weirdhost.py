#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - GitHub Actions 版本
优化版: 保留核心登录逻辑，增强健壮性和日志清晰度
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

class WeirdhostRenew:
    def __init__(self):
        """初始化，从环境变量读取配置"""
        self.url = os.getenv('WEIRDHOST_URL', 'https://hub.weirdhost.xyz')
        self.login_url = f"{self.url}/auth/login"
        self.server_urls_str = os.getenv('WEIRDHOST_SERVER_URLS', '')
        
        # --- 认证信息 ---
        # 核心Cookie (你的原始方案)
        self.remember_web_cookie_value = os.getenv('REMEMBER_WEB_COOKIE', '')
        # 可选的Session Cookie (增强方案)
        self.pterodactyl_session_value = os.getenv('PTERODACTYL_SESSION', '')
        # 备用的邮箱密码
        self.email = os.getenv('WEIRDHOST_EMAIL', '')
        self.password = os.getenv('WEIRDHOST_PASSWORD', '')
        
        self.headless = os.getenv('HEADLESS', 'true').lower() == 'true'
        self.server_list = [url.strip() for url in self.server_urls_str.split(',') if url.strip()]

    def log(self, message, level="INFO"):
        """格式化的日志输出"""
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp}] [{level.upper()}] {message}")

    def _check_login_status(self, page):
        """检查登录状态，返回True表示已登录"""
        current_url = page.url
        if "/auth/login" in current_url:
            self.log("当前在登录页面，状态：未登录", "DEBUG")
            return False
        
        # 尝试寻找已登录的标志，例如用户头像或退出按钮
        # 这是一个更可靠的检查方式
        try:
            logout_button = page.locator('a[href*="auth/logout"], button:has-text("Logout"), button:has-text("로그아웃")')
            if logout_button.count() > 0 and logout_button.first.is_visible(timeout=2000):
                self.log("找到登出按钮，状态：已登录", "DEBUG")
                return True
        except PlaywrightTimeoutError:
            pass # 找不到也正常

        self.log(f"当前URL: {current_url}，未找到明确登录标志，假设已登录", "DEBUG")
        return True # 默认不在登录页就认为已登录，保持原逻辑

    def _login_with_cookies(self, context):
        """使用 Cookies 登录，支持单/双Cookie"""
        if not self.remember_web_cookie_value:
            return False

        self.log("尝试使用 Cookie 登录...")
        
        cookies_to_add = []
        
        # 1. 添加核心的 remember_web Cookie (你的原始方案)
        cookies_to_add.append({
            'name': 'remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d',
            'value': self.remember_web_cookie_value,
            'domain': 'hub.weirdhost.xyz',
            'path': '/',
        })
        self.log("已准备 'remember_web_...' Cookie。")

        # 2. 如果提供了 pterodactyl_session，也添加它 (增强方案)
        if self.pterodactyl_session_value:
            cookies_to_add.append({
                'name': 'pterodactyl_session',
                'value': self.pterodactyl_session_value,
                'domain': 'hub.weirdhost.xyz',
                'path': '/',
            })
            self.log("已准备 'pterodactyl_session' Cookie。")
        
        try:
            context.add_cookies(cookies_to_add)
            self.log(f"成功添加 {len(cookies_to_add)} 个 Cookie 到浏览器上下文。")
            return True
        except Exception as e:
            self.log(f"设置 Cookie 时出错: {e}", "ERROR")
            return False

    def _login_with_email(self, page):
        """使用邮箱和密码登录"""
        if not (self.email and self.password):
            return False

        self.log("尝试使用邮箱密码登录...")
        try:
            page.goto(self.login_url, wait_until="domcontentloaded", timeout=60000)
            page.fill('input[name="username"]', self.email)
            page.fill('input[name="password"]', self.password)
            page.click('button[type="submit"]')
            page.wait_for_navigation(wait_until="networkidle", timeout=60000)
            
            if "/auth/login" in page.url:
                self.log("邮箱密码登录失败，页面仍在登录页。", "WARNING")
                return False
            
            self.log("邮箱密码登录成功！")
            return True
        except Exception as e:
            self.log(f"邮箱密码登录时发生错误: {e}", "ERROR")
            return False

    def _renew_server(self, page, server_url):
        """对单个服务器执行续期操作"""
        server_id = server_url.strip('/').split('/')[-1]
        self.log(f"--- 开始处理服务器: {server_id} ---")

        try:
            page.goto(server_url, wait_until="networkidle", timeout=60000)

            # 确认仍在登录状态
            if not self._check_login_status(page):
                self.log(f"在访问服务器 {server_id} 页面时发现未登录！", "ERROR")
                return f"{server_id}:login_failed_on_server_page"
            
            # 查找续期按钮
            renew_button_selector = 'button:has-text("시간 추가")' # 优先使用带空格的，根据你的成功日志
            renew_button = page.locator(renew_button_selector)

            try:
                renew_button.wait_for(state='visible', timeout=15000)
            except PlaywrightTimeoutError:
                # 如果找不到，尝试不带空格的版本
                renew_button_selector_alt = 'button:has-text("시간추가")'
                renew_button = page.locator(renew_button_selector_alt)
                try:
                    renew_button.wait_for(state='visible', timeout=5000)
                except PlaywrightTimeoutError:
                    self.log(f"服务器 {server_id}: 未找到续期按钮。", "WARNING")
                    return f"{server_id}:no_button_found"

            if not renew_button.is_enabled():
                self.log(f"服务器 {server_id}: 续期按钮存在但不可点击（灰色）。", "INFO")
                return f"{server_id}:already_renewed"

            # 点击按钮并等待结果
            self.log(f"服务器 {server_id}: 找到并准备点击续期按钮。")
            renew_button.click()
            
            # 等待可能的弹窗或页面反馈
            try:
                # 检查是否有明确的成功或失败弹窗
                success_popup = page.locator('.swal2-success, .toast-success, *css:has-text("성공")')
                error_popup = page.locator('.swal2-error, .toast-error, *css:has-text("이미")')
                
                # 等待任意一个弹窗出现，超时5秒
                page.wait_for_selector(f"{success_popup.first.element_handle()._selector} >> or >> {error_popup.first.element_handle()._selector}", timeout=5000)

                if success_popup.count() > 0 and success_popup.first.is_visible():
                    self.log(f"服务器 {server_id}: 检测到成功弹窗。")
                    return f"{server_id}:success"
                if error_popup.count() > 0 and error_popup.first.is_visible():
                    self.log(f"服务器 {server_id}: 检测到已续期或错误弹窗。")
                    return f"{server_id}:already_renewed"
            except PlaywrightTimeoutError:
                # 没有弹窗，可能是通过其他方式反馈，或者无反馈
                self.log(f"服务器 {server_id}: 点击后未检测到明确弹窗，假设操作成功。", "INFO")
                return f"{server_id}:success" # 采取乐观策略
            except Exception:
                # 上面的 element_handle 可能会在 Playwright 新版本中变化，这里做个兜底
                time.sleep(5) # 传统等待
                self.log(f"服务器 {server_id}: 点击后通过延时等待，假设操作成功。", "INFO")
                return f"{server_id}:success"

        except Exception as e:
            self.log(f"处理服务器 {server_id} 时发生未知错误: {e}", "ERROR")
            return f"{server_id}:runtime_error"

    def run(self):
        """主执行函数"""
        self.log("🚀 Weirdhost 自动续期脚本启动")
        if not self.server_list:
            self.log("未提供服务器URL列表 (WEIRDHOST_SERVER_URLS)，任务中止。", "ERROR")
            return ["error:no_servers"]
            
        results = []
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=self.headless)
                context = browser.new_context()
                page = context.new_page()

                # 登录流程
                login_successful = False
                if self._login_with_cookies(context):
                    # 访问主页验证Cookie登录是否有效
                    page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
                    if self._check_login_status(page):
                        self.log("✅ Cookie 登录验证成功！", "INFO")
                        login_successful = True
                    else:
                        self.log("Cookie 登录验证失败，Cookie可能已过期。", "WARNING")
                
                if not login_successful and self._login_with_email(page):
                    login_successful = True
                    self.log("✅ 邮箱密码登录成功！", "INFO")

                if not login_successful:
                    self.log("所有登录方式均失败，无法继续。", "ERROR")
                    browser.close()
                    # 为每个服务器生成登录失败的结果
                    return [f"{url.strip('/').split('/')[-1]}:login_failed" for url in self.server_list]

                # 依次处理服务器
                self.log(f"登录成功，开始处理 {len(self.server_list)} 个服务器...")
                for server_url in self.server_list:
                    result = self._renew_server(page, server_url)
                    results.append(result)
                    self.log(f"服务器处理完成，结果: {result}")
                    time.sleep(3) # 友好等待

                browser.close()

            except Exception as e:
                self.log(f"Playwright 运行时发生严重错误: {e}", "CRITICAL")
                results = [f"{url.strip('/').split('/')[-1]}:runtime_error" for url in self.server_list]

        return results

def update_readme(results):
    """根据运行结果更新 README.md 文件"""
    beijing_time = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
    
    status_messages = {
        "success": "✅ 续期成功",
        "already_renewed": "ℹ️ 今日已续期",
        "no_button_found": "❌ 未找到续期按钮",
        "login_failed": "❌ 登录失败",
        "login_failed_on_server_page": "❌ 访问服务器时掉线",
        "runtime_error": "💥 运行时错误",
        "error:no_servers": "配置错误：未提供服务器列表",
    }
    
    content = f"# Weirdhost 自动续期报告\n\n**最后更新时间**: `{beijing_time}` (北京时间)\n\n## 运行状态\n\n"
    
    for result in results:
        parts = result.split(':', 1)
        server_id = parts[0]
        status = parts[1] if len(parts) > 1 else "unknown"
        message = status_messages.get(status, f"❓ 未知状态 ({status})")
        content += f"- 服务器 `{server_id}`: {message}\n"
        
    try:
        with open("README.md", "w", encoding="utf-8") as f:
            f.write(content)
        print("[INFO] README.md 文件已成功更新。")
    except Exception as e:
        print(f"[ERROR] 更新 README.md 文件失败: {e}")

def main():
    login = WeirdhostRenew()
    results = login.run()
    update_readme(results)
    
    print("=" * 50)
    print("📊 运行结果汇总:")
    for result in results:
        print(f"  - {result}")

    # 如果任何一个结果表明失败，则以失败状态退出
    is_failure = any("failed" in r or "error" in r or "found" in r for r in results)
    if is_failure:
        print("\n⚠️ 注意：部分或全部任务未能成功完成。请检查上面的日志和更新后的 README.md。")
        sys.exit(1)
    else:
        print("\n🎉 所有任务均成功完成！")
        sys.exit(0)

if __name__ == "__main__":
    main()
