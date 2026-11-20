# 本地 faster-whisper 服务

这是面试音频的可选 HTTP 转写后备服务。系统仍优先使用 FunASR；只有 FunASR 未配置或调用失败时，API 才会尝试此服务。

## 安装

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 启动

```powershell
.\start-faster-whisper.ps1
```

默认健康检查地址为 `http://127.0.0.1:10096/health`，转写地址为 `http://127.0.0.1:10096/transcribe`。

API 环境变量：

```text
FASTER_WHISPER_BASE_URL=http://127.0.0.1:10096/transcribe
FASTER_WHISPER_TIMEOUT_MS=120000
```

可选模型参数：

```text
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
FASTER_WHISPER_LANGUAGE=zh
```

该服务只负责语音识别，不负责说话人分离，因此返回的片段会使用 `speaker_0`，并标记为未验证和可能混合说话人。当前系统会保留这一不确定性，不会把它当成可靠的候选人或面试官身份。


## 本机资源配置

当前平台仍由 FunASR 承担实时流式识别。后备服务建议使用 CPU，避免与主服务争抢显存；本机已验证的低资源组合如下，写入仓库根目录 `.env` 即可：

```text
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
FASTER_WHISPER_CPU_THREADS=2
FASTER_WHISPER_BEAM_SIZE=1
```

默认使用 `base + CPU int8`，每次一个推理任务，并在导入计算库前约束 OMP/MKL 线程数，减少与 FunASR、OCR 的资源竞争。可用 `FASTER_WHISPER_CPU_THREADS` 调整线程数；显式设置的 `OMP_NUM_THREADS` / `MKL_NUM_THREADS` 优先。需要更高准确率时可试用 `small` 或更大的模型，并在目标机器上测量延迟、内存和显存后选择。

启动脚本仅加载 `.env` 中 `FASTER_WHISPER_` 开头的参数，已设置的进程环境变量优先。默认监听 `127.0.0.1:10096`；可选的 `FASTER_WHISPER_TOKEN` 同时保护 `/health` 和 `/transcribe`，API 和一键启动的健康检查会携带 Bearer Token。无需对浏览器暴露此 Token。

`/health` 的 `modelLoaded` 表示模型是否已经加载，HTTP 健康检查不会提前加载模型。第一次识别需要下载模型；可在正式面试前用测试音频完成一次转写，避免首次下载等待。空闲 60 秒后自动释放后备模型，下次请求时从本机缓存重新加载；`FASTER_WHISPER_IDLE_SECONDS=0` 可关闭空闲释放。每次只处理一个推理请求，忙时返回 429，平台会保留音频并重试。无需将完整面试一次送入模型，现有录音分段和原始音频保存方式继续使用。

后备服务成功但没有识别到语音时返回空数组，不会凭空补写文字。后备片段需要在平台确认说话人角色后才能进入对应人员的回答分析。

## 验证

在仓库根目录运行：

```powershell
.\faster-whisper-service\.venv\Scripts\python.exe -m unittest discover -s faster-whisper-service -p test_server.py -v
```

该测试使用模型替身验证长文本、时间戳、临时文件清理、并发保护和 Token 校验，不代表真实录音识别准确率测试。

项目来源：[SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)，采用 MIT 许可证。模型文件遵循各模型仓库的许可证。

本机实际 HTTP 测试：将约 20.5 秒的中文测试音频重复拼接为 307.53 秒后，`base / CPU int8 / 2 线程 / beam_size=1` 返回 45 个片段，最后时间戳 307.12 秒，约 75 秒完成。另一次通过平台的回退客户端模拟主服务返回 503，也成功返回全部 45 段、1200 字符和 307.12 秒结束时间，耗时约 64 秒。该结果验证长音频可以完整走完推理链路；重复测试音频不能代表真实面试的识别准确率或多人角色分离效果。
