// Source-only checks: no server, real accounts, database or Firebase calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const phone = source('modules/auth/phone-number.ts');
const {UpdateTeacherPhoneDto, UpdateTeacherTimezoneDto} = source('modules/teacher-profile/teacher-profile.dto.ts', {'../auth/phone-number': phone});
const {TeacherProfileService} = source('modules/teacher-profile/teacher-profile.service.ts', {
  '../../database/database.module': {Database: class {}}, '../auth/phone-number': phone,
});
const actor = {_id: 'teacher', workspaceId: 'workspace', role: 'teacher'};
const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
const validate = value => pipe.transform(value, {type: 'body', metatype: UpdateTeacherPhoneDto});

test('phone DTO normalizes Indonesian numbers and rejects blank, foreign, null and ownership fields', async () => {
  for (const value of ['0812 3456-7890', '6281234567890', '+6281234567890']) {
    assert.equal((await validate({phone: value})).phone, '+6281234567890');
  }
  for (const value of [undefined, null, '', '   ', 81234567890, '+1234567890', '123', 'x'.repeat(33)]) {
    await assert.rejects(validate({phone: value}));
  }
  for (const key of ['workspaceId', 'userId', 'role', 'avatarId', 'email', 'passwordHash']) {
    await assert.rejects(validate({phone: '081234567890', [key]: 'other'}));
  }
});

for (const google of [true, false]) test(`${google ? 'Google' : 'registered'} teacher adds/edits only their own phone without touching credentials or avatar`, async () => {
  const users = [{...actor, email: 'teacher@example.test', passwordHash: 'unchanged', avatarId: 'teacher_man_01',
    ...(google ? {firebaseUid: 'firebase-user'} : {phone: '+6289876543210'})},
    {_id: 'other', workspaceId: 'other-workspace', role: 'teacher', phone: '+6287654321098'}];
  const db = memoryDb({users});
  const before = structuredClone(users);
  const service = new TeacherProfileService(db);
  assert.deepEqual(await service.updatePhone(actor, '0812 3456-7890'), {phone: '+6281234567890'});
  assert.deepEqual(users[0], {...before[0], phone: '+6281234567890'});
  assert.deepEqual(users[1], before[1]);
  assert.deepEqual(await service.updatePhone(actor, '081234567890'), {phone: '+6281234567890'});
});

test('wrong role, missing/deleting account and mismatched workspace cannot update a phone', async () => {
  const db = memoryDb({users: [{...actor}]});
  const service = new TeacherProfileService(db);
  await assert.rejects(service.updatePhone({...actor, role: 'parent'}, '081234567890'), error => error.getStatus() === 403);
  for (const principal of [{...actor, workspaceId: 'foreign'}, {...actor, _id: 'unknown'}]) {
    await assert.rejects(service.updatePhone(principal, '081234567890'), error => error.getStatus() === 401);
  }
  db.data.users[0].deletionRequestedAt = new Date();
  await assert.rejects(service.updatePhone(actor, '081234567890'), error => error.getStatus() === 401);
  assert.equal(db.data.users[0].phone, undefined);
});

test('service independently validates phone instead of relying on DTO validation', async () => {
  const db = memoryDb({users: [{...actor}]});
  await assert.rejects(new TeacherProfileService(db).updatePhone(actor, ''), error => error.getStatus() === 400);
  assert.equal(db.data.users[0].phone, undefined);
});

test('unique-index collision returns a useful conflict without exposing database or other account data', async () => {
  const db = {collection: () => ({findOneAndUpdate: (_filter, _update, options) => {
    assert.equal(options.runValidators, true); assert.equal(options.maxTimeMS, 5000);
    return {select: () => ({lean: async () => {throw {code: 11000, keyPattern: {phone: 1}};}})};
  }})};
  await assert.rejects(new TeacherProfileService(db).updatePhone(actor, '081234567890'), error =>
    error.getStatus() === 409 && /sudah digunakan akun lain/.test(error.message) && !error.message.includes('11000'));
});

test('phone route stays authenticated and delegates only the phone value to the service', async () => {
  const {TeacherProfileController} = source('modules/teacher-profile/teacher-profile.module.ts', {
    '../../common/api': {Actor: () => () => {}},
    './teacher-profile.dto': {UpdateTeacherPhoneDto, UpdateTeacherTimezoneDto}, './teacher-profile.service': {TeacherProfileService},
  });
  assert.equal(Reflect.getMetadata('public', TeacherProfileController), undefined);
  assert.equal(Reflect.getMetadata('path', TeacherProfileController), 'me');
  assert.equal(Reflect.getMetadata('path', TeacherProfileController.prototype.updatePhone), 'phone');
  assert.equal(Reflect.getMetadata('public', TeacherProfileController.prototype.updatePhone), undefined);
  let received;
  const controller = new TeacherProfileController({updatePhone: async (...args) => {received = args; return {phone: '+6281234567890'};}});
  await controller.updatePhone(actor, {phone: '081234567890'});
  assert.deepEqual(received, [actor, '081234567890']);
});

