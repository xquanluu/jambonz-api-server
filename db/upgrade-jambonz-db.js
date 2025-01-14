#!/usr/bin/env node
const assert = require('assert');
const mysql = require('mysql2/promise');
const {readFile} = require('fs/promises');
const {execSync} = require('child_process');
const {version:desiredVersion} = require('../package.json');
const logger = require('pino')();

logger.info(`upgrade-jambonz-db: desired version ${desiredVersion}`);

assert.ok(process.env.JAMBONES_MYSQL_HOST, 'missing env JAMBONES_MYSQL_HOST');
assert.ok(process.env.JAMBONES_MYSQL_DATABASE, 'missing env JAMBONES_MYSQL_DATABASE');
assert.ok(process.env.JAMBONES_MYSQL_PASSWORD, 'missing env JAMBONES_MYSQL_PASSWORD');
assert.ok(process.env.JAMBONES_MYSQL_USER, 'missing env JAMBONES_MYSQL_USER');

const opts = {
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  port: process.env.JAMBONES_MYSQL_PORT || 3306,
  multipleStatements: true
};

const sql = {
  '7006': [
    'ALTER TABLE `accounts` ADD COLUMN `siprec_hook_sid` CHAR(36)',
    // eslint-disable-next-line max-len
    'ALTER TABLE accounts ADD FOREIGN KEY siprec_hook_sid_idxfk (siprec_hook_sid) REFERENCES applications (application_sid)'
  ]
};

const doIt = async() => {
  let connection;
  try {
    logger.info({opts}, 'connecting to mysql database..');
    connection = await mysql.createConnection(opts);
  } catch (err) {
    logger.error({err}, 'Error connecting to database with provided env vars');
    process.exit(1);
  }

  try {
    /* does the schema exist at all ? */
    const [r] = await connection.execute('SELECT version from schema_version');
    let errors = 0;
    if (r.length) {
      const {version} = r[0];
      const arr = /v?(\d+)\.(\d+)\.(\d+)/.exec(version);
      if (arr) {
        const upgrades = [];
        logger.info(`performing schema migration: ${version} => ${desiredVersion}`);
        const val = (1000 * arr[1]) + (100 * arr[2]) + arr[3];
        logger.info(`current schema value: ${val}`);

        if (val < 7006) upgrades.push(...sql['7006']);

        // perform all upgrades
        logger.info({upgrades}, 'applying schema upgrades..');
        for (const upgrade of upgrades) {
          try {
            await connection.execute(upgrade);
          } catch (err) {
            errors++;
            logger.info({statement:upgrade, err}, 'Error applying statement');
          }
        }
      }
      if (errors === 0) await connection.execute(`UPDATE schema_version SET version = '${desiredVersion}'`);
      await connection.end();
      logger.info(`schema migration to ${desiredVersion} completed with ${errors} errors`);
      return;
    }
  } catch (err) {
  }
  try {
    await createSchema(connection);
    await seedDatabase(connection);
    logger.info('reset admin password..');
    execSync(`${__dirname}/../db/reset_admin_password.js`);
    await connection.query(`INSERT into schema_version (version) values('${desiredVersion}')`);
    logger.info('database install/upgrade complete.');
    await connection.end();
  } catch (err) {
    logger.error({err}, 'Error seeding database');
    process.exit(1);
  }
};

const createSchema = async(connection) => {
  logger.info('reading schema..');
  const sql = await readFile(`${__dirname}/../db/jambones-sql.sql`, {encoding: 'utf8'});
  logger.info('creating schema..');
  await connection.query(sql);
};

const seedDatabase = async(connection) => {
  const sql = await readFile(`${__dirname}/../db/seed-production-database-open-source.sql`, {encoding: 'utf8'});
  logger.info('seeding data..');
  await connection.query(sql);
};


doIt();

