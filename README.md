# Kimi 分流卫士 · DSH Kimi Channel Guard

[![npm](https://img.shields.io/npm/v/dsh-kimi-channel-guard)](https://www.npmjs.com/package/dsh-kimi-channel-guard)

**将 Kimi 的流式思考、正文和工具调用分开，避免历史回放时思考串进正文。**

A compatibility-patch plugin for DeepSeek Harness (DSH), targeting the OpenAI-chat adapter in `@goodandready/dsh-subscriptions`. It assigns distinct block indices to reasoning, answer text and tool calls, and serializes assistant reasoning separately from answer history.

> **这不是通用提示词，也不是界面隐藏插件。安装并启动后，它会修改订阅插件目录里的三个 JavaScript 文件。**
> 仅处理已识别的源码结构；先备份，再写入；需要完整重启 DSH。不会修改 DSH 主程序。

## 简介

Kimi 分流卫士为 DSH 的 Subscriptions 订阅插件提供思考/正文通道兼容修复：独立分配思考、正文及工具调用的区块索引，避免迟到的思考片段混入回答；历史消息中正文只保留 text，Kimi 的思考通过独立 `reasoning_content` 字段回放。支持源码检查、自动备份、重复执行和基于哈希的显式回滚。

## 修复范围

| 文件 | 问题 | 修复 |
| --- | --- | --- |
| `lib/wire.js` | reasoning delta 固定使用索引 0，没有独立 block-start，可能与正文/工具冲突 | 通过同一个递增分配器创建独立 reasoning、text、tool-call 区块；仅思考的流被截断也报告 INCOMPLETE |
| `lib/messages.js` | assistant 历史把 reasoning 与 text 拼成 content | content 只包含 text；仅在显式开启时添加 reasoning_content |
| `lib/vendors/kimi.js` | Kimi 历史没有明确请求独立思考字段 | 调用 openaiMessages 时开启 includeReasoning |

**影响范围要说清楚：** wire.js 与 messages.js 是订阅插件共享的 OpenAI-chat 路径，因此同一订阅插件中使用这些函数的其它 provider 也会受到通道隔离修复影响。Kimi 的独立历史思考回放只在 Kimi 入口启用。Responses API 路径和其它接入插件不在本版本修复范围内。

## 兼容性

- 已核对：`@goodandready/dsh-subscriptions@0.7.55` 的原始及本地已修复函数形状。
- 其它版本只有三个目标位置均能精确匹配已知原始/修复片段时才处理；**不宣称支持所有版本**。
- 已修复的文件保持不变；未知结构、重复匹配、跨目录符号链接都会停止，不进行盲改。
- 不读取账号凭据，不发网络请求，不注入提示词，不修改模型推理参数。
- 不会修复已写入磁盘的历史混流记录，也不能从一个没有通道标记的纯文本流中推断出思考。

## 安装

先安装并配置 Subscriptions，本插件不会自动安装它。

### DSH Desktop

设置 → 插件 → 添加插件，输入：

```text
dsh-kimi-channel-guard
```

也可使用 GitHub 来源：

```text
github:AkiNoYo-desu/dsh-kimi-channel-guard
```

安装后完整退出并重开 DSH，让宿主插件执行检查/补丁。如果日志显示 `Applied channel isolation patch`，**再完整退出重开一次**，确保已经加载到内存的旧模块被替换。不会自动杀进程或重启正在使用的会话。

### CLI（推荐先检查再应用）

在此仓库目录中：

```sh
node bin/cli.js check --target /path/to/@goodandready/dsh-subscriptions
node bin/cli.js apply --target /path/to/@goodandready/dsh-subscriptions
```

或已知 profile 时：

```sh
node bin/cli.js check --profile-dir /path/to/profile
node bin/cli.js apply --profile-dir /path/to/profile
```

安装 npm 包也提供同名 CLI：`npx dsh-kimi-channel-guard check --target ...`。

未传路径时优先从 `DSH_PROFILE_DIR`、当前工作目录和插件自身目录解析**该包**，不扫描其它用户目录。

## 备份与回滚

默认备份目录是 `~/.dsh/state/kimi-channel-guard/`，按目标包绝对路径的哈希隔离。也可传 `--backup-dir DIR`。

`apply` 输出中的 `receipt` 指向本次备份清单。回滚命令：

```sh
node bin/cli.js restore --receipt /path/to/receipt.json
```

- 只恢复这次操作实际修改的文件；安装前就已修复的文件不由本插件接管。
- 校验原文件、补丁结果、备份的 SHA-256。
- 文件若在补丁后被升级或编辑，会停止回滚，不覆盖新版本。
- 单次写入失败会尝试回滚已写入的文件。跨文件更新不是操作系统级原子事务；保留 receipt 以恢复异常中断。
- 卸载插件**不会自动撤销磁盘补丁**。要恢复，请先显式回滚，再卸载，并重启 DSH。
- 升级订阅插件后，在启动或 CLI 中重新检查；未知版本需先适配。

## 测试

```sh
npm test
```

41 个可携带的 Node 测试：覆盖全部 8 种部分修复组合、幂等、回滚、失败写入回滚、升级冲突保护、备份篡改检测、路径约束、混合包、迟到思考、正文先到、1/7/65536 字节 SSE 分片、工具参数分片、截断、历史隔离及 Kimi 独立字段调用。

另在开发机运行了今天的原始回归脚本：62 项检查通过，包括原始/旧补丁/当前 DSH BlockAssembler，以及真实 Kimi 入口 + 本地 HTTP fixture。该脚本依赖开发机旧版备份，**不是**npm 包内的便携测试，不要求用户拥有它，也不构成真实账号联网验证。

## 来源与许可证

MIT。补丁前后片段和 SSE 测试辅助来源于 [GooDAnDReaDY/dsh-subscriptions](https://github.com/GooDAnDReaDY/dsh-subscriptions)，保留 GooDAnDReaDY 的版权声明。

本仓库是兼容修复插件，非 Kimi、Moonshot、DeepSeek 或 Subscriptions 官方项目。详见 [LICENSE](LICENSE)。
