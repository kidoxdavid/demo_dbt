import pg from 'pg';
import { migrate } from '../src/migrate.js';
export default async function () {
  const url = 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores_test';
  const c = new pg.Client({ connectionString: url }); await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
  await migrate(url);
}
