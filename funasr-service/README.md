## FunASR 本地服务

启动：

```powershell
.\start-funasr.ps1
```

如果希望 Windows 登录后自动启动（避免面试页进入手动记录模式），在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-funasr-autostart.ps1
```

该任务名为 `SmartRecruit-FunASR-AutoStart`。它会先检查 `127.0.0.1:10095/health`，服务已经运行时不会重复启动；服务异常退出时，Windows 计划任务会按重试设置重新启动。
