@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=py -3"
) else (
    where python >nul 2>nul
    if not errorlevel 1 (
        set "PYTHON=python"
    ) else (
        echo.
        echo 未找到 Python 3.10 或更高版本。请先安装 Python：
        echo https://www.python.org/downloads/
        echo.
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo 第一次启动：正在准备本地运行环境...
    %PYTHON% -m venv .venv
    if errorlevel 1 goto :failed
)

set "VENV_PYTHON=%CD%\.venv\Scripts\python.exe"
"%VENV_PYTHON%" -c "import openpyxl, pypdf, reportlab" >nul 2>nul
if errorlevel 1 (
    echo 正在安装词书导入和 PDF 导出组件...
    "%VENV_PYTHON%" -m pip install -r requirements.txt
    if errorlevel 1 goto :failed
)

echo.
echo 亦可速记正在启动，浏览器会自动打开。
echo 关闭这个窗口即可停止本地服务。
echo.
"%VENV_PYTHON%" app.py
exit /b %errorlevel%

:failed
echo.
echo 启动失败，请检查 Python 安装和网络连接后重试。
pause
exit /b 1
