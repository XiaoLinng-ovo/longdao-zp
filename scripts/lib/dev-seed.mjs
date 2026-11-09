export function assertDevelopmentSeedAllowed(env = process.env) {
  if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_SEED !== 'true') {
    const error = new Error('Development seed refused: NODE_ENV=development and ALLOW_DEV_SEED=true are both required.')
    error.code = 'DEV_SEED_NOT_AUTHORIZED'
    throw error
  }
}

export async function seedDevelopmentData(pool, { departments, roles, users, hashPassword, passwordOverride, env = process.env }) {
  assertDevelopmentSeedAllowed(env)
  const client = await pool.connect()
  const summary = { departments: 0, roles: 0, users: 0, usersSkipped: 0, roleBindings: 0, platformOperators: 0, workspaceMemberships: 0 }
  try {
    await client.query('BEGIN')
    for (const department of departments) {
      const result = await client.query(
        `INSERT INTO departments (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [department.code, department.name],
      )
      summary.departments += result.rows.length
    }
    for (const role of roles) {
      const result = await client.query(
        `INSERT INTO roles (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [role.code, role.name],
      )
      summary.roles += result.rows.length
    }
    for (const user of users) {
      const passwordHash = await hashPassword(passwordOverride || user.password)
      const inserted = await client.query(
        `INSERT INTO users (email, display_name, password_hash, department_id, is_active)
         VALUES ($1, $2, $3, (SELECT id FROM departments WHERE code = $4), true)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [user.email, user.name, passwordHash, user.department],
      )
      const isNewUser = inserted.rows.length === 1
      const userId = inserted.rows[0]?.id
        ?? (await client.query('SELECT id FROM users WHERE email = $1', [user.email])).rows[0]?.id
      if (!userId) throw new Error('Development seed account lookup failed.')
      if (isNewUser) {
        const binding = await client.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1::uuid, id FROM roles WHERE code = $2
           RETURNING user_id`,
          [userId, user.role],
        )
        if (binding.rows.length !== 1) throw new Error('Development seed role binding failed.')
        summary.users += 1
        summary.roleBindings += 1
      } else {
        summary.usersSkipped += 1
      }
      if (user.platformRole) {
        const operator = await client.query(
          `INSERT INTO platform_operators (user_id, role) VALUES ($1::uuid, $2)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING user_id`,
          [userId, user.platformRole],
        )
        summary.platformOperators += operator.rows.length
      }
    }
    await client.query('COMMIT')
    return summary
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
