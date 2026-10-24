# FunASR-only Interview Transcription

面试实时流式识别和音频分段识别统一使用 FunASR。系统不配置或调用其他
语音识别模型，避免不同模型之间产生文本和断句差异。

FunASR 暂时不可用时，原始音频仍然先保存，流式检查点和本地上传队列继续
保留；识别失败沿用现有错误提示与重试流程，服务恢复后再处理待上传音频。
说话人分离、角色映射、转写合并和人工修正仍由现有面试链路负责。

启动前只需要配置 `FUNASR_BASE_URL`、`FUNASR_TIMEOUT_MS` 和可选的
`FUNASR_TOKEN`。部署这项变更后重启 API；FunASR 服务本身无需更换模型。
