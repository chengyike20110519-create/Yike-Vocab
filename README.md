# 亦可速记

一个中英单词学习平台：用户可以导入自己的词书，按单元刷单词卡片，记录每次认识 / 模糊 / 不认识的状态，并导出默写 PDF。

本仓库只包含平台代码，不包含任何个人词书或学习记录。第一次运行时会自动创建空数据库，用户导入自己的词书后即可开始使用。

## 功能

- 导入词书：支持 PDF、Excel、CSV、TXT、JSON、DOCX，也可以直接粘贴文本
- 大词书管理：自动识别单元，一个工作表对应一个单元，或使用“单元”列
- 单词卡片：正序 / 乱序背诵，可上一张、下一张
- 学习记录：认识、模糊、不认识三种状态，记录每次点击时间与次数
- 分组复习：按状态查看单词，并可把某个分组直接拿去背
- PDF 导出：默写版每页 50 个，只给编号和英文，留空手写中文；也可导出对照版

## 技术栈

- Python 标准库 HTTP 服务
- SQLite 本地存储
- `openpyxl` 读取 Excel
- `pypdf` 读取 PDF
- `reportlab` 生成 PDF
- 原生 HTML / CSS / JavaScript，无前端框架和构建步骤

## 本地运行

需要 Python 3.10 或更高版本。

### GitHub Release 一键启动

GitHub Release 下载的是这个平台的本地部署包，不是在线网站：词书和学习记录会保存在用户自己的电脑上，GitHub 不会接触这些数据。

下载并解压 Release 压缩包后：

- macOS / Linux：双击 `启动.command`。macOS 第一次如果提示无法打开，可右键文件并选择“打开”。
- Windows：双击 `启动.bat`。

启动器会自动创建独立运行环境、安装依赖、启动本地前后端服务，并打开浏览器。这个项目的前端页面和后端接口由同一个本地服务提供，所以用户只需要点击一次，不需要分别启动前端和后端。关闭启动器窗口即可停止服务。

电脑需要预先安装 Python 3.10 或更高版本。第一次启动需要联网安装依赖，之后启动不需要重复安装。

### 手动运行

```bash
git clone <你的仓库地址>
cd 单词软件
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 app.py
```

Windows 激活虚拟环境：

```powershell
.venv\Scripts\activate
python app.py
```

启动后会自动打开 `http://127.0.0.1:8000`。如果常用端口已被占用，程序会自动选择系统分配的空闲本地端口。

## 导入格式

Excel 推荐列名：

- 单元：`单元` / `Unit`
- 单词：`单词` / `word`
- 音标：`音标` / `phonetic`
- 词性：`词性` / `pos`
- 中文释义：`中文释义` / `释义`
- 英文释义（可选）：`英文释义` / `meaning_en`

工作簿可以每个工作表对应一个单元，也可以在同一个工作表里放一列单元号。

粘贴文本支持类似格式：

```text
Unit 1
abandon [əˈbændən] vt. 放弃；抛弃
come up with 提出；想出
```

PDF 导入会识别常见的 Barron / Direct Hits 词书排版。扫描版且没有文字层的 PDF 无法解析，请先另存为文字版或转成 Excel / CSV。

## 数据存储

词库和点击记录保存在运行目录下的 `data/vocab.db`，不会被 Git 跟踪。仓库中不提供预置个人词书；删除 `data/` 即可清空本地数据。

当平台通过支持会话隔离的服务公开运行时，浏览器会使用独立会话数据库保存每位用户的数据。应用没有账号系统，不建议把它直接暴露到公网来存放敏感内容。

## 项目结构

```text
.
├── app.py              # 本地服务与 API
├── importer.py         # 词书解析与导入
├── export_pdf.py       # PDF 导出
├── 启动.command         # macOS / Linux 一键启动
├── 启动.bat             # Windows 一键启动
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt
├── LICENSE
└── README.md
```

## 安全说明

应用只适合作为本地或个人服务器工具，默认监听 `127.0.0.1`。它没有账号系统，不建议直接暴露到公网。

## 许可证

MIT License。具体内容见 [LICENSE](LICENSE)。
