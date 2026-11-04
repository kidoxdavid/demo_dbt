#!/bin/sh
# First-start database setup (mounted into the postgres image's /docker-entrypoint-initdb.d).
# Two roles: the OWNER runs migrations; the APP role is what the running API uses, and is subject to row-level security (it must NOT be a superuser or owner).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE eazy_owner LOGIN PASSWORD '${EAZY_OWNER_PASSWORD}';
CREATE ROLE eazy_app LOGIN PASSWORD '${EAZY_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE eazystores OWNER eazy_owner;
SQL
