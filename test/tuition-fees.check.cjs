// Source-only checks, using in-memory doubles. No app/bootstrap or provider calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb, matches} = require('./helpers/memory-db.cjs');
const phone = source('modules/auth/phone-number.ts');
const {TuitionFeesService} = source('modules/tuition-fees/tuition-fees.service.ts', {
  '../../database/database.module': {Database: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
  '../auth/phone-number': phone,
});
const {SaveTuitionFeeDto} = source('modules/tuition-fees/tuition-fees.dto.ts');
const {NotificationAudienceService} = source('modules/notifications/notification-audience.service.ts', {'../../database/database.module': {Database: class {}}});
const {NotificationScheduler} = source('modules/notifications/notification-scheduler.service.ts', {
  '../../database/database.module': {Database: class {}}, './notification-events.service': {NotificationEventsService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}}, '../subscriptions/catalog': source('modules/subscriptions/catalog.ts'),
});
const {NotificationEventsService} = source('modules/notifications/notification-events.service.ts', {
  '../../database/database.module': {Database: class {}}, './delivery.service': {NotificationDelivery: class {}},
});
const actor = {_id: 'teacher', workspaceId: 'w', role: 'teacher', timezone: 'Asia/Jakarta'};
const parent = {_id: 'parent', workspaceId: 'w', role: 'parent', familyId: 'family', status: 'active'};
function setup(extra = {}) {
  const db = memoryDb({
    users: [{...actor, name: 'Guru', phone: '081234567890'}],
    workspaces: [{_id: 'w', ownerId: 'teacher'}], families: [{_id: 'family', workspaceId: 'w'}],
    students: [{_id: 'child', workspaceId: 'w', familyId: 'family', status: 'active', name: 'Alya', notes: 'private'},
      {_id: 'other-child', workspaceId: 'w', familyId: 'other-family', status: 'active'}],
    portalAccounts: [parent, {_id: 'student', workspaceId: 'w', role: 'student', studentId: 'child', status: 'active'}],
    tuitionFees: [], ...extra,
  });
  const subscriptions = {canUse: async () => true};
  return {db, service: new TuitionFeesService(db, subscriptions)};
}

test('DTO requires integer positive amount, actual date-only due date, explicit status/version and no ownership', async () => {
  const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
  const validate = value => pipe.transform(value, {type: 'body', metatype: SaveTuitionFeeDto});
  const valid = {amount: 250000, dueDate: '2030-01-31', status: 'unpaid', version: 0};
  assert.equal((await validate(valid)).amount, 250000);
  for (const change of [{amount: 0}, {amount: -10}, {amount: 1.5}, {amount: '250000'}, {amount: 1000000000001},
    {dueDate: '2030-02-30'}, {dueDate: '2030-01-01T00:00:00Z'}, {dueDate: ''},
    {status: 'pending'}, {version: -1}, {version: null}, {studentId: 'other-child'}, {workspaceId: 'other'}]) {
    await assert.rejects(validate({...valid, ...change}));
  }
});

test('new fee and unpaid/paid updates persist per child with conditional version and owner contact only', async () => {
  const {service, db} = setup();
  assert.equal((await service.get(actor, 'child')).fee, null);
  const first = await service.save(actor, 'child', {amount: 250000, dueDate: '2030-01-31', status: 'unpaid', version: 0});
  assert.equal(first.fee.version, 1); assert.equal(first.fee.amount, 250000);
  assert.equal(first.teacher.phone, '+6281234567890'); assert.equal(first.teacher.email, undefined);
  const unchanged = await service.save(actor, 'child', {amount: 250000, dueDate: '2030-01-31', status: 'unpaid', version: 1});
  assert.equal(unchanged.fee.version, 1); // Re-saving an unchanged fee must not create a new reminder revision.
  await assert.rejects(service.save(actor, 'child', {amount: 100, dueDate: '2030-01-31', status: 'paid', version: 0}), /sudah berubah/);
  const paid = await service.save(actor, 'child', {amount: 250000, dueDate: '2030-01-31', status: 'paid', version: 1});
  assert.equal(paid.fee.status, 'paid'); assert.ok(paid.fee.paidAt instanceof Date);
  const next = await service.save(actor, 'child', {amount: 300000, dueDate: '2030-02-28', status: 'unpaid', version: 2});
  assert.equal(next.fee.version, 3); assert.equal(next.fee.paidAt, null);
  assert.equal(db.data.tuitionFees.length, 1);
});

