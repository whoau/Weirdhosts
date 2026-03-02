name: WeirdHost Renew (No TG)

on:
  schedule:
    - cron: '0 0 * * *' # 每天运行
  workflow_dispatch:    # 允许手动运行

jobs:
  renew:
    runs-on: ubuntu-latest
    
    steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup Node
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    # --- 必装：中日韩字体 (防止按钮乱码找不到) ---
    - name: Install Fonts & Deps
      run: |
        sudo apt-get update
        sudo apt-get install -y fonts-noto-cjk
        npm install
        npx playwright install chromium

    - name: Run Script
      env:
        # 只需配置 Cookie
        COOKIE_VALUE: ${{ secrets.COOKIE_VALUE }}
      run: node index.js

    # --- 必看：截图在这里下载 ---
    - name: Upload Screenshots
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: renew-screenshots
        path: screenshots/
        retention-days: 3
