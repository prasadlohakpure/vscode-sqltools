// UoW-08's pure half: read-only classification, the USE/SET/ALTER SESSION
// warning, and LIMIT injection.
// Ported from heimdall-vs-code-ext's test/safety.test.js — see UoW-03.
import assert from 'assert';

import { isReadOnly, isSessionStatement, injectLimit } from '../src/heimdall/safety';

test('isReadOnly: allow-list is SELECT/SHOW/DESCRIBE/EXPLAIN/WITH', () => {
  assert.equal(isReadOnly('select 1'), true);
  assert.equal(isReadOnly('  SELECT * from t'), true);
  assert.equal(isReadOnly('show tables'), true);
  assert.equal(isReadOnly('describe t'), true);
  assert.equal(isReadOnly('explain select 1'), true);
  assert.equal(isReadOnly('with x as (select 1) select * from x'), true);
});

test('isReadOnly: everything else needs confirmation', () => {
  assert.equal(isReadOnly('insert into t values (1)'), false);
  assert.equal(isReadOnly('delete from t'), false);
  assert.equal(isReadOnly('create table t (a int)'), false);
  assert.equal(isReadOnly('drop table t'), false);
  assert.equal(isReadOnly('use db'), false);
  assert.equal(isReadOnly('set spark.sql.shuffle.partitions=10'), false);
  assert.equal(isReadOnly('alter session set x=1'), false);
});

test('isSessionStatement: USE / SET / ALTER SESSION only', () => {
  assert.equal(isSessionStatement('use db'), true);
  assert.equal(isSessionStatement('set x=1'), true);
  assert.equal(isSessionStatement('alter session set x=1'), true);
  assert.equal(isSessionStatement('select 1'), false);
  assert.equal(isSessionStatement('insert into t values (1)'), false);
});

// splitStatements (results.ts) keeps leading comments rather than stripping
// them, so `-- note\nselect 1` is a real input, not a contrived one.
test('isReadOnly: a leading line comment does not hide the real statement', () => {
  assert.equal(isReadOnly('-- note\nselect 1'), true);
});

test('isReadOnly: a leading block comment does not hide the real statement', () => {
  assert.equal(isReadOnly('/* note */ select 1'), true);
});

test('isReadOnly: multiple leading comments and blank lines are all skipped', () => {
  assert.equal(isReadOnly('-- a\n/* b */\n-- c\nselect 1'), true);
});

test('isSessionStatement: a leading comment does not hide a USE/SET', () => {
  assert.equal(isSessionStatement('-- note\nuse db'), true);
});

test('injectLimit: adds LIMIT to a SELECT with none', () => {
  assert.equal(injectLimit('select * from t', 1000), 'select * from t LIMIT 1000');
});

test('injectLimit: adds LIMIT to a WITH/CTE query, at the very end', () => {
  assert.equal(
    injectLimit('with x as (select 1) select * from x', 500),
    'with x as (select 1) select * from x LIMIT 500',
  );
});

test('injectLimit: already has a top-level LIMIT — left alone', () => {
  const sql = 'select * from t limit 10';
  assert.equal(injectLimit(sql, 1000), sql);
});

test('injectLimit: LIMIT inside a subquery still counts as "has one"', () => {
  const sql = 'select * from (select * from t limit 5) x';
  assert.equal(injectLimit(sql, 1000), sql);
});

test('injectLimit: LIMIT inside a CTE still counts as "has one"', () => {
  const sql = 'with x as (select * from t limit 5) select * from x';
  assert.equal(injectLimit(sql, 1000), sql);
});

test('injectLimit: preserves a trailing semicolon after the injected clause', () => {
  assert.equal(injectLimit('select * from t;', 1000), 'select * from t LIMIT 1000;');
});

test('injectLimit: preserves a trailing line comment after the injected clause', () => {
  assert.equal(
    injectLimit('select * from t -- notes', 1000),
    'select * from t LIMIT 1000 -- notes',
  );
});

test('injectLimit: non-SELECT statements are never touched', () => {
  assert.equal(injectLimit('show tables', 1000), 'show tables');
  assert.equal(injectLimit('insert into t values (1)', 1000), 'insert into t values (1)');
  assert.equal(injectLimit('use db', 1000), 'use db');
});

test('injectLimit: a leading comment does not stop LIMIT injection', () => {
  assert.equal(injectLimit('-- note\nselect * from t', 1000), '-- note\nselect * from t LIMIT 1000');
});

test('injectLimit: a non-finite or fractional maxRows is normalized', () => {
  assert.equal(injectLimit('select * from t', NaN), 'select * from t LIMIT 1000');
  assert.equal(injectLimit('select * from t', Infinity), 'select * from t LIMIT 1000');
  assert.equal(injectLimit('select * from t', 3.7), 'select * from t LIMIT 3');
  assert.equal(injectLimit('select * from t', -5), 'select * from t LIMIT 1');
});