test('teacher and parent must stay in their workspace/current family; student role cannot access tuition', async () => {
  const {service, db} = setup();
  const draft = {amount: 100, dueDate: '2030-01-31', status: 'unpaid', version: 0};
  await assert.rejects(service.get({...actor, workspaceId: 'foreign'}, 'child'), /tidak tersedia/);
  await assert.rejects(service.save({...actor, workspaceId: 'foreign'}, 'child', draft), /tidak tersedia/);
  await service.save(actor, 'child', draft);
  const overview = await service.parent(parent, 'child');
  assert.equal(overview.fee.amount, 100); assert.equal(overview.fee.workspaceId, undefined);
  await assert.rejects(service.parent(parent, 'other-child'), /tidak tersedia/);
  await assert.rejects(service.parent({...parent, role: 'student'}, 'child'), /hanya dibagikan/);
  db.data.students[0].familyId = 'other-family';
  await assert.rejects(service.parent(parent, 'child'), /tidak tersedia/);
  db.data.students[0].status = 'archived';
  await assert.rejects(service.save(actor, 'child', {...draft, version: 1}), /siswa aktif/);
});

test('missing/invalid teacher phone yields null and never fabricates a WhatsApp recipient', async () => {
  const {service, db} = setup();
  db.data.users[0].phone = undefined;
  assert.equal((await service.parent(parent, 'child')).teacher.phone, null);
  db.data.users[0].phone = 'javascript:bad';
  assert.equal((await service.parent(parent, 'child')).teacher.phone, null);
});

test('scheduler emits H-1 and due-day only to parents, once per revision/stage, across month/year boundary', async () => {
  const {db} = setup({tuitionFees: [{_id: 'fee', workspaceId: 'w', studentId: 'child', amount: 250000, dueDate: '2031-01-01', status: 'unpaid', version: 1}]});
  const events = new NotificationEventsService(db, {deliver: async () => {}});
  const worker = new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => true});
  await worker.run(new Date('2030-12-30T17:01:00Z')); // Dec 31 WIB
  await worker.run(new Date('2030-12-31T10:00:00Z'));
  assert.equal(db.data.notifications.length, 1);
  const h1 = db.data.notifications[0];
  assert.equal(h1.recipientAccountId, 'parent');
  assert.equal(h1.route, '/parent/students/child?tab=tuition');
  assert.match(h1.eventKey, /:tomorrow:parent:parent$/);
  assert.equal(h1.deliveryExpiresAt.toISOString(), '2030-12-31T17:00:00.000Z');
  await worker.run(new Date('2030-12-31T17:01:00Z')); // Jan 1 WIB
  await worker.run(new Date('2031-01-01T10:00:00Z'));
  const parentRows = db.data.notifications.filter(row => row.route.startsWith('/parent/'));
  assert.equal(parentRows.length, 2);
  assert.match(parentRows[1].eventKey, /:today:parent:parent$/);
  assert.equal(parentRows[1].deliveryExpiresAt.toISOString(), '2031-01-01T17:00:00.000Z');
  assert.ok(db.data.notifications.every(row => row.recipientAccountId !== 'student'));
});

