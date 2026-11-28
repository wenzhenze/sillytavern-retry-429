# SillyTavern 429 自动重试

本扩展为 SillyTavern 1.19.1 编写，可在限流、自定义 API 安全政策拦截、聊天补全安全拒答或空回复时重试当前生成。

## 安装

在酒馆打开「扩展 → 安装扩展」，粘贴 `https://github.com/wenzhenze/sillytavern-retry-429.git` 并安装。刷新页面后可在「扩展 → 管理扩展」查看「429 自动重试」。

已通过 Git 安装的用户可在「管理扩展」中更新「429 自动重试」，然后刷新页面。

也可以手动安装。

1. 解压 ZIP，把整个 `sillytavern-retry-429` 文件夹放到 SillyTavern 安装目录下的 `data/default-user/extensions/`。如果使用自定义账号或数据目录，放到实际数据目录下的 `<账号>/extensions/`。
2. 确认目录结构为 `data/default-user/extensions/sillytavern-retry-429/manifest.json`，然后刷新酒馆网页。在「扩展 → 管理扩展」里可以查看或停用「429 自动重试」。

服务器部署的酒馆需要在服务器上解压。管理员可将扩展放入 `public/scripts/extensions/third-party/` 供所有账号使用。

## 使用

- 在酒馆的「扩展」面板展开「429 自动重试」，可分别开启或关闭下列四项。四项默认开启，设置自动保存，从下次生成开始生效。
  - **Vertex AI 429 和其他接口限流**包括 HTTP 429、`RESOURCE_EXHAUSTED` 和 `Resource exhausted. Please try again later.` 等可识别的限流。已明确用尽的余额交回酒馆处理。
  - **自定义 API 的安全政策拦截**适用于聊天补全的「自定义（OpenAI 兼容）」来源，识别返回给浏览器的安全错误码、拦截文案和 `content_filter` 等结束原因。酒馆或代理若只留下通用错误，扩展无法推断原始原因。
  - **安全政策拒答或道歉**识别聊天补全的 `refusal` 字段和常见中英文拒答句式。文本识别依赖句式，普通剧情道歉可照常显示。
  - **空回复**识别聊天补全完成后没有文本、图片或工具调用的情况。可识别的政策拦截按相应开关处理。
- 四项共用最大重试次数和等待间隔。最大重试次数填 `0` 表示无限。默认依次等待 2、4、8 秒，此后每次等待 8 秒。接口要求等待更久时遵守 `Retry-After`。
- 重试会沿用原来的生成请求、连接和对话位置，用户消息只发送一次。等待期间可以用酒馆的停止按钮取消，切换聊天也会取消。
- 聊天补全启用拦截、拒答或空回检查时，流式回复会检查完再交给酒馆显示。超过 4 MiB 的流式回复会提前交回酒馆。仅开启限流检查时，仍按酒馆原本的流式方式显示，扩展检查 HTTP 错误和首个流式事件中的限流。

[SillyTavern 扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/) · [Google Cloud 429 文档](https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429)
