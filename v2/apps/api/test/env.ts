// Tests run against a database whose NAME CONTAINS "test", rebuilt every run. Nothing else is ever touched.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://es2:es2_pw@localhost:5432/eazystores2_test';
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