test('paid/archived/foreign fees and Basic/no-reminder entitlement do not generate parent reminders', async () => {
  const {db} = setup({tuitionFees: [
    {_id: 'paid', workspaceId: 'w', studentId: 'child', dueDate: '2031-01-01', status: 'paid'},
    {_id: 'other', workspaceId: 'foreign', studentId: 'child', dueDate: '2031-01-01', status: 'unpaid'},
  ]});
  const events = new NotificationEventsService(db, {deliver: async () => {}});
  await new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => true}).run(new Date('2030-12-31T18:00:00Z'));
  assert.equal(db.data.notifications?.length ?? 0, 0);
  db.data.tuitionFees = [{_id: 'unpaid', workspaceId: 'w', studentId: 'child', dueDate: '2031-01-01', amount: 100, status: 'unpaid', version: 1}];
  await new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => false}).run(new Date('2030-12-31T18:00:00Z'));
  assert.equal(db.data.notifications?.length ?? 0, 0);
  db.data.students[0].status = 'archived';
  await new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => true}).run(new Date('2030-12-31T18:00:00Z'));
  assert.equal(db.data.notifications?.length ?? 0, 0);
});

test('delivery rechecks paid/revised/due-date/membership/route and refuses teacher/student recipients', async () => {
  const fee = {_id: 'fee', workspaceId: 'w', studentId: 'child', status: 'unpaid', dueDate: '2031-01-01', version: 1};
  const notification = {workspaceId: 'w', recipientAccountId: 'parent', route: '/parent/students/child?tab=tuition', eventKey: 'tuition-due:fee:1:2031-01-01:today:parent:parent'};
  const {db} = setup({tuitionFees: [{...fee}]});
  const audience = new NotificationAudienceService(db);
  assert.deepEqual(await audience.resolve(notification), {accountType: 'parent', accountIds: ['parent']});
  assert.equal(await audience.resolve({...notification, eventKey: notification.eventKey.replace(':1:', ':bad:')}), null);
  for (const patch of [{status: 'paid'}, {version: 2}, {dueDate: '2031-02-01'}]) {
    Object.assign(db.data.tuitionFees[0], fee, patch);
    assert.equal(await audience.resolve(notification), null);
  }
  db.data.tuitionFees[0] = {...fee};
  assert.deepEqual(await audience.resolve(notification), {accountType: 'parent', accountIds: ['parent']});
  assert.equal(await audience.resolve({...notification, route: '/teacher/home'}), null);
  assert.equal(await audience.resolve({...notification, recipientAccountId: 'student', route: '/student/home'}), null);
  assert.equal(await audience.resolve({...notification, route: '/parent/students/other-child?tab=tuition'}), null);
  db.data.students[0].familyId = 'other-family';
  assert.equal(await audience.resolve(notification), null);
});

test('parent inbox includes only current child fee revisions and hides stale/settled/moved-child reminders', async () => {
  const {ParentPortalService} = source('modules/parent-portal/parent-portal.service.ts', {
    '../../database/database.module': {Database: class {}}, '../subscriptions/subscriptions.service': {},
    '../students/student-summary.service': {}, '../students/student-list-progress.service': {},
    '../students/student-summary.rules': {}, '../learning-plans/progress.rules': {}, '../dashboard/dashboard.rules': {},
    './parent-portal.views': {}, '../notifications/notification-events.service': {}, '../../common/calendar-lock': {},
  });
  const {db} = setup({tuitionFees: [{_id: 'fee', workspaceId: 'w', studentId: 'child', status: 'unpaid', dueDate: '2031-01-01', version: 1}]});
  const service = new ParentPortalService(db);
  const row = {workspaceId: 'w', recipientAccountId: 'parent', route: '/parent/students/child?tab=tuition', eventKey: 'tuition-due:fee:1:2031-01-01:today:parent:parent'};
  assert.equal(matches(row, await service.notificationScope(parent)), true);
  assert.equal(matches({...row, eventKey: row.eventKey.replace(':1:', ':0:')}, await service.notificationScope(parent)), false);
  db.data.tuitionFees[0].status = 'paid';
  assert.equal(matches(row, await service.notificationScope(parent)), false);
  db.data.tuitionFees[0].status = 'unpaid'; db.data.students[0].familyId = 'other-family';
  assert.equal(matches(row, await service.notificationScope(parent)), false);
});
