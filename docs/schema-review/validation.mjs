// Disposable PostgreSQL rehearsal. No dotenv or configured application URL is read.
// Run: node docs/schema-review/validation.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'attendance-schema-review-'));
const dataDir = join(fixtureRoot, 'data');
const socketDir = join(fixtureRoot, 'socket');
mkdirSync(socketDir);
const log = [];
const counts = { pass: 0 };
const record = (label) => { counts.pass += 1; log.push(`PASS ${label}`); };
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
let client;
let started = false;
let failure;

const eventTypes = [
  'CHECK_IN_SUCCESS', 'CHECK_OUT_SUCCESS', 'CHECK_IN_REJECTED', 'CHECK_OUT_REJECTED',
  'LATE_REASON_SUBMITTED', 'LATE_REASON_REJECTED', 'DEVICE_REGISTERED', 'DEVICE_APPROVED',
  'DEVICE_APPROVAL_REMOVED', 'DEVICE_REVOKED', 'ADMIN_CORRECTION',
];

async function rejects(label, sql, sqlstate, constraint) {
  await client.query('BEGIN');
  let error;
  try { await client.query(sql); } catch (caught) { error = caught; }
  finally { await client.query('ROLLBACK'); }
  assert.ok(error, `${label}: expected rejection`);
  assert.equal(error.code, sqlstate, `${label}: ${error.message}`);
  if (constraint) assert.equal(error.constraint, constraint, label);
  record(`${label} [${sqlstate}${constraint ? ` / ${constraint}` : ''}]`);
}

async function accepts(label, sql) {
  await client.query('BEGIN');
  try { await client.query(sql); } finally { await client.query('ROLLBACK'); }
  record(label);
}

async function timestampState(columns) {
  const state = {};
  for (const { table_name, column_name } of columns) {
    const key = table_name === 'RateLimit' || table_name === 'SystemSetting' ? 'key' : 'id';
    const result = await client.query(`SELECT ${quote(key)} AS key,
      extract(epoch FROM ${quote(column_name)} AT TIME ZONE 'UTC')::text AS epoch
      FROM ${quote(table_name)} ORDER BY ${quote(key)}`);
    state[`${table_name}.${column_name}`] = result.rows;
  }
  return state;
}

async function convertedTimestampState(columns) {
  const state = {};
  for (const { table_name, column_name } of columns) {
    const key = table_name === 'RateLimit' || table_name === 'SystemSetting' ? 'key' : 'id';
    const result = await client.query(`SELECT ${quote(key)} AS key,
      extract(epoch FROM ${quote(column_name)})::text AS epoch
      FROM ${quote(table_name)} ORDER BY ${quote(key)}`);
    state[`${table_name}.${column_name}`] = result.rows;
  }
  return state;
}

async function unchangedFieldState(modelNames, timestampColumns) {
  const state = {};
  for (const name of modelNames) {
    const key = name === 'RateLimit' || name === 'SystemSetting' ? 'key' : 'id';
    const omit = timestampColumns.filter((column) => column.table_name === name).map((column) => column.column_name);
    if (name === 'Shift') omit.push('startTime', 'endTime', 'startMinute', 'endMinute');
    if (name === 'Attendance') omit.push('scheduledStartAt', 'scheduledEndAt', 'graceMinutesSnapshot', 'halfDayThresholdSnapshot', 'timezoneSnapshot');
    state[name] = (await client.query(`SELECT to_jsonb(t) - $1::text[] AS row FROM ${quote(name)} AS t ORDER BY ${quote(key)}`, [omit])).rows;
  }
  return state;
}

const attendance = (id, date, extraColumns = '', extraValues = '') => `
  INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",status,"updatedAt",
    "scheduledStartAt","scheduledEndAt","graceMinutesSnapshot","halfDayThresholdSnapshot","timezoneSnapshot"${extraColumns})
  VALUES ('${id}','employee1','office1','night','${date}','PRESENT',now(),
    '${date}T16:00:00Z'::timestamptz,'${date}T16:00:00Z'::timestamptz+interval '8 hours',15,240,'Asia/Dhaka'${extraValues})`;

