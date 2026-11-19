-- 每个用户一个随机唯一编码，用于跨表绑定与对外标识。
-- 用户名（display_name）允许重复，不能作为主键或业务标识，因此新增 user_no。
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_no text;

UPDATE users
   SET user_no = 'USR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
 WHERE user_no IS NULL;

ALTER TABLE users
  ALTER COLUMN user_no SET DEFAULT ('USR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));

ALTER TABLE users ALTER COLUMN user_no SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_user_no_key ON users (user_no);