test('self phone edit remains allowed after expiry but other profile/academic mutations stay guarded', async () => {
  const {SubscriptionGuard} = source('modules/subscriptions/subscriptions.guard.ts', {'./subscriptions.service': {SubscriptionsService: class {}}});
  const guard = new SubscriptionGuard({getAllAndOverride: () => undefined}, {requireActive: async () => {throw new Error('expired');}});
  const context = path => ({getHandler() {}, getClass() {}, switchToHttp: () => ({getRequest: () => ({method: 'PATCH', path, user: actor})})});
  assert.equal(await guard.canActivate(context('/api/v1/me/phone')), true);
  assert.equal(await guard.canActivate(context('/api/v1/me/timezone')), true);
  await assert.rejects(guard.canActivate(context('/api/v1/me')), /expired/);
  await assert.rejects(guard.canActivate(context('/api/v1/students/other')), /expired/);
});

test('timezone DTO allows only the three exact IANA values, rejecting ownership and unexpected fields', async () => {
  const validateTimezone = value => pipe.transform(value, {type: 'body', metatype: UpdateTeacherTimezoneDto});
  for (const timezone of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']) {
    assert.equal((await validateTimezone({timezone})).timezone, timezone);
  }
  for (const timezone of [undefined, null, '', 'WIB', 'asia/jakarta', ' Asia/Jakarta ', 'UTC', 'America/New_York', 7]) {
    await assert.rejects(validateTimezone({timezone}));
  }
  for (const key of ['workspaceId', 'userId', 'role', 'startAt', 'phone', 'avatarId']) {
    await assert.rejects(validateTimezone({timezone: 'Asia/Jayapura', [key]: 'other'}));
  }
});

test('timezone update changes only the current teacher and never rewrites existing series, UTC occurrences or identity', async () => {
  const db = memoryDb({
    users: [{...actor, timezone: 'Asia/Jakarta', phone: '+6281234567890', avatarId: 'avatar', email: 'me@example.test'}, {_id: 'other', workspaceId: 'elsewhere', timezone: 'Asia/Jakarta'}],
    schedules: [{_id: 'series', workspaceId: 'workspace', timezone: 'Asia/Jakarta', repeatDays: [1, 3], startAt: new Date('2026-10-19T09:00:00Z')}],
    sessions: [{_id: 'occurrence', scheduleId: 'series', workspaceId: 'workspace', startAt: new Date('2026-10-19T09:00:00Z')}],
  });
  const before = structuredClone(db.data);
  const service = new TeacherProfileService(db);
  for (const timezone of ['Asia/Makassar', 'Asia/Jayapura', 'Asia/Jakarta']) {
    assert.deepEqual(await service.updateTimezone(actor, timezone), {timezone});
    assert.deepEqual(db.data.users[0], {...before.users[0], timezone});
    assert.deepEqual(db.data.users[1], before.users[1]);
    assert.deepEqual(db.data.schedules, before.schedules);
    assert.deepEqual(db.data.sessions, before.sessions);
  }
});

test('timezone service validates role, value, closed accounts and workspace independently', async () => {
  const db = memoryDb({users: [{...actor, timezone: 'Asia/Jakarta'}]});
  const service = new TeacherProfileService(db);
  for (const role of ['parent', 'student']) {
    await assert.rejects(service.updateTimezone({...actor, role}, 'Asia/Makassar'), e => e.getStatus() === 403);
  }
  await assert.rejects(service.updateTimezone(actor, 'WITA'), e => e.getStatus() === 400);
  for (const principal of [{...actor, _id: 'unknown'}, {...actor, workspaceId: 'foreign'}]) {
    await assert.rejects(service.updateTimezone(principal, 'Asia/Makassar'), e => e.getStatus() === 401);
  }
  db.data.users[0].deletionRequestedAt = new Date();
  await assert.rejects(service.updateTimezone(actor, 'Asia/Makassar'), e => e.getStatus() === 401);
  assert.equal(db.data.users[0].timezone, 'Asia/Jakarta');
});

test('timezone route is authenticated, narrowly delegates and imposes no Pro entitlement', async () => {
  const {TeacherProfileController} = source('modules/teacher-profile/teacher-profile.module.ts', {
    '../../common/api': {Actor: () => () => {}},
    './teacher-profile.dto': {UpdateTeacherPhoneDto, UpdateTeacherTimezoneDto}, './teacher-profile.service': {TeacherProfileService},
  });
  const handler = TeacherProfileController.prototype.updateTimezone;
  assert.equal(Reflect.getMetadata('path', handler), 'timezone');
  assert.equal(Reflect.getMetadata('public', handler), undefined);
  assert.equal(Reflect.getMetadata('subscriptionFeature', handler), undefined);
  let received;
  await new TeacherProfileController({updateTimezone: async (...args) => {received = args;}}).updateTimezone(actor, {timezone: 'Asia/Makassar'});
  assert.deepEqual(received, [actor, 'Asia/Makassar']);
});