try {
  execFileSync('initdb', ['-D', dataDir, '--no-locale', '-E', 'UTF8', '-A', 'trust'], { stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', dataDir, '-l', join(fixtureRoot, 'postgres.log'),
    '-o', `-k '${socketDir}' -h '' -p 5432`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  client = new pg.Client({ host: socketDir, port: 5432, database: 'postgres', user: userInfo().username });
  await client.connect();
  const version = (await client.query('SHOW server_version')).rows[0].server_version;
  log.push(`PostgreSQL ${version}; private Unix socket; TCP disabled; no application credentials.`);
  const migrationDir = join(root, 'prisma/migrations');
  // This archived review targets the schema before the overtime feature.
  const migrationNames = [
    '20260919000000_initial',
    '20260920000000_attendance_recent_index',
    '20260921000000_attendance_late_reason',
  ];
  for (const name of migrationNames) {
    await client.query(readFileSync(join(migrationDir, name, 'migration.sql'), 'utf8'));
    record(`existing migration ${name}`);
  }

  await client.query(`
    INSERT INTO "User" (id,name,email,role,"emailVerified","lastLoginAt","createdAt","updatedAt") VALUES
      ('user1','Employee One','one@example.test','EMPLOYEE','2026-01-01 01:02:03.456','2026-09-20 15:59:00.123','2026-01-01 01:02:03.456','2026-09-20 15:59:00.123'),
      ('user2','Employee Two','two@example.test','EMPLOYEE',NULL,NULL,'2026-01-01 01:02:03.456','2026-09-20 15:59:00.123'),
      ('admin','Administrator','admin@example.test','ADMIN',NULL,NULL,'2026-01-01 01:02:03.456','2026-09-20 15:59:00.123'),
      ('reviewer','Reviewer','reviewer@example.test','ADMIN',NULL,NULL,'2026-01-01 01:02:03.456','2026-09-20 15:59:00.123');
    INSERT INTO "Account" (id,"userId",type,provider,"providerAccountId",access_token) VALUES
      ('account1','user1','oidc','google','fixture-provider-id','synthetic-token');
    INSERT INTO "Session" (id,"sessionToken","userId",expires) VALUES
      ('session1','synthetic-session','user1','2026-12-01 00:00:00.123');
    INSERT INTO "Department" (id,name,"updatedAt") VALUES ('department1','Fixture',now());
    INSERT INTO "Office" (id,name,address,latitude,longitude,timezone,"updatedAt") VALUES
      ('office1','Dhaka','Fixture address',23.8103,90.4125,'Asia/Dhaka','2026-09-20 01:02:03.456');
    INSERT INTO "OfficeNetwork" (id,"officeId","publicIpOrCidr","updatedAt") VALUES
      ('network1','office1','192.0.2.0/24',now());
    INSERT INTO "Employee" (id,"employeeCode","userId","departmentId","officeId","updatedAt") VALUES
      ('employee1','EMP-ONE','user1','department1','office1',now()),
      ('employee2','EMP-TWO','user2','department1','office1',now());
    INSERT INTO "Shift" (id,name,"startTime","endTime",timezone,"updatedAt") VALUES
      ('day','Normal','09:00','17:30','Asia/Dhaka',now()),
      ('night','Overnight','22:00','06:00','Asia/Dhaka',now());
    INSERT INTO "EmployeeShift" (id,"employeeId","shiftId","startDate","endDate") VALUES
      ('assignment1','employee1','day','2026-01-01','2026-08-31'),
      ('assignment2','employee1','night','2026-09-01',NULL),
      ('assignment3','employee2','day','2026-01-01',NULL);
    INSERT INTO "WebAuthnCredential" (id,"employeeId",name,"credentialId","publicKey",counter,transports,"deviceType",approved) VALUES
      ('credential1','employee1','Fixture passkey','credential-bytes',decode('abcd','hex'),5,ARRAY['internal'],'singleDevice',true);
    INSERT INTO "WebAuthnChallenge" (id,"employeeId","sessionId",challenge,purpose,"expiresAt","createdAt") VALUES
      ('challenge1','employee1','session1','fixture-challenge','CHECK_OUT','2026-09-20 16:05:00.123','2026-09-20 16:00:00.123');
    INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate","checkInAt","checkOutAt",status,"lateMinutes","workedMinutes","updatedAt") VALUES
      ('attendance1','employee1','office1','night','2026-09-19','2026-09-19 16:05:00.123','2026-09-20 00:00:00.456','PRESENT',0,475,'2026-09-20 00:00:00.456'),
      ('attendance2','employee1','office1','night','2026-09-20','2026-09-20 16:05:00.123',NULL,'PRESENT',0,0,'2026-09-20 16:05:00.123'),
      ('attendance3','employee2','office1','day','2026-09-20',NULL,NULL,'ABSENT',0,0,'2026-09-20 16:05:00.123');
    INSERT INTO "Holiday" (id,name,date,"officeId","updatedAt") VALUES
      ('holiday1','Global','2026-12-25',NULL,now()),('holiday2','Office','2026-12-25','office1',now());
    INSERT INTO "Leave" (id,"employeeId","startDate","endDate",reason,status,"reviewedById","reviewedAt","updatedAt") VALUES
      ('leave1','employee1','2026-08-15','2026-08-16','Fixture','APPROVED','reviewer','2026-08-01 01:02:03.456',now());
    INSERT INTO "AuditLog" (id,"actorId",action,resource,"resourceId","previousState","newState","createdAt") VALUES
      ('audit1','admin','UPDATE','Shift','night','{"name":"Earlier"}','{"name":"Overnight"}','2026-09-01 00:00:00.789');
    INSERT INTO "RateLimit" (key,count,"resetAt") VALUES ('fixture',3,'2026-09-21 00:00:00.123');
    INSERT INTO "SystemSetting" (key,value,"updatedAt") VALUES ('fixture','{"value":true}','2026-09-01 00:00:00.789');
  `);
  for (const [i, eventType] of eventTypes.entries()) {
    await client.query(`INSERT INTO "AttendanceEvent" (id,"employeeId","attendanceId",type,metadata,"createdAt")
      VALUES ($1,'employee1','attendance1',$2,'{"fixture":true}','2026-09-20 00:00:00.456')`, [`event${i}`, eventType]);
  }
  record('representative legacy fixture covers all 18 models, 11 event types, nullable fields, overnight and normal shifts');
  const timestampColumns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND data_type='timestamp without time zone' ORDER BY table_name,column_name`)).rows;
  const timestampsBefore = await timestampState(timestampColumns);
  const modelNames = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map((row) => row.table_name);
  const beforeCounts = {};
  for (const name of modelNames) beforeCounts[name] = (await client.query(`SELECT count(*)::int AS n FROM ${quote(name)}`)).rows[0].n;
  const unchangedBefore = await unchangedFieldState(modelNames, timestampColumns);
  const proposal = readFileSync(join(import.meta.dirname, 'migration.sql'), 'utf8') + '\n' + readFileSync(join(import.meta.dirname, 'constraints.sql'), 'utf8');

  // Each deliberately bad legacy fixture and migration is rolled back together.
  await rejects('unknown historical event prevents deployment without dropping history',
    `INSERT INTO "AttendanceEvent" (id,type) VALUES ('unknown-event','UNKNOWN_LEGACY_TYPE');\n${proposal}`, '22P02');
  await rejects('orphan legacy reviewer prevents deployment',
    `UPDATE "Leave" SET "reviewedById"='missing-user' WHERE id='leave1';\n${proposal}`, '23503', 'Leave_reviewedById_fkey');
  await rejects('overlapping legacy assignment prevents deployment',
    `INSERT INTO "EmployeeShift" (id,"employeeId","shiftId","startDate","endDate") VALUES ('bad-assignment','employee1','night','2026-08-20','2026-09-03');\n${proposal}`, '23P01', 'EmployeeShift_no_overlapping_dates');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='Shift' AND column_name='startTime'`)).rows[0].n, 1);
  record('failed migration transaction fully restores original Shift columns and schema');

  await client.query(`SET TIME ZONE 'Asia/Tokyo'`);
  await client.query('BEGIN');
  try { await client.query(proposal); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  record('proposal migration.sql plus constraints.sql commits as one transaction');
  assert.deepEqual(await convertedTimestampState(timestampColumns), timestampsBefore);
  record(`all ${timestampColumns.length} original timestamp columns preserve every non-null instant and null despite non-UTC session`);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone'`)).rows[0].n, 0);
  record('all original instant columns converted to timestamp with time zone');
  assert.deepEqual(await unchangedFieldState(modelNames, timestampColumns), unchangedBefore);
  record('every remaining original column value preserved across all fixture rows, including SQL dates, relationships, JSON, arrays, counters, and bytes');
  for (const name of modelNames) assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${quote(name)}`)).rows[0].n, beforeCounts[name], `${name} row count`);
  assert.equal(modelNames.length, 18);
  record('all 18 model row counts preserved');
  assert.deepEqual((await client.query('SELECT id,"startMinute","endMinute" FROM "Shift" ORDER BY id')).rows,
    [{ id: 'day', startMinute: 540, endMinute: 1050 }, { id: 'night', startMinute: 1320, endMinute: 360 }]);
  record('HH:mm conversion preserves 09:00–17:30 and 22:00–06:00');
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM "Attendance" WHERE num_nonnulls("scheduledStartAt","scheduledEndAt","graceMinutesSnapshot","halfDayThresholdSnapshot","timezoneSnapshot")=0`)).rows[0].n, 3);
  record('historical schedules remain all-null; no fabricated snapshot backfill');
  assert.equal((await client.query(`SELECT "attendanceDate"::text AS day FROM "Attendance" WHERE id='attendance1'`)).rows[0].day, '2026-09-19');
  record('overnight business date preserved as PostgreSQL date');
  assert.deepEqual((await client.query('SELECT type::text AS type FROM "AttendanceEvent" ORDER BY id')).rows.map((row) => row.type).sort(), [...eventTypes].sort());
  record('all 11 enum event types and append-only history rows preserved');
  assert.deepEqual((await client.query('SELECT "previousState","newState" FROM "AuditLog" WHERE id=$1', ['audit1'])).rows[0], { previousState: { name: 'Earlier' }, newState: { name: 'Overnight' } });
  assert.equal((await client.query('SELECT encode("publicKey",\'hex\') AS key,counter::text FROM "WebAuthnCredential" WHERE id=$1', ['credential1'])).rows[0].key, 'abcd');
  record('audit JSON and WebAuthn public-key material preserved');

  for (const [label, sql, state, constraint] of [
    ['negative shift minute', `UPDATE "Shift" SET "startMinute"=-1 WHERE id='night'`, '23514', 'Shift_policy_valid'],
    ['minute 1440 rejected', `UPDATE "Shift" SET "endMinute"=1440 WHERE id='night'`, '23514', 'Shift_policy_valid'],
    ['equal shift endpoints rejected', `UPDATE "Shift" SET "endMinute"="startMinute" WHERE id='night'`, '23514', 'Shift_policy_valid'],
    ['negative grace rejected', `UPDATE "Shift" SET "graceMinutes"=-1 WHERE id='night'`, '23514', 'Shift_policy_valid'],
    ['zero half-day threshold rejected', `UPDATE "Shift" SET "halfDayThreshold"=0 WHERE id='night'`, '23514', 'Shift_policy_valid'],
    ['negative geofence radius rejected', `UPDATE "Office" SET "geofenceRadiusMeters"=-1 WHERE id='office1'`, '23514', 'Office_location_valid'],
    ['zero GPS accuracy limit rejected', `UPDATE "Office" SET "maximumGpsAccuracyMeters"=0 WHERE id='office1'`, '23514', 'Office_location_valid'],
    ['invalid office latitude rejected', `UPDATE "Office" SET latitude=91 WHERE id='office1'`, '23514', 'Office_location_valid'],
    ['invalid weekend value rejected', `UPDATE "Office" SET "weekendDays"=ARRAY[7] WHERE id='office1'`, '23514', 'Office_weekend_days_valid'],
    ['null weekend element rejected', `UPDATE "Office" SET "weekendDays"=ARRAY[0,NULL] WHERE id='office1'`, '23514', 'Office_weekend_days_valid'],
    ['negative work duration rejected', `UPDATE "Attendance" SET "workedMinutes"=-1 WHERE id='attendance1'`, '23514', 'Attendance_times_valid'],
    ['negative lateness rejected', `UPDATE "Attendance" SET "lateMinutes"=-1 WHERE id='attendance1'`, '23514', 'Attendance_times_valid'],
    ['checkout before checkin rejected', `UPDATE "Attendance" SET "checkOutAt"="checkInAt"-interval '1 minute' WHERE id='attendance1'`, '23514', 'Attendance_times_valid'],
    ['unpaired coordinate rejected', `UPDATE "Attendance" SET "checkInLatitude"=20 WHERE id='attendance1'`, '23514', 'Attendance_location_valid'],
    ['partial snapshots rejected', `UPDATE "Attendance" SET "graceMinutesSnapshot"=15 WHERE id='attendance1'`, '23514', 'Attendance_snapshot_valid'],
    ['new attendance without snapshots rejected', `INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",status,"updatedAt") VALUES ('no-snapshot','employee2','office1','day','2027-01-01','ABSENT',now())`, '23514', undefined],
    ['new check-in on legacy no-punch row requires snapshots', `UPDATE "Attendance" SET "checkInAt"='2026-09-20T16:00:00Z' WHERE id='attendance3'`, '23514', undefined],
    ['complete snapshot cannot be cleared', `UPDATE "Attendance" SET "scheduledStartAt"='2026-09-19T16:00:00Z',"scheduledEndAt"='2026-09-20T00:00:00Z',"graceMinutesSnapshot"=15,"halfDayThresholdSnapshot"=240,"timezoneSnapshot"='Asia/Dhaka' WHERE id='attendance1'; UPDATE "Attendance" SET "scheduledStartAt"=NULL,"scheduledEndAt"=NULL,"graceMinutesSnapshot"=NULL,"halfDayThresholdSnapshot"=NULL,"timezoneSnapshot"=NULL WHERE id='attendance1'`, '23514', undefined],
    ['snapshot missing timezone rejected', `UPDATE "Attendance" SET "scheduledStartAt"='2026-09-19T16:00:00Z',"scheduledEndAt"='2026-09-20T00:00:00Z',"graceMinutesSnapshot"=15,"halfDayThresholdSnapshot"=240 WHERE id='attendance1'`, '23514', 'Attendance_snapshot_valid'],
    ['reversed snapshot endpoints rejected', `UPDATE "Attendance" SET "scheduledStartAt"='2026-09-19T16:00:00Z',"scheduledEndAt"='2026-09-19T15:00:00Z',"graceMinutesSnapshot"=15,"halfDayThresholdSnapshot"=240,"timezoneSnapshot"='Asia/Dhaka' WHERE id='attendance1'`, '23514', 'Attendance_snapshot_valid'],
    ['wrong business date snapshot rejected', `UPDATE "Attendance" SET "scheduledStartAt"='2026-09-20T16:00:00Z',"scheduledEndAt"='2026-09-21T00:00:00Z',"graceMinutesSnapshot"=15,"halfDayThresholdSnapshot"=240,"timezoneSnapshot"='Asia/Dhaka' WHERE id='attendance1'`, '23514', 'Attendance_snapshot_valid'],
    ['negative rate-limit count rejected', `UPDATE "RateLimit" SET count=-1 WHERE key='fixture'`, '23514', 'RateLimit_count_valid'],
    ['challenge expires at creation rejected', `UPDATE "WebAuthnChallenge" SET "expiresAt"="createdAt" WHERE id='challenge1'`, '23514', 'WebAuthnChallenge_times_valid'],
    ['challenge used before creation rejected', `UPDATE "WebAuthnChallenge" SET "usedAt"="createdAt"-interval '1 second' WHERE id='challenge1'`, '23514', 'WebAuthnChallenge_times_valid'],
    ['challenge used at expiry rejected', `UPDATE "WebAuthnChallenge" SET "usedAt"="expiresAt" WHERE id='challenge1'`, '23514', 'WebAuthnChallenge_times_valid'],
    ['orphan leave reviewer rejected', `UPDATE "Leave" SET "reviewedById"='missing-user' WHERE id='leave1'`, '23503', 'Leave_reviewedById_fkey'],
    ['referenced reviewer deletion rejected', `DELETE FROM "User" WHERE id='reviewer'`, '23001', 'Leave_reviewedById_fkey'],
    ['reversed leave dates rejected', `UPDATE "Leave" SET "endDate"="startDate"-1 WHERE id='leave1'`, '23514', 'Leave_dates_valid'],
    ['reversed assignment dates rejected', `UPDATE "EmployeeShift" SET "endDate"="startDate"-1 WHERE id='assignment1'`, '23514', 'EmployeeShift_dates_valid'],
    ['overlapping assignment rejected', `INSERT INTO "EmployeeShift" (id,"employeeId","shiftId","startDate","endDate") VALUES ('overlap','employee1','night','2026-08-31','2026-09-02')`, '23P01', 'EmployeeShift_no_overlapping_dates'],
    ['duplicate global holiday rejected', `INSERT INTO "Holiday" (id,name,date,"officeId","updatedAt") VALUES ('duplicate-global','Other','2026-12-25',NULL,now())`, '23505', 'Holiday_global_date_unique'],
    ['duplicate office holiday rejected', `INSERT INTO "Holiday" (id,name,date,"officeId","updatedAt") VALUES ('duplicate-office','Other','2026-12-25','office1',now())`, '23505', 'Holiday_officeId_date_key'],
    ['second open attendance rejected', attendance('open3','2026-09-22',',"checkInAt"',",'2026-09-22T16:00:00Z'"), '23505', 'Attendance_one_open_per_employee'],
    ['duplicate business date rejected', attendance('duplicate-day','2026-09-19'), '23505', 'Attendance_employeeId_attendanceDate_key'],
    ['unknown new event type rejected', `INSERT INTO "AttendanceEvent" (id,type) VALUES ('unknown','NOT_A_TYPE')`, '22P02', undefined],
    ['event UPDATE remains forbidden', `UPDATE "AttendanceEvent" SET reason='altered' WHERE id='event0'`, 'P0001', undefined],
    ['event DELETE remains forbidden', `DELETE FROM "AttendanceEvent" WHERE id='event0'`, 'P0001', undefined],
    ['audit UPDATE remains forbidden', `UPDATE "AuditLog" SET action='altered' WHERE id='audit1'`, 'P0001', undefined],
    ['audit DELETE remains forbidden', `DELETE FROM "AuditLog" WHERE id='audit1'`, 'P0001', undefined],
  ]) await rejects(label, sql, state, constraint);

  for (const field of ['checkInAccuracy','checkOutAccuracy','checkInDistanceMeters','checkOutDistanceMeters']) {
    for (const value of ["'-1'", "'NaN'", "'Infinity'", "'-Infinity'"]) {
      await rejects(`${field} rejects ${value}`, `UPDATE "Attendance" SET ${quote(field)}=${value}::double precision WHERE id='attendance1'`, '23514', 'Attendance_location_valid');
    }
  }
  await accepts('valid complete overnight snapshot accepted', `UPDATE "Attendance" SET "scheduledStartAt"='2026-09-19T16:00:00Z',"scheduledEndAt"='2026-09-20T00:00:00Z',"graceMinutesSnapshot"=15,"halfDayThresholdSnapshot"=240,"timezoneSnapshot"='Asia/Dhaka' WHERE id='attendance1'`);
  await accepts('valid GPS zero accuracy/distance accepted', `UPDATE "Attendance" SET "checkInLatitude"=0,"checkInLongitude"=0,"checkInAccuracy"=0,"checkInDistanceMeters"=0 WHERE id='attendance1'`);
  await accepts('empty weekend set accepted', `UPDATE "Office" SET "weekendDays"=ARRAY[]::int[] WHERE id='office1'`);
  await accepts('adjacent inclusive assignment ranges accepted', `UPDATE "EmployeeShift" SET "endDate"='2026-12-31' WHERE id='assignment2'; INSERT INTO "EmployeeShift" (id,"employeeId","shiftId","startDate","endDate") VALUES ('adjacent','employee1','day','2027-01-01',NULL)`);
  await accepts('null leave reviewer retained for pending request', `INSERT INTO "Leave" (id,"employeeId","startDate","endDate",reason,"updatedAt") VALUES ('pending','employee2','2027-01-01','2027-01-02','fixture',now())`);

  const indexes = (await client.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`)).rows;
  const indexByName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
  for (const name of ['Attendance_one_open_per_employee','Holiday_global_date_unique',
    'User_status_role_idx','WebAuthnChallenge_context_idx', 'AttendanceEvent_attendanceId_createdAt_id_idx',
    'AttendanceEvent_employeeId_createdAt_id_idx','AttendanceEvent_type_createdAt_id_idx',
    'AttendanceEvent_createdAt_id_idx','Leave_status_createdAt_id_idx','AuditLog_createdAt_id_idx',
    'AuditLog_actorId_createdAt_id_idx','AuditLog_resource_resourceId_createdAt_id_idx',
    'Attendance_updatedAt_id_idx','EmployeeShift_no_overlapping_dates']) assert.ok(indexByName.has(name), name);
  for (const name of ['WebAuthnChallenge_employeeId_purpose_idx','AttendanceEvent_employeeId_createdAt_idx',
    'AttendanceEvent_type_createdAt_idx','Leave_status_idx','AuditLog_createdAt_idx','AuditLog_resource_resourceId_idx']) assert.ok(!indexByName.has(name), name);
  record('all replacement/new indexes exist; redundant superseded indexes absent; original partial unique indexes preserved');
  const constraints = (await client.query(`SELECT conrelid::regclass::text AS table_name,conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname`)).rows;
  assert.ok(constraints.every((row) => row.convalidated));
  record('every final constraint is validated');
  log.push('\nFinal index definitions:\n' + indexes.map((row) => row.indexdef + ';').join('\n'));
  log.push('\nFinal check/exclusion definitions:\n' + constraints.filter((row) => ['c','x'].includes(row.contype)).map((row) => `${row.table_name}.${row.conname}: ${row.definition}`).join('\n'));
} catch (error) {
  failure = error;
  log.push(`FAIL ${error.stack || error.message}`);
} finally {
  if (client) await client.end();
  if (started) {
    execFileSync('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
    log.push('Disposable PostgreSQL cluster stopped. Temporary files retained for inspection.');
  }
  const report = `# Schema proposal PostgreSQL rehearsal\n\nRun: ${new Date().toISOString()}\n\nResult: ${failure ? 'FAILED' : 'PASSED'}; ${counts.pass} checks passed.\n\n` +
    `Run command: \`node docs/schema-review/validation.mjs\`. The script creates its own temporary PostgreSQL cluster with TCP disabled; it does not load .env or use DATABASE_URL.\n\n` +
    `Fixture directory: \`${fixtureRoot}\`.\n\n\`\`\`text\n${log.join('\n')}\n\`\`\`\n`;
  writeFileSync(join(import.meta.dirname, 'validation.md'), report);
  console.log(JSON.stringify({ result: failure ? 'FAILED' : 'PASSED', checks: counts.pass, fixtureRoot, report: join(import.meta.dirname, 'validation.md') }));
  if (failure) throw failure;
}
