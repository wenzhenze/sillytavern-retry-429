# SillyTavern 429 自动重试

本扩展为 SillyTavern 1.19.1 编写。遇到 HTTP 429，或 Gemini / Vertex AI 返回 `Resource exhausted. Please try again later.` 时，扩展会重试当前回复的生成请求。即使酒馆将上游错误包装成 HTTP 500，只要返回内容仍有这条错误文案或 429 错误码，扩展也能识别。

## 安装

在酒馆打开「扩展 → 安装扩展」，粘贴 `https://github.com/wenzhenze/sillytavern-retry-429.git` 并安装。刷新页面后可在「扩展 → 管理扩展」查看「429 自动重试」。

已通过 Git 安装的用户可在「管理扩展」中更新「429 自动重试」，然后刷新页面。

也可以手动安装。

1. 解压 ZIP，把整个 `sillytavern-retry-429` 文件夹放到 SillyTavern 安装目录下的 `data/default-user/extensions/`。如果使用自定义账号或数据目录，放到实际数据目录下的 `<账号>/extensions/`。
2. 确认目录结构为 `data/default-user/extensions/sillytavern-retry-429/manifest.json`，然后刷新酒馆网页。在「扩展 → 管理扩展」里可以查看或停用「429 自动重试」。

服务器部署的酒馆需要在服务器上解压。管理员可将扩展放入 `public/scripts/extensions/third-party/` 供所有账号使用。

## 使用

- 在酒馆的「扩展」面板展开「429 自动重试」，可设置最大重试次数，以及第 1 次、第 2 次和第 3 次起的等待秒数。最大重试次数填 `0` 表示无限重试。设置自动保存，从下次生成开始生效。
- 安装后默认启用。触发限流时会显示当前重试次数和等待时间。默认持续重试，前几次分别等待 2、4、8 秒，此后每次等待 8 秒。如果接口通过 `Retry-After` 要求等待更久，扩展会按接口要求等待。
- 重试会沿用原来的生成请求、连接和对话位置，用户消息只发送一次。等待期间可以用酒馆的停止按钮取消，切换聊天也会取消。
- 识别范围包括聊天补全、文本补全、Kobold 和 NovelAI 中可识别的限流响应。流式请求支持 HTTP 错误和首个事件就返回限流的情况。只收到通用错误、已经开始输出回复或明确余额用尽时，由酒馆按原流程处理。

[SillyTavern 扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/) · [Google Cloud 429 文档](https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429)
