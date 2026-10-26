// Source-only contracts: no Nest bootstrap, server, dist, network or real database.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {existsSync} = require('node:fs');
const {resolve} = require('node:path');
require('reflect-metadata');
const {ValidationPipe, ForbiddenException, UnauthorizedException, SetMetadata} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const catalog = source('modules/avatars/avatar-catalog.ts');
const {UpdateAvatarDto} = source('modules/avatars/avatars.dto.ts');
const {UpdateStudentDto} = source('modules/students/students.dto.ts');
const {AvatarsService} = source('modules/avatars/avatars.service.ts', {
  '../../database/database.module': {Database: class {}}, './avatar-catalog': catalog,
});
const teacher = {_id: 'teacher-a', workspaceId: 'a', role: 'teacher'};
const account = {_id: 'account-a', workspaceId: 'a', role: 'student', studentId: 'student-a', status: 'active'};
function setup() {
  const data = {users: [{...teacher}, {_id: 'teacher-b', workspaceId: 'b', role: 'teacher'}],
    students: [{_id: 'student-a', workspaceId: 'a', status: 'active'}, {_id: 'sibling', workspaceId: 'a', status: 'active'}, {_id: 'student-b', workspaceId: 'b', status: 'active'}],
    portalAccounts: [{...account}]};
  return {data, service: new AvatarsService(memoryDb(data))};
}

test('catalog restricts teacher/student roles, resolves every supplied asset and allows initials', () => {
  const teachers = catalog.avatarOptions('teacher');
  const students = catalog.avatarOptions('student');
  assert.equal(teachers.length, 6); assert.equal(students.length, 12);
  assert.ok(teachers.every(entry => entry.category === 'teacher'));
  assert.ok(students.every(entry => ['adult', 'student'].includes(entry.category)));
  assert.equal(new Set(catalog.avatarAssets.map(entry => entry.avatarId)).size, 18);
  for (const entry of catalog.avatarAssets) assert.ok(existsSync(resolve(catalog.avatarAssetsRoot, entry.file)));
  for (const audience of ['teacher', 'student']) {
    assert.equal(catalog.allowedAvatar(audience, null), true);
    for (const invalid of ['', undefined, '../../.env', 'https://example.test/image', 'unknown']) assert.equal(catalog.allowedAvatar(audience, invalid), false);
  }
});

test('teacher can only change their own profile; student edits never affect siblings/other tenants', async () => {
  const {data, service} = setup();
  assert.deepEqual(await service.teacher(teacher, 'teacher_man_01'), {avatarId: 'teacher_man_01'});
  assert.equal(data.users[0].avatarId, 'teacher_man_01'); assert.equal(data.users[1].avatarId, undefined);
  await service.student(account, 'adult_woman_hijab_01');
  assert.equal(data.students[0].avatarId, 'adult_woman_hijab_01');
  assert.equal(data.students[1].avatarId, undefined); assert.equal(data.students[2].avatarId, undefined);
  await service.student(account, null); await service.teacher(teacher, null);
  assert.equal(data.students[0].avatarId, null); assert.equal(data.users[0].avatarId, null);
});

test('wrong-role characters and parent attempts are denied before writes', async () => {
  const {data, service} = setup();
  const original = structuredClone(data);
  await assert.rejects(service.teacher(teacher, 'student_boy_01'), /tidak tersedia/);
  await assert.rejects(service.student(account, 'teacher_man_01'), /tidak tersedia/);
  await assert.rejects(service.student({...account, role: 'parent'}, 'student_boy_01'), ForbiddenException);
  await assert.rejects(service.teacher({...teacher, role: 'student'}, 'teacher_man_01'), ForbiddenException);
  assert.deepEqual(data, original);
});

