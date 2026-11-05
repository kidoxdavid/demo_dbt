import pg from 'pg';
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://es2:es2_pw@localhost:5432/eazystores2_test';
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to reset database "${name}": the name must contain "test"`);
  const c = new pg.Client({ connectionString: url }); await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
  process.env.DATABASE_URL = url; process.env.NODE_ENV = 'test';
  const { runMigrations } = await import('../src/migrate.js'); const { pool } = await import('../src/db.js');
  await runMigrations(); await pool.end();
}
