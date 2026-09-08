#!/bin/sh

set -u

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR" || exit 1

if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
else
  printf '\n未找到 Python 3.10 或更高版本。请先安装 Python：\nhttps://www.python.org/downloads/\n\n'
  printf '按回车键关闭窗口。'
  read -r _
  exit 1
fi

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  printf '\n需要 Python 3.10 或更高版本。\n'
  printf '当前 Python 版本：'
  "$PYTHON" --version
  printf '\n按回车键关闭窗口。'
  read -r _
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  printf '第一次启动：正在准备本地运行环境...\n'
  "$PYTHON" -m venv .venv || exit 1
fi

VENV_PYTHON="$ROOT_DIR/.venv/bin/python"
if ! "$VENV_PYTHON" -c 'import openpyxl, pypdf, reportlab' >/dev/null 2>&1; then
  printf '正在安装词书导入和 PDF 导出组件...\n'
  "$VENV_PYTHON" -m pip install -r requirements.txt || exit 1
fi

printf '\n亦可速记正在启动，浏览器会自动打开。\n关闭这个窗口即可停止本地服务。\n\n'
exec "$VENV_PYTHON" app.py
