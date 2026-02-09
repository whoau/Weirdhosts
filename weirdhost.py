#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Weirdhost 自动续期脚本 - GitHub Actions 版本
整合版: CF防护处理 + 反检测 + 详细状态报告
服务器URL通过环境变量 WEIRDHOST_SERVER_URLS 配置
"""

import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


# ==================== 基础配置（不含任何服务器参数） ====================
BASE_URL = "https://hub.weirdhost.xyz"
LOGIN_URL = f"{BASE_URL}/auth/login"
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


class WeirdhostRenew:
    def __init__(self):
        # 所有配置从环境变量读取，代码中不含任何服务器具体参数
        self.remember_web_cookie = os.getenv('REMEMBER_WEB_COOKIE', '').strip()
        self.pterodactyl_session = os.getenv('PTERODACTYL_SESSION', '').strip()
        self.email = (os.getenv('WEIRDHOST_EMAIL', '') or os.getenv('PTERODACTYL_EMAIL', '')).strip()
        self.password = (os.getenv('WEIRDHOST_PASSWORD', '') or os.getenv('PTERODACTYL_PASSWORD', '')).strip()
        self.headless = os.getenv('HEADLESS', 'false').lower() == 'true'

        # 服务器URL列表，从环境变量读取，逗号分隔
        urls_str = os.getenv('WEIRDHOST_SERVER_URLS', '').strip()
        self.server_list = [u.strip() for u in urls_str.split(',') if u.strip()]

        self.browser = None
        self.context = None
        self.page = None

    # ==================== 日志 ====================

    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        icons = {
            "INFO": "ℹ️", "SUCCESS": "✅", "WARNING": "⚠️",
            "ERROR": "❌", "CRITICAL": "💥", "DEBUG": "🔍",
        }
        print(f"[{timestamp}] {icons.get(level, '  ')} [{level}] {message}")

    def save_screenshot(self, name):
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            path = os.path.join(SCREENSHOT_DIR, f"{name}.png")
            self.page.screenshot(path=path, full_page=True)
            self.log(f"截图已保存: {path}", "DEBUG")
        except Exception as e:
            self.log(f"截图失败: {e}", "WARNING")

    def save_debug_info(self, name):
        try:
            os.makedirs(SCREENSHOT_DIR, exist_ok=True)
            self.save_screenshot(name)
            with open(os.path.join(SCREENSHOT_DIR, f"{name}.html"), "w", encoding="utf-8") as f:
                f.write(self.page.content())
            self.log(f"URL: {self.page.url} | 标题: {self.page.title()}", "DEBUG")
        except Exception as e:
            self.log(f"保存调试信息失败: {e}", "WARNING")

    # ==================== CF 防护处理 ====================

    def _is_cf_challenge(self):
        try:
            title = self.page.title().lower()
            if any(kw in title for kw in [
                "just a moment", "attention required", "checking your browser",
                "please wait", "one more step", "verify you are human",
            ]):
                return True

            try:
                body = self.page.locator("body").inner_text(timeout=3000).lower()
                cf_kw = ["checking your browser", "this process is automatic",
                         "redirected shortly", "enable javascript", "cloudflare", "ray id"]
                if sum(1 for kw in cf_kw if kw in body) >= 2:
                    return True
            except Exception:
                pass

            try:
                if self.page.locator('iframe[src*="challenges.cloudflare.com"]').count() > 0:
                    return True
            except Exception:
                pass

            try:
                if self.page.locator("#challenge-form, #challenge-running").count() > 0:
                    return True
            except Exception:
                pass

            return False
        except Exception:
            return False

    def _wait_for_cf(self, timeout=CF_WAIT_TIMEOUT):
        self.log("检测 Cloudflare 防护...")
        start = time.time()
        was_challenged = False

        while time.time() - start < timeout:
            if self._is_cf_challenge():
                was_challenged = True
                self.log(f"CF Challenge 进行中... ({int(time.time()-start)}/{timeout}秒)", "WARNING")

                try:
                    frame = self.page.frame_locator('iframe[src*="challenges.cloudflare.com"]')
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
                    self.log("未检测到 CF 防护。", "INFO")
                return True

        self.log(f"CF Challenge 在 {timeout} 秒内未通过！", "ERROR")
        self.save_debug_info("cf_timeout")
        return False

    # ==================== 反检测 ====================

    def _apply_stealth(self):
        try:
            from playwright_stealth import stealth_sync
            stealth_sync(self.page)
            self.log("playwright-stealth 已应用。", "INFO")
            return
        except ImportError:
            self.log("playwright-stealth 未安装，使用手动注入。", "WARNING")

        self.page.add_init_script("""() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR','ko','en-US','en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
        }""")
        self.log("手动反检测已注入。", "INFO")

    # ==================== 浏览器 ====================

    def _create_browser(self, pw):
        self.log(f"启动浏览器 (headless={self.headless})...")
        self.browser = pw.chromium.launch(
            headless=self.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-infobars", "--window-size=1920,1080", "--lang=ko-KR",
            ],
        )
        self.context = self.browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR", timezone_id="Asia/Seoul", color_scheme="light",
            extra_http_headers={
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
            },
        )
        self.page = self.context.new_page()
        self.page.set_default_timeout(DEFAULT_TIMEOUT)
        self._apply_stealth()
        self.log("浏览器初始化完成。", "SUCCESS")

    # ==================== 登录状态 ====================

    def _check_login_status(self):
        url = self.page.url.lower()
        if "/auth/login" in url:
            return False
        try:
            markers = self.page.locator(
                'a[href*="auth/logout"], button:has-text("Logout"), button:has-text("로그아웃")')
            if markers.count() > 0:
                return True
        except Exception:
            pass
        return "/auth/" not in url

    # ==================== Cookie 登录 ====================

    def _login_with_cookies(self):
        if not self.remember_web_cookie:
            return False

        self.log("尝试 Cookie 登录...", "INFO")
        cookies = [{
            "name": COOKIE_NAME, "value": self.remember_web_cookie,
            "domain": COOKIE_DOMAIN, "path": "/",
            "expires": int(time.time()) + 86400 * 365,
            "httpOnly": True, "secure": True, "sameSite": "Lax",
        }]
        if self.pterodactyl_session:
            cookies.append({
                "name": SESSION_COOKIE_NAME, "value": self.pterodactyl_session,
                "domain": COOKIE_DOMAIN, "path": "/",
                "httpOnly": True, "secure": True, "sameSite": "Lax",
            })

        try:
            self.context.add_cookies(cookies)
        except Exception as e:
            self.log(f"设置 Cookie 失败: {e}", "ERROR")
            return False

        try:
            self.page.goto(BASE_URL, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log("主页加载超时，继续...", "WARNING")

        if not self._wait_for_cf():
            return False

        time.sleep(3)
        if self._check_login_status():
            self.log("Cookie 登录成功！", "SUCCESS")
            return True

        self.log("Cookie 无效或已过期。", "WARNING")
        self.save_debug_info("cookie_failed")
        self.context.clear_cookies()
        return False

    # ==================== 邮箱密码登录 ====================

    def _login_with_email(self):
        if not (self.email and self.password):
            return False

        self.log("尝试邮箱密码登录...", "INFO")
        try:
            self.page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log("登录页超时。", "WARNING")

        if not self._wait_for_cf():
            return False

        time.sleep(2)
        for i, (e_sel, p_sel) in enumerate([
            ('input[name="username"]', 'input[name="password"]'),
            ('input[name="email"]',    'input[name="password"]'),
            ('input[type="email"]',    'input[type="password"]'),
            ('#username',              '#password'),
        ]):
            try:
                e_in = self.page.locator(e_sel)
                p_in = self.page.locator(p_sel)
                if e_in.count() == 0 or p_in.count() == 0:
                    continue

                e_in.first.wait_for(state="visible", timeout=10000)
                e_in.first.click(); time.sleep(0.3)
                e_in.first.fill(self.email); time.sleep(0.3)
                p_in.first.click(); time.sleep(0.3)
                p_in.first.fill(self.password); time.sleep(0.5)

                sub = self.page.locator('button[type="submit"]')
                if sub.count() > 0:
                    sub.first.click()
                else:
                    p_in.first.press("Enter")

                try:
                    self.page.wait_for_load_state("domcontentloaded", timeout=30000)
                except PlaywrightTimeoutError:
                    pass

                self._wait_for_cf(timeout=60)
                time.sleep(3)

                if self._check_login_status():
                    self.log("邮箱密码登录成功！", "SUCCESS")
                    return True
            except Exception as e:
                self.log(f"选择器组合 {i+1} 出错: {e}", "WARNING")
                continue

        self.log("邮箱密码登录失败。", "ERROR")
        self.save_debug_info("email_login_failed")
        return False

    # ==================== 单个服务器续期 ====================

    def _renew_server(self, server_url):
        server_id = server_url.strip('/').split('/')[-1]
        self.log(f"{'—'*40}")
        self.log(f"开始处理: {server_id}")

        # 导航
        try:
            self.page.goto(server_url, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        except PlaywrightTimeoutError:
            self.log(f"[{server_id}] 页面加载超时，继续...", "WARNING")

        if not self._wait_for_cf():
            return server_id, "cf_blocked"

        time.sleep(2)
        if not self._check_login_status():
            self.log(f"[{server_id}] 登录丢失！", "ERROR")
            self.save_debug_info(f"login_lost_{server_id}")
            return server_id, "login_lost"

        try:
            self.page.wait_for_load_state("networkidle", timeout=30000)
        except PlaywrightTimeoutError:
            pass

        time.sleep(2)
        self.save_screenshot(f"loaded_{server_id}")

        # 查找按钮
        renew_button = None
        for sel in [
            f'button:has-text("{BUTTON_TEXT_PRIMARY}")',
            f'button:has-text("{BUTTON_TEXT_ALT}")',
            f'a:has-text("{BUTTON_TEXT_PRIMARY}")',
            f'a:has-text("{BUTTON_TEXT_ALT}")',
        ]:
            try:
                loc = self.page.locator(sel)
                for idx in range(loc.count()):
                    if loc.nth(idx).is_visible(timeout=3000):
                        renew_button = loc.nth(idx)
                        self.log(f"[{server_id}] 找到续期按钮", "SUCCESS")
                        break
                if renew_button:
                    break
            except Exception:
                continue

        if not renew_button:
            self.log(f"[{server_id}] 未找到续期按钮！", "ERROR")
            self.save_debug_info(f"no_button_{server_id}")
            self._list_buttons()
            return server_id, "no_button"

        # 检查可点击
        try:
            if not renew_button.is_enabled(timeout=3000):
                self.log(f"[{server_id}] 按钮不可点击（可能已续期）", "WARNING")
                return server_id, "already_renewed"
        except Exception:
            pass

        # 点击
        try:
            renew_button.scroll_into_view_if_needed(timeout=5000)
            time.sleep(0.5)
            renew_button.click(timeout=10000)
            self.log(f"[{server_id}] 按钮已点击！", "SUCCESS")
        except Exception as e:
            self.log(f"[{server_id}] 点击失败: {e}", "ERROR")
            return server_id, "click_failed"

        # 检测结果
        time.sleep(3)
        result = self._detect_result(server_id)
        self.save_screenshot(f"after_{server_id}")
        self._dismiss_dialog()
        return server_id, result

    def _detect_result(self, server_id):
        for sel_group, status, label in [
            (['.swal2-success', '.toast-success', '.alert-success',
              'div:has-text("성공")', 'div:has-text("완료")'], "success", "成功"),
            (['.swal2-warning', 'div:has-text("이미")', 'div:has-text("already")'],
             "already_renewed", "已续期"),
            (['.swal2-error', '.toast-error', '.alert-danger',
              'div:has-text("실패")'], "error", "错误"),
        ]:
            for sel in sel_group:
                try:
                    el = self.page.locator(sel)
                    if el.count() > 0 and el.first.is_visible(timeout=2000):
                        msg = el.first.inner_text(timeout=2000).strip()[:80]
                        self.log(f"[{server_id}] 检测到{label}提示: '{msg}'",
                                 "SUCCESS" if status == "success" else "WARNING")
                        return status
                except Exception:
                    continue

        self.log(f"[{server_id}] 无明确弹窗，假设成功。", "INFO")
        return "success"

    def _dismiss_dialog(self):
        for text in ["확인", "OK", "Confirm", "Yes", "예", "닫기", "Close"]:
            try:
                btn = self.page.locator(f'button:has-text("{text}")')
                if btn.count() > 0 and btn.first.is_visible(timeout=2000):
                    btn.first.click(timeout=5000)
                    time.sleep(1)
                    return
            except Exception:
                continue

    def _list_buttons(self):
        try:
            btns = self.page.locator("button, a.btn, input[type='submit']")
            count = btns.count()
            self.log(f"页面共 {count} 个按钮:", "DEBUG")
            for i in range(min(count, 15)):
                try:
                    text = btns.nth(i).inner_text(timeout=2000).strip().replace('\n', ' ')[:60]
                    self.log(f"  [{i}] '{text}'", "DEBUG")
                except Exception:
                    pass
        except Exception:
            pass

    # ==================== 主流程 ====================

    def run(self):
        self.log("🚀 Weirdhost 自动续期脚本启动")
        self.log("=" * 55)

        has_cookie = bool(self.remember_web_cookie)
        has_creds = bool(self.email and self.password)

        self.log(f"Cookie 登录: {'✅' if has_cookie else '❌'}")
        self.log(f"密码登录:   {'✅' if has_creds else '❌'}")
        self.log(f"服务器数量: {len(self.server_list)}")
        self.log(f"无头模式:   {self.headless}")
        self.log("=" * 55)

        # 前置检查
        if not self.server_list:
            self.log("未配置 WEIRDHOST_SERVER_URLS！", "CRITICAL")
            return []

        if not (has_cookie or has_creds):
            self.log("未提供任何登录凭据！", "CRITICAL")
            return [(u.strip('/').split('/')[-1], "no_credentials") for u in self.server_list]

        results = []

        with sync_playwright() as pw:
            try:
                self._create_browser(pw)

                # 登录
                login_ok = False
                if has_cookie:
                    login_ok = self._login_with_cookies()
                if not login_ok and has_creds:
                    login_ok = self._login_with_email()

                if not login_ok:
                    self.log("所有登录方式均失败！", "CRITICAL")
                    self.save_debug_info("all_login_failed")
                    self.browser.close()
                    return [(u.strip('/').split('/')[-1], "login_failed") for u in self.server_list]

                # 逐个续期
                self.log(f"登录成功，开始处理 {len(self.server_list)} 个服务器...")

                for idx, url in enumerate(self.server_list, 1):
                    self.log(f"\n📦 [{idx}/{len(self.server_list)}]")
                    sid, status = self._renew_server(url)
                    results.append((sid, status))
                    if idx < len(self.server_list):
                        time.sleep(5)

                self.browser.close()

            except Exception as e:
                self.log(f"严重错误: {e}", "CRITICAL")
                traceback.print_exc()
                if self.page:
                    self.save_debug_info("fatal")
                if self.browser:
                    self.browser.close()
                if not results:
                    results = [(u.strip('/').split('/')[-1], "runtime_error") for u in self.server_list]

        return results


# ==================== 结果展示 ====================

STATUS_DISPLAY = {
    "success":         ("✅", "续期成功"),
    "already_renewed": ("ℹ️ ", "今日已续期"),
    "no_button":       ("❌", "未找到续期按钮"),
    "login_failed":    ("❌", "登录失败"),
    "login_lost":      ("❌", "登录丢失"),
    "cf_blocked":      ("🛡️", "CF 防护拦截"),
    "click_failed":    ("❌", "点击失败"),
    "no_credentials":  ("⚙️", "未配置凭据"),
    "runtime_error":   ("💥", "运行时错误"),
    "error":           ("❌", "服务器返回错误"),
}


def print_summary(results):
    ok_statuses = {"success", "already_renewed"}
    success_count = sum(1 for _, s in results if s in ok_statuses)
    fail_count = len(results) - success_count

    print("\n" + "=" * 55)
    print("  📊  运行结果汇总")
    print("=" * 55)

    if not results:
        print("  ⚠️  没有处理任何服务器（请检查 WEIRDHOST_SERVER_URLS）")
    else:
        for sid, status in results:
            icon, desc = STATUS_DISPLAY.get(status, ("❓", f"未知({status})"))
            print(f"  {icon}  [{sid}] {desc}")

        print("-" * 55)
        print(f"  合计 {len(results)} 台 | ✅ 成功 {success_count} | ❌ 失败 {fail_count}")

    print("=" * 55)
    return fail_count == 0


def update_readme(results):
    beijing = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')

    lines = ["# Weirdhost 自动续期报告\n"]
    lines.append(f"**最后运行**: `{beijing}` (北京时间)\n")
    lines.append("## 状态\n")
    lines.append("| 服务器 | 结果 |")
    lines.append("|--------|------|")

    if not results:
        lines.append("| - | ⚠️ 无服务器配置 |")
    else:
        for sid, status in results:
            icon, desc = STATUS_DISPLAY.get(status, ("❓", f"未知({status})"))
            lines.append(f"| `{sid}` | {icon} {desc} |")

    lines.append("\n---\n*由 GitHub Actions 自动生成*\n")

    try:
        with open("README.md", "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("[INFO] README.md 已更新。")
    except Exception as e:
        print(f"[ERROR] README.md 更新失败: {e}")


# ==================== 入口 ====================

def main():
    print("=" * 55)
    print("  🔄  Weirdhost 自动续期")
    print(f"  🕐  {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"  🐍  Python {sys.version.split()[0]}")
    print("=" * 55)

    renewer = WeirdhostRenew()
    results = renewer.run()

    all_ok = print_summary(results)
    update_readme(results)

    if not results:
        print("\n⚠️ 未配置服务器，请设置 WEIRDHOST_SERVER_URLS")
        sys.exit(1)
    elif all_ok:
        print("\n🎉 所有任务完成！")
        sys.exit(0)
    else:
        print("\n⚠️ 部分任务未成功，请检查日志。")
        sys.exit(1)


if __name__ == "__main__":
    main()
