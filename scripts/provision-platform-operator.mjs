import '../apps/api/dist/src/env.js'
import { createDatabasePool } from '../apps/api/dist/src/db/connection.js'
const [email, role, ...reasonWords] = process.argv.slice(2)
const reason = reasonWords.join(' ').trim()
if (!email || !['admin', 'viewer', 'revoke'].includes(role) || reason.length < 2 || reason.length > 500) {
  console.error('用法：node scripts/provision-platform-operator.mjs <已有账号邮箱> <admin|viewer|revoke> <2～500字原因>')
  process.exitCode = 1
} else {
  const pool = createDatabasePool(), client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE platform_operators IN SHARE ROW EXCLUSIVE MODE')
    const user = (await client.query('SELECT id,is_active FROM users WHERE lower(email)=lower($1) FOR SHARE', [email])).rows[0]
    if (!user?.is_active) throw new Error('找不到对应的已启用账号；不会自动创建用户或重置密码')
    const before = (await client.query('SELECT role,is_active FROM platform_operators WHERE user_id=$1', [user.id])).rows[0]
    if (before?.role === 'admin' && before.is_active && role !== 'admin') {
      const others = (await client.query("SELECT count(*)::int AS n FROM platform_operators p JOIN users u ON u.id=p.user_id WHERE p.role='admin' AND p.is_active AND u.is_active AND p.user_id<>$1",[user.id])).rows[0].n
      if (!others) throw new Error('不能撤销或降级最后一位平台管理员，请先授权其他管理员')
    }
    if (role === 'revoke') await client.query('UPDATE platform_operators SET is_active=false,updated_at=now() WHERE user_id=$1', [user.id])
    else await client.query('INSERT INTO platform_operators(user_id,role) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,is_active=true,updated_at=now()', [user.id,role])
    await client.query("INSERT INTO platform_audit_logs(action,metadata) VALUES('platform.operator.provision',$1::jsonb)", [JSON.stringify({ source:'local-database-cli', targetUserId:user.id, reason, before:before??null, after:{role:role==='revoke'?null:role,isActive:role!=='revoke'} })])
    await client.query('COMMIT')
    console.log(`平台运营授权已更新：${email} → ${role}；未修改企业成员关系、业务角色或密码。`)
  } catch(error) {
    await client.query('ROLLBACK'); console.error(error instanceof Error ? error.message : '平台授权失败'); process.exitCode=1
  } finally {client.release();await pool.end()}
}