test('revoked sessions, mismatched workspace, archived students and closed teachers cannot write', async () => {
  for (const update of [ctx => ctx.data.portalAccounts[0].status = 'revoked', ctx => ctx.data.students[0].status = 'archived']) {
    const ctx = setup(); update(ctx);
    await assert.rejects(ctx.service.student(account, 'student_boy_01'), UnauthorizedException);
    assert.equal(ctx.data.students[0].avatarId, undefined);
  }
  const ctx = setup();
  await assert.rejects(ctx.service.student({...account, workspaceId: 'b'}, 'student_boy_01'), UnauthorizedException);
  ctx.data.users[0].deletionRequestedAt = new Date();
  await assert.rejects(ctx.service.teacher(teacher, 'teacher_man_01'), UnauthorizedException);
  assert.equal(ctx.data.users[0].avatarId, undefined);
});

test('DTO rejects owner/path injection and teacher student-edit DTO rejects avatar changes', async () => {
  const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
  for (const payload of [{}, {avatarId: 4}, {avatarId: 'x'.repeat(81)}, {avatarId: null, studentId: 'sibling'}, {avatarId: null, workspaceId: 'b'}, {avatarId: null, path: '../../.env'}]) {
    await assert.rejects(pipe.transform(payload, {type: 'body', metatype: UpdateAvatarDto}));
  }
  for (const payload of [{avatarId: null}, {avatarId: 'student_boy_01'}]) {
    assert.deepEqual(await pipe.transform(payload, {type: 'body', metatype: UpdateAvatarDto}), Object.assign(new UpdateAvatarDto(), payload));
    await assert.rejects(pipe.transform(payload, {type: 'body', metatype: UpdateStudentDto}));
  }
});

test('teacher routes retain auth; student routes require portal guard and parent catalog is denied', () => {
  class PortalAuthGuard {}
  const {AvatarsController} = source('modules/avatars/avatars.module.ts', {
    '../../common/api': {Actor: () => () => {}, Public: () => SetMetadata('public', true)},
    '../invitations/invitations.module': {InvitationsModule: class {}},
    '../invitations/portal.guard': {PortalAuthGuard},
    './avatar-catalog': catalog, './avatars.dto': {UpdateAvatarDto}, './avatars.service': {AvatarsService},
  });
  assert.equal(Reflect.getMetadata('public', AvatarsController), undefined);
  for (const method of ['teacherOptions', 'teacher']) assert.equal(Reflect.getMetadata('public', AvatarsController.prototype[method]), undefined);
  for (const method of ['studentOptions', 'student']) {
    assert.equal(Reflect.getMetadata('public', AvatarsController.prototype[method]), true);
    assert.deepEqual(Reflect.getMetadata('__guards__', AvatarsController.prototype[method]), [PortalAuthGuard]);
  }
  const controller = new AvatarsController(setup().service);
  assert.throws(() => controller.studentOptions({portalAccount: {...account, role: 'parent'}}), ForbiddenException);
  assert.throws(() => controller.image('../../.env', {}), /tidak ditemukan/);
  let sent;
  controller.image('student_boy_01', {sendFile(file, options) {sent = {file, options};}});
  assert.equal(sent.file, 'student/student_boy_01.webp');
  assert.equal(sent.options.root, catalog.avatarAssetsRoot);
});

test('avatar self-edit is allowed after subscription expiry without opening academic writes', async () => {
  const {SubscriptionGuard} = source('modules/subscriptions/subscriptions.guard.ts', {
    './subscriptions.service': {SubscriptionsService: class {}},
  });
  let checked = 0;
  const guard = new SubscriptionGuard({getAllAndOverride: () => undefined}, {
    async requireActive() {checked++; throw new Error('expired');},
  });
  const context = path => ({getHandler() {}, getClass() {}, switchToHttp: () => ({getRequest: () => ({method: 'PATCH', path, user: teacher, body: {avatarId: 'teacher_man_01'}})})});
  assert.equal(await guard.canActivate(context('/api/v1/me/avatar')), true);
  assert.equal(checked, 0);
  await assert.rejects(guard.canActivate(context('/api/v1/students/sibling')), /expired/);
  assert.equal(checked, 1);
});
