process.env.DATABASE_URL = 'postgres://eazy_app:app_pw@localhost:5432/eazystores_test';
process.env.MIGRATION_DATABASE_URL = 'postgres://eazy_owner:owner_pw@localhost:5432/eazystores_test';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_DIR = '/tmp/eazy-test-uploads';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
