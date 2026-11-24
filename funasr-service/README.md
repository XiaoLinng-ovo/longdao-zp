## FunASR 本地服务

启动：

```powershell
.\start-funasr.ps1
```

启动脚本会读取仓库根目录的 `.env`。本机 4 GB 显卡建议配置：

```dotenv
FUNASR_OFFLINE_DEVICE=cpu
FUNASR_STREAMING_DEVICE=cuda
FUNASR_CPU_THREADS=2
FUNASR_BATCH_SIZE_S=30
```

流式识别仍使用 GPU；离线识别、VAD、标点和 CAM++ 在 CPU 上运行，保留原模型和说话人能力，代价是离线识别可能更慢。未配置单独设备时仍沿用 `FUNASR_DEVICE`（默认 `cuda`）；无 CUDA 时回落到 CPU。

`/health` 显示两个模型的实际设备、加载状态和错误。`/ready` 仅在离线和流式模型均成功加载后返回 200，否则返回 503；不要仅凭 `/health` 的 HTTP 200 判断转录已就绪。内存不足不会再触发去掉说话人模型后的重复加载。

验证（在本目录执行）：

```powershell
.\.venv\Scripts\python.exe -m unittest test_server test_speaker_diarization
.\.venv\Scripts\python.exe smoke_test.py
```

冒烟脚本要求本机 Windows 中文语音 `Microsoft Huihui Desktop`、FFmpeg、运行中的 FunASR 和 5174 前端。它在临时目录生成合成中文语音，验证离线转录、说话人片段，以及经前端 `/funasr-stream` 代理连续提交两段音频的流式结果；不读取真实面试录音，结束后清理合成文件。

如果希望 Windows 登录后自动启动（避免面试页进入手动记录模式），在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-funasr-autostart.ps1
```

该任务名为 `SmartRecruit-FunASR-AutoStart`。它会先检查 `127.0.0.1:10095/health`，服务已经运行时不会重复启动；服务异常退出时，Windows 计划任务会按重试设置重新启动。
