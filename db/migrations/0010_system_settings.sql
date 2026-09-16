-- 系统设置：键值对，供管理后台读取与维护运营开关。
-- 注意：OpenAI 地址/密钥/超时等部署级连接由运维经环境变量配置，绝不进入本表
-- （见设计 9.1），管理后台只读脱敏后的连接状态，不允许覆盖密钥或地址。
CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
