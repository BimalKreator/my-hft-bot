import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Client } = pg;

const client = new Client({
  user: 'hft_user',
  password: 'HftBot123',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: 'hft_db',
});

const ADMIN_EMAIL = 'admin@test.com';
const ADMIN_PASSWORD = 'password123';

async function createAdmin() {
  await client.connect();

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  await client.query(
    `INSERT INTO users (email, password) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password`,
    [ADMIN_EMAIL, passwordHash]
  );

  console.log('Admin user created successfully: admin@test.com');
}

createAdmin()
  .then(() => client.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
