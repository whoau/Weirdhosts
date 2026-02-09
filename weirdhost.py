#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - GitHub Actions 版本
整合版: CF防护处理 + 反检测 + 多服务器支持 + 详细状态报告
"""

import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


# ==================== 常量配置 ====================
COOKIE_NAME = "remember_web_59ba36addc2b2f9401580f014c7f58ea4e30989d"
SESSION_COOKIE_NAME = "pterodactyl_session"
COOKIE_DOMAIN = "hub.weirdhost.xyz"
BUTTON_TEXT_PRIMARY = "시간 추가"
BUTTON_TEXT_ALT = "시간추가"
SCREENSHOT_DIR = "screenshots"
CF_WAIT_TIMEOUT = 120
DEFAULT_TIMEOUT = 90000
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/137.0.0.0 Safari/537.36"
)

# 状态常量
STATUS_SUCCESS = "success"
STATUS_ALREADY_RENEWED = "already_renewed"
STATUS_NO_BUTTON = "no_button_found"
STATUS_LOGIN_FAILED = "login_failed"
STATUS_LOGIN_LOST = "login_lost_on_server"
STATUS_CF_BLOCKED = "cf_blocked"
STATUS_RUNTIME_ERROR = "runtime_error"
STATUS_NAV_FAILED = "nav_failed"
STATUS_NO_SERVERS = "no_servers"


class WeirdhostRenew:
    """Weirdhost 自动续期主类"""

    def __init__(self):
        """初始化，从环境变量读取配置"""
        self.url = os.getenv('WEIRDHOST_URL', 'https://hub.weirdhost.xyz')
        self.login_url = f"{self.url}/auth/login"
        self.server_urls_str = os.getenv('WEIRDHOST_SERVER_URLS', '')

        # --- 认证信息 ---
        self.remember_web_cookie = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
        self.pterodactyl_session = os.getenv('PTERODACTYL_SESSION', '').strip()
        self.email = os.getenv('WEIRDHOST_EMAIL', '') or os.getenv('PTERODACTYL_EMAIL', '')
        self.password = os.getenv('WEIRDHOST_PASSWORD', '') or os.getenv('PTERODACTYL_PASSWORD', '')
        self.email = self.email.strip()
        self.password = self.password.strip()

        self.headless = os.getenv('HEADLESS', 'false').lower() == 'true'
        self.server_list = [u.strip() for u in self.server_urls_str.split(',') if u.strip()]

        self.browser = None
        self.context = None
        self.page = None

    # ==================== 日志与调试 ====================

    def log(self, message, level="INFO"):
        """格式化日志输出"""
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        icons = {
            "INFO": "ℹ️",
            "SUCCESS": "✅",
            "WARNING": "⚠️",
            "ERROR": "❌",
            "CRITICAL": "💥",
            "DEBUG": "🔍",
        }
        icon = icons.get(level.upper(), "  ")
        print(f"[{timestamp}] {icon} [{level.upper()}] {message}")

    def save_screenshot(self, page, name):
        """保存截图"""
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            path = os.path.join(SCREENSHOT_DIR, f"{name}.png")
            page.screenshot(path=path, full_page=True)
            self.log(f"截图已保存: {path}", "DEBUG")
        except Exception as e:
            self.log(f"截图保存失败: {e}", "WARNING")

    def save_debug_info(self, page, name):
        """保存完整调试信息：截图 + HTML + URL"""
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            self.save_screenshot(page, name)
            html_path = os.path.join(SCREENSHOT_DIR, f"{name}.html")
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(page.content())
            self.log(f"调试信息 | URL: {page.url} | 标题: {page.title()}", "DEBUG")
        except Exception as e:
            self.log(f"保存调试信息失败: {e}", "WARNING")

    # ==================== CF 防护处理 ====================

    def _is_cf_challenge(self, page):
        """检测当前页面是否为 Cloudflare Challenge"""
        try:
            title = page.title().lower()
            cf_titles = [
                "just a moment", "attention required",
                "checking your browser", "please wait",
                "one more step", "verify you are human",
            ]
            if any(kw in title for kw in cf_titles):
                return True

            # 检查页面内容
            try:
                body = page.locator("body").inner_text(timeout=3000).lower()
                cf_keywords = [
                    "checking your browser", "this process is automatic",
                    "redirected shortly", "enable javascript",
                    "cloudflare", "ray id",
                ]
                if sum(1 for kw in cf_keywords if kw in body) >= 2:
                    return True
            except Exception:
                pass

            # 检查 Turnstile iframe
            try:
                if page.locator('iframe[src*="challenges.cloudflare.com"]').count() > 0:
                    return True
            except Exception:
                pass

            # 检查 challenge 表单
            try:
                if page.locator("#challenge-form, #challenge-running").count() > 0:
                    return True
            except Exception:
                pass

            return False
        except Exception:
            return False

    def _wait_for_cf(self, page, timeout=CF_WAIT_TIMEOUT):
        """等待 CF Challenge 自动通过"""
        self.log("检测 Cloudflare 防护...")
        start = time.time()
        was_challenged = False

        while time.time() - start < timeout:
            if self._is_cf_challenge(page):
                was_challenged = True
                elapsed = int(time.time() - start)
                self.log(f"CF Challenge 进行中... ({elapsed}/{timeout}秒)", "WARNING")

                # 尝试点击 Turnstile
                try:
                    frame = page.frame_locator('iframe[src*="challenges.cloudflare.com"]')
                    cb = frame.locator('input[type="checkbox"], .ctp-checkbox-label')
                    if cb.count() > 0:
                        self.log("发现 Turnstile 复选框，尝试点击...", "INFO")
                        cb.first.click(timeout=5000)
                        time.sleep(3)
                except Exception:
                    pass

                time.sleep(3)
                continue
            else:
                if was_challenged:
                    self.log(f"CF Challenge 已通过！耗时 {int(time.time()-start)} 秒", "SUCCESS")
                else:
                    self.log("未检测到 CF 防护，直接通过。", "INFO")
                return True

        self.log(f"CF Challenge 在 {timeout} 秒内未通过！", "ERROR")
        self.save_debug_info(page, "cf_timeout")
        return False

    # ==================== 反检测 ====================

    def _apply_stealth(self, page):
        """应用反检测措施"""
        try:
            from playwright_stealth import stealth_sync
            stealth_sync(page)
            self.log("playwright-stealth 反检测已应用。", "INFO")
            return
        except ImportError:
            self.log("playwright-stealth 未安装，使用手动反检测。", "WARNING")

        stealth_js = """
        () => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR','ko','en-US','en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
            const origQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (p) => (
                p.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(p)
            );
        }
        """
        page.add_init_script(stealth_js)
        self.log("手动反检测脚本已注入。", "INFO")

    # ==================== 浏览器初始化 ====================

    def _create_browser(self, pw):
        """创建浏览器实例和上下文"""
        self.log(f"启动浏览器 (headless={self.headless})...")

        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-infobars",
            "--window-size=1920,1080",
            "--lang=ko-KR",
        ]

        self.browser = pw.chromium.launch(headless=self.headless, args=launch_args)

        self.context = self.browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR",
            timezone_id="Asia/Seoul",
            color_scheme="light",
            extra_http_headers={
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "Accept-Encoding": "gzip, deflate, br",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
            },
        )

        self.page = self.context.new_page()
        self.page.set_default_timeout(DEFAULT_TIMEOUT)
        self._apply_stealth(self.page)
        self.log("浏览器初始化完成。", "SUCCESS")

    # ==================== 登录逻辑 ====================

    def _check_login_status(self, page):
        """检查是否已登录"""
        current_url = page.url.lower()

        # 在登录页 → 未登录
        if "/auth/login" in current_url:
            self.log("当前在登录页，状态：未登录。", "DEBUG")
            return False

        # 查找登出按钮等已登录标志
        try:
            markers = page.locator(
                'a[href*="auth/logout"], '
                'button:has-text("Logout"), '
                'button:has-text("로그아웃"), '
                '[data-attr="controlConsole"]'
            )
            if markers.count() > 0:
                self.log("找到已登录标志元素。", "DEBUG")
                return True
        except Exception:
            pass

        # 不在登录页，默认认为已登录
        if "/auth/" not in current_url:
            self.log(f"不在登录页 (URL: {page.url})，假设已登录。", "DEBUG")
            return True

        return False

    def _login_with_cookies(self):
        """使用 Cookie 登录"""
        if not self.remember_web_cookie:
            self.log("未提供 REMEMBER_WEB_COOKIE，跳过 Cookie 登录。", "DEBUG")
            return False

        self.log("尝试使用 Cookie 登录...", "INFO")

        cookies_to_add = [{
            "name": COOKIE_NAME,
            "value": self.remember_web_cookie,
            "domain": COOKIE_DOMAIN,
            "path": "/",
            "expires": int(time.time()) + 86400 * 365,
            "httpOnly": True,
            "secure": True,
            "sameSite": "Lax",
        }]

        if self.pterodactyl_session:
            cookies_to_add.append({
                "name": SESSION_COOKIE_NAME,
                "value": self.pterodactyl_session,
                "domain": COOKIE_DOMAIN,
                "path": "/",
                "httpOnly": True,
                "secure": True,
                "sameSite": "Lax",
            })
            self.log("同时设置 pterodactyl_session Cookie。", "DEBUG")

        try:
            self.context.add_cookies(cookies_to_add)
            self.log(f"已添加 {len(cookies_to_add)} 个 Cookie。", "INFO")
        except Exception as e:
            self.log(f"设置 Cookie 失败: {e}", "ERROR")
            return False

        # 访问主页验证
        self.log(f"正在访问主页验证 Cookie 有效性: {self.url}")
        try:
            self.page.goto(self.url, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log("主页加载超时，继续验证...", "WARNING")

        # 等待 CF
        if not self._wait_for_cf(self.page):
            self.log("Cookie 登录时 CF 防护未通过。", "ERROR")
            return False

        time.sleep(3)

        if self._check_login_status(self.page):
            self.log("Cookie 登录验证成功！", "SUCCESS")
            return True
        else:
            self.log("Cookie 无效或已过期。", "WARNING")
            self.save_debug_info(self.page, "cookie_login_failed")
            self.context.clear_cookies()
            return False

    def _login_with_email(self):
        """使用邮箱密码登录"""
        if not (self.email and self.password):
            self.log("未提供邮箱密码，跳过密码登录。", "DEBUG")
            return False

        self.log("尝试使用邮箱密码登录...", "INFO")

        try:
            self.page.goto(self.login_url, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log("登录页加载超时。", "WARNING")

        # 等待 CF
        if not self._wait_for_cf(self.page):
            self.log("登录页 CF 防护未通过。", "ERROR")
            return False

        time.sleep(2)

        # 尝试多组选择器
        selector_groups = [
            ('input[name="username"]', 'input[name="password"]', 'button[type="submit"]'),
            ('input[name="email"]', 'input[name="password"]', 'button[type="submit"]'),
            ('input[type="email"]', 'input[type="password"]', 'button[type="submit"]'),
            ('#username', '#password', 'button[type="submit"]'),
        ]

        for i, (email_sel, pass_sel, btn_sel) in enumerate(selector_groups):
            try:
                email_input = self.page.locator(email_sel)
                pass_input = self.page.locator(pass_sel)

                if email_input.count() == 0 or pass_input.count() == 0:
                    continue

                self.log(f"使用选择器组合 {i+1} 填写表单...", "DEBUG")

                email_input.first.wait_for(state="visible", timeout=10000)
                email_input.first.click()
                time.sleep(0.3)
                email_input.first.fill(self.email)
                time.sleep(0.3)

                pass_input.first.click()
                time.sleep(0.3)
                pass_input.first.fill(self.password)
                time.sleep(0.5)

                self.save_screenshot(self.page, "before_login_submit")

                # 提交
                submit_btn = self.page.locator(btn_sel)
                if submit_btn.count() > 0:
                    submit_btn.first.click()
                else:
                    pass_input.first.press("Enter")

                # 等待导航
                try:
                    self.page.wait_for_load_state("domcontentloaded", timeout=30000)
                except PlaywrightTimeoutError:
                    pass

                # 等待可能的 CF
                self._wait_for_cf(self.page, timeout=60)
                time.sleep(3)

                if self._check_login_status(self.page):
                    self.log("邮箱密码登录成功！", "SUCCESS")
                    return True
                else:
                    # 检查错误信息
                    try:
                        err = self.page.locator(".alert-danger, .error, .notification-error")
                        if err.count() > 0:
                            err_text = err.first.inner_text(timeout=3000).strip()
                            self.log(f"登录错误信息: {err_text}", "WARNING")
                    except Exception:
                        pass

            except PlaywrightTimeoutError:
                continue
            except Exception as e:
                self.log(f"选择器组合 {i+1} 出错: {e}", "WARNING")
                continue

        self.log("所有邮箱密码登录尝试均失败。", "ERROR")
        self.save_debug_info(self.page, "email_login_failed")
        return False

    # ==================== 安全导航 ====================

    def _safe_goto(self, page, url, label="页面"):
        """安全导航：访问URL + 等待CF + 验证登录状态"""
        self.log(f"正在导航到{label}: {url}")

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log(f"{label}加载超时，继续尝试...", "WARNING")
            self.save_screenshot(page, f"goto_timeout_{label}")

        if not self._wait_for_cf(page):
            self.log(f"{label} CF 防护未通过。", "ERROR")
            return False

        time.sleep(2)

        if not self._check_login_status(page):
            self.log(f"访问{label}时发现未登录！", "ERROR")
            self.save_debug_info(page, f"login_lost_{label}")
            return False

        return True

    # ==================== 核心续期逻辑 ====================

    def _renew_server(self, page, server_url):
        """对单个服务器执行续期"""
        server_id = server_url.strip('/').split('/')[-1]
        self.log(f"{'='*50}")
        self.log(f"开始处理服务器: {server_id}")
        self.log(f"URL: {server_url}")

        # 导航到服务器页面
        if not self._safe_goto(page, server_url, f"服务器_{server_id}"):
            # 区分 CF 拦截和登录丢失
            if self._is_cf_challenge(page):
                return f"{server_id}:{STATUS_CF_BLOCKED}"
            if not self._check_login_status(page):
                return f"{server_id}:{STATUS_LOGIN_LOST}"
            return f"{server_id}:{STATUS_NAV_FAILED}"

        # 等待页面完全加载
        try:
            page.wait_for_load_state("networkidle", timeout=30000)
        except PlaywrightTimeoutError:
            self.log("等待 networkidle 超时，继续...", "WARNING")

        time.sleep(2)
        self.save_screenshot(page, f"server_{server_id}_loaded")

        # ---- 查找续期按钮 ----
        button_found = False
        renew_button = None

        # 按优先级尝试多种选择器
        button_selectors = [
            f'button:has-text("{BUTTON_TEXT_PRIMARY}")',
            f'button:has-text("{BUTTON_TEXT_ALT}")',
            f'a:has-text("{BUTTON_TEXT_PRIMARY}")',
            f'a:has-text("{BUTTON_TEXT_ALT}")',
            f'button:text("{BUTTON_TEXT_PRIMARY}")',
            f'//*[contains(text(), "{BUTTON_TEXT_PRIMARY}")]',
        ]

        for sel in button_selectors:
            try:
                loc = page.locator(sel)
                if loc.count() > 0:
                    for idx in range(loc.count()):
                        el = loc.nth(idx)
                        if el.is_visible(timeout=3000):
                            renew_button = el
                            button_found = True
                            self.log(f"找到续期按钮 (选择器: {sel})", "SUCCESS")
                            break
                if button_found:
                    break
            except Exception:
                continue

        if not button_found:
            self.log(f"服务器 {server_id}: 未找到续期按钮！", "ERROR")
            self.save_debug_info(page, f"no_button_{server_id}")
            # 列出页面上所有按钮帮助调试
            self._list_page_buttons(page)
            return f"{server_id}:{STATUS_NO_BUTTON}"

        # 检查按钮是否可点击
        try:
            if not renew_button.is_enabled(timeout=3000):
                self.log(f"服务器 {server_id}: 续期按钮存在但不可点击（可能已续期）。", "WARNING")
                self.save_screenshot(page, f"button_disabled_{server_id}")
                return f"{server_id}:{STATUS_ALREADY_RENEWED}"
        except Exception:
            pass

        # ---- 点击续期按钮 ----
        self.log(f"服务器 {server_id}: 点击续期按钮...", "INFO")
        try:
            renew_button.scroll_into_view_if_needed(timeout=5000)
            time.sleep(0.5)
            renew_button.click(timeout=10000)
            self.log(f"服务器 {server_id}: 续期按钮已点击！", "SUCCESS")
        except Exception as e:
            self.log(f"服务器 {server_id}: 点击按钮失败: {e}", "ERROR")
            self.save_debug_info(page, f"click_failed_{server_id}")
            return f"{server_id}:{STATUS_RUNTIME_ERROR}"

        # ---- 检测点击后的反馈 ----
        time.sleep(3)
        result_status = self._detect_click_result(page, server_id)
        self.save_screenshot(page, f"after_click_{server_id}")

        # 处理可能的确认弹窗
        self._handle_confirm_dialog(page, server_id)

        return f"{server_id}:{result_status}"

    def _detect_click_result(self, page, server_id):
        """检测点击续期按钮后的结果"""
        try:
            # 检查成功提示
            success_selectors = [
                '.swal2-success',
                '.toast-success',
                '.alert-success',
                'div:has-text("성공")',
                'div:has-text("success")',
                'div:has-text("완료")',
            ]
            for sel in success_selectors:
                try:
                    el = page.locator(sel)
                    if el.count() > 0 and el.first.is_visible(timeout=2000):
                        msg = el.first.inner_text(timeout=2000).strip()[:100]
                        self.log(f"服务器 {server_id}: 检测到成功提示 → '{msg}'", "SUCCESS")
                        return STATUS_SUCCESS
                except Exception:
                    continue

            # 检查"已续期"提示
            already_selectors = [
                'div:has-text("이미")',
                'div:has-text("already")',
                '.swal2-warning',
            ]
            for sel in already_selectors:
                try:
                    el = page.locator(sel)
                    if el.count() > 0 and el.first.is_visible(timeout=2000):
                        msg = el.first.inner_text(timeout=2000).strip()[:100]
                        self.log(f"服务器 {server_id}: 检测到已续期提示 → '{msg}'", "WARNING")
                        return STATUS_ALREADY_RENEWED
                except Exception:
                    continue

            # 检查错误提示
            error_selectors = [
                '.swal2-error',
                '.toast-error',
                '.alert-danger',
                'div:has-text("실패")',
                'div:has-text("error")',
            ]
            for sel in error_selectors:
                try:
                    el = page.locator(sel)
                    if el.count() > 0 and el.first.is_visible(timeout=2000):
                        msg = el.first.inner_text(timeout=2000).strip()[:100]
                        self.log(f"服务器 {server_id}: 检测到错误提示 → '{msg}'", "ERROR")
                        return STATUS_RUNTIME_ERROR
                except Exception:
                    continue

        except Exception as e:
            self.log(f"检测点击结果时出错: {e}", "WARNING")

        # 没有检测到明确提示，乐观假设成功
        self.log(f"服务器 {server_id}: 未检测到明确弹窗反馈，假设操作成功。", "INFO")
        return STATUS_SUCCESS

    def _handle_confirm_dialog(self, page, server_id):
        """处理可能出现的确认弹窗"""
        confirm_texts = ["확인", "OK", "Confirm", "Yes", "예", "닫기", "Close"]
        for text in confirm_texts:
            try:
                btn = page.locator(f'button:has-text("{text}")')
                if btn.count() > 0 and btn.first.is_visible(timeout=2000):
                    self.log(f"服务器 {server_id}: 点击确认按钮 '{text}'", "DEBUG")
                    btn.first.click(timeout=5000)
                    time.sleep(1)
                    return
            except Exception:
                continue

    def _list_page_buttons(self, page):
        """列出页面上所有按钮用于调试"""
        try:
            all_btns = page.locator("button, a.btn, input[type='submit'], input[type='button']")
            count = all_btns.count()
            self.log(f"[调试] 页面上共有 {count} 个按钮:", "DEBUG")
            for i in range(min(count, 20)):
                try:
                    btn = all_btns.nth(i)
                    text = btn.inner_text(timeout=2000).strip().replace('\n', ' ')[:80]
                    visible = btn.is_visible(timeout=2000)
                    enabled = btn.is_enabled(timeout=2000)
                    self.log(f"  按钮[{i}]: text='{text}' | visible={visible} | enabled={enabled}", "DEBUG")
                except Exception:
                    pass
        except Exception:
            pass

    # ==================== 主执行流程 ====================

    def run(self):
        """主执行函数"""
        self.log("🚀 Weirdhost 自动续期脚本启动")
        self.log(f"{'='*60}")

        # 打印配置摘要
        has_cookie = bool(self.remember_web_cookie)
        has_session = bool(self.pterodactyl_session)
        has_creds = bool(self.email and self.password)

        self.log(f"目标站点:      {self.url}")
        self.log(f"Cookie 登录:   {'✅ 已配置' if has_cookie else '❌ 未配置'}")
        self.log(f"Session Cookie: {'✅ 已配置' if has_session else '❌ 未配置'}")
        self.log(f"密码登录:      {'✅ 已配置' if has_creds else '❌ 未配置'}")
        self.log(f"服务器数量:    {len(self.server_list)}")
        self.log(f"无头模式:      {self.headless}")

        if not self.server_list:
            self.log("未提供服务器URL列表 (WEIRDHOST_SERVER_URLS)！", "ERROR")
            self.log("请设置环境变量，例如:", "ERROR")
            self.log("  WEIRDHOST_SERVER_URLS=https://hub.weirdhost.xyz/server/abc123", "ERROR")
            return [f"none:{STATUS_NO_SERVERS}"]

        if not (has_cookie or has_creds):
            self.log("未提供任何登录凭据！请设置:", "ERROR")
            self.log("  REMEMBER_WEB_COOKIE 或", "ERROR")
            self.log("  WEIRDHOST_EMAIL + WEIRDHOST_PASSWORD", "ERROR")
            return [f"{u.strip('/').split('/')[-1]}:{STATUS_LOGIN_FAILED}" for u in self.server_list]

        results = []

        with sync_playwright() as pw:
            try:
                self._create_browser(pw)

                # ---- 登录流程 ----
                login_ok = False

                # 方案一：Cookie 登录
                if has_cookie:
                    login_ok = self._login_with_cookies()

                # 方案二：邮箱密码登录
                if not login_ok and has_creds:
                    login_ok = self._login_with_email()

                if not login_ok:
                    self.log("所有登录方式均失败，无法继续。", "CRITICAL")
                    self.save_debug_info(self.page, "all_login_failed")
                    self.browser.close()
                    return [f"{u.strip('/').split('/')[-1]}:{STATUS_LOGIN_FAILED}" for u in self.server_list]

                self.log(f"{'='*50}")
                self.log(f"登录成功！开始处理 {len(self.server_list)} 个服务器...")
                self.log(f"{'='*50}")

                # ---- 依次处理每个服务器 ----
                for idx, server_url in enumerate(self.server_list, 1):
                    self.log(f"\n📦 [{idx}/{len(self.server_list)}] 处理中...")
                    result = self._renew_server(self.page, server_url)
                    results.append(result)
                    self.log(f"📦 [{idx}/{len(self.server_list)}] 结果: {result}")

                    # 服务器之间友好等待
                    if idx < len(self.server_list):
                        self.log("等待 5 秒后处理下一个服务器...", "DEBUG")
                        time.sleep(5)

                self.browser.close()
                self.log("浏览器已关闭。", "DEBUG")

            except Exception as e:
                self.log(f"运行时发生严重错误: {e}", "CRITICAL")
                traceback.print_exc()
                if self.page:
                    self.save_debug_info(self.page, "fatal_error")
                if self.browser:
                    self.browser.close()

                if not results:
                    results = [f"{u.strip('/').split('/')[-1]}:{STATUS_RUNTIME_ERROR}" for u in self.server_list]

        return results


# ==================== 结果报告 ====================

def print_summary(results):
    """打印美观的结果汇总"""
    status_display = {
        STATUS_SUCCESS:         ("✅", "续期成功"),
        STATUS_ALREADY_RENEWED: ("ℹ️ ", "今日已续期/按钮不可用"),
        STATUS_NO_BUTTON:       ("❌", "未找到续期按钮"),
        STATUS_LOGIN_FAILED:    ("❌", "登录失败"),
        STATUS_LOGIN_LOST:      ("❌", "访问服务器时登录丢失"),
        STATUS_CF_BLOCKED:      ("🛡️", "被 CF 防护拦截"),
        STATUS_NAV_FAILED:      ("❌", "页面导航失败"),
        STATUS_RUNTIME_ERROR:   ("💥", "运行时错误"),
        STATUS_NO_SERVERS:      ("⚙️", "未配置服务器列表"),
    }

    print("\n" + "=" * 60)
    print("📊  运  行  结  果  汇  总")
    print("=" * 60)

    success_count = 0
    fail_count = 0

    for result in results:
        parts = result.split(':', 1)
        server_id = parts[0] if len(parts) > 0 else "unknown"
        status = parts[1] if len(parts) > 1 else "unknown"

        icon, desc = status_display.get(status, ("❓", f"未知状态({status})"))
        print(f"  {icon}  服务器 [{server_id}]: {desc}")

        if status in (STATUS_SUCCESS, STATUS_ALREADY_RENEWED):
            success_count += 1
        else:
            fail_count += 1

    print("-" * 60)
    print(f"  合计: {len(results)} 个服务器 | ✅ 成功: {success_count} | ❌ 失败: {fail_count}")
    print("=" * 60)

    return fail_count == 0


def update_readme(results):
    """更新 README.md 文件"""
    beijing_time = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')

    status_messages = {
        STATUS_SUCCESS:         "✅ 续期成功",
        STATUS_ALREADY_RENEWED: "ℹ️ 今日已续期 / 按钮不可用",
        STATUS_NO_BUTTON:       "❌ 未找到续期按钮",
        STATUS_LOGIN_FAILED:    "❌ 登录失败",
        STATUS_LOGIN_LOST:      "❌ 访问服务器时登录丢失",
        STATUS_CF_BLOCKED:      "🛡️ 被 Cloudflare 防护拦截",
        STATUS_NAV_FAILED:      "❌ 页面导航失败",
        STATUS_RUNTIME_ERROR:   "💥 运行时错误",
        STATUS_NO_SERVERS:      "⚙️ 未配置服务器列表",
    }

    content = "# Weirdhost 自动续期报告\n\n"
    content += f"**最后运行时间**: `{beijing_time}` (北京时间)\n\n"
    content += "## 服务器状态\n\n"
    content += "| 服务器 ID | 状态 |\n"
    content += "|-----------|------|\n"

    for result in results:
        parts = result.split(':', 1)
        server_id = parts[0] if len(parts) > 0 else "unknown"
        status = parts[1] if len(parts) > 1 else "unknown"
        message = status_messages.get(status, f"❓ 未知状态 ({status})")
        content += f"| `{server_id}` | {message} |\n"

    content += f"\n---\n*由 GitHub Actions 自动生成*\n"

    try:
        with open("README.md", "w", encoding="utf-8") as f:
            f.write(content)
        print(f"[INFO] README.md 已更新。")
    except Exception as e:
        print(f"[ERROR] 更新 README.md 失败: {e}")


# ==================== 主入口 ====================

def main():
    print("=" * 60)
    print("  🔄  Weirdhost 自动续期脚本")
    print(f"  🕐  启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"  🐍  Python: {sys.version.split()[0]}")
    print("=" * 60)

    renewer = WeirdhostRenew()
    results = renewer.run()

    # 打印汇总
    all_ok = print_summary(results)

    # 更新 README
    update_readme(results)

    # 退出码
    if all_ok:
        print("\n🎉 所有任务均成功完成！")
        sys.exit(0)
    else:
        print("\n⚠️  部分或全部任务未成功，请检查日志和截图。")
        sys.exit(1)


if __name__ == "__main__":
    main()
