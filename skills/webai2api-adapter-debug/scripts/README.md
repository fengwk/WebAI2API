# webai2api-cli

`webai2api-cli.py` 是本 skill 的统一远程执行入口。

工作流如下：

1. 直接编辑最终 adapter JS 文件
2. CLI `import()` 该文件
3. 读取 `manifest.id` 与 `manifest.script`
4. 本地编译校验
5. 作为 `overrideScript` 发往远端

当需要本地附件时：

- 通过 `--attach-file` 追加一个或多个文件路径
- CLI 会先调用上传接口，再把返回的 upload descriptor 合并到 `input.attachments`
- adapter 脚本继续按 `input.attachments` 处理，不需要关心上传细节

它固定：

- Base URL: `https://webai2api.kk1.fun`
- Header: `Authorization: Bearer ${TOOLS_API_KEY}`

## 何时使用

- 需要向远程 WebAI2API 实例发起真实 adapter 请求
- 需要把本地 adapter 文件中的 `manifest.script` 自动提取为 `overrideScript`
- 需要保存原始响应、打印请求摘要或做 sticky 调试

## 依赖

- `python3`
- `node`
- 环境变量 `TOOLS_API_KEY`

## 查看帮助

```bash
python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py --help
```

脚本帮助中包含：

- 参数说明
- 常用示例
- `--adapter-file` 的用法
- `--attach-file` 的用法
- `--debug` / `--worker-id` / `--session-id` / `--input-json` 的用法

推荐最小流程：

1. 先在最终 adapter 文件里写“只观察”版本的 `script`
2. 运行 CLI，确认页面进入和基本状态
3. 再在同一个文件里加“最小发送”
4. 再补结束信号和内容提取

如果 `--adapter-file` 导入成功但本地编译失败，说明问题在最终 adapter 文件本身：

- 你写进 `manifest.script` 的内层脚本仍有错误转义
- 或者内层脚本本身语法不合法

此时继续修最终 adapter 文件，然后重新运行同一个 CLI 命令。

## 约定

- 默认 stdout 输出原始响应 body
- `--pretty` 只在响应可解析为 JSON 时做格式化
- `--save-response` 保存的是原始响应文本
- `--print-request` 只把请求摘要打到 stderr，不会输出完整 `overrideScript`
