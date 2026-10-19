const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const {NotificationAudienceService} = source('modules/notifications/notification-audience.service.ts', {'../../database/database.module': {Database: class {}}});
function setup() {
  const db = memoryDb({
    users: [{_id: 'teacher-a', workspaceId: 'a', role: 'teacher'}],
    portalAccounts: [
      {_id: 'parent-a', workspaceId: 'a', role: 'parent', familyId: 'family-a', status: 'active'},
      {_id: 'student-a', workspaceId: 'a', role: 'student', studentId: 'child-a', status: 'active'},
    ],
    families: [{_id: 'family-a', workspaceId: 'a'}],
    students: [{_id: 'child-a', workspaceId: 'a', familyId: 'family-a', status: 'active'}, {_id: 'sibling-a', workspaceId: 'a', familyId: 'family-a', status: 'active'}],
    sessions: [{_id: 'session-a', workspaceId: 'a', studentId: 'child-a', status: 'scheduled'}],
    reports: [{_id: 'report-a', workspaceId: 'a', studentId: 'child-a', visibility: 'shared', status: 'published'}],
  });
  const service = new NotificationAudienceService(db);
  const notification = {workspaceId: 'a', recipientAccountId: 'parent-a', route: '/parent/sessions/session-a', eventKey: 'attendance:session-a:present:parent-a'};
  return {db, service, notification};
}
test('attendance resolves only the currently authorized parent', async () => {
  const {service, notification} = setup();
  assert.deepEqual(await service.resolve(notification), {accountType: 'parent', accountIds: ['parent-a']});
});
test('revoked account, moved/archived child and different workspace cannot receive a queued push', async () => {
  const mutations = [
    db => {db.data.portalAccounts[0].status = 'revoked';},
    db => {db.data.students[0].familyId = 'new-family';},
    db => {db.data.students[0].status = 'archived';},
    db => {db.data.sessions[0].workspaceId = 'other';},
    db => {db.data.families.length = 0;},
  ];
  for (const mutate of mutations) {const {db, service, notification} = setup(); mutate(db); assert.equal(await service.resolve(notification), null);}
});
test('student cannot receive sibling notifications, even in the same family', async () => {
  const {db, service, notification} = setup();
  db.data.sessions[0].studentId = 'sibling-a';
  assert.equal(await service.resolve({...notification, recipientAccountId: 'student-a', route: '/student/sessions/session-a'}), null);
});
test('report delivery rechecks published/shared visibility', async () => {
  const {db, service} = setup();
  const notification = {workspaceId: 'a', recipientAccountId: 'parent-a', route: '/parent/reports/report-a', eventKey: 'report:report-a:published:parent:parent-a'};
  assert.ok(await service.resolve(notification));
  db.data.reports[0].visibility = 'student'; assert.equal(await service.resolve(notification), null);
  db.data.reports[0].visibility = 'shared'; db.data.reports[0].status = 'draft'; assert.equal(await service.resolve(notification), null);
});
test('teacher broadcasts never resolve portal accounts or another workspace', async () => {
  const {service} = setup();
  assert.deepEqual(await service.resolve({workspaceId: 'a', route: '/teacher/reschedule-requests', eventKey: 'reschedule-request:request-a'}), {accountType: 'teacher', accountIds: ['teacher-a']});
  assert.equal(await service.resolve({workspaceId: 'a', recipientAccountId: 'parent-a', route: '/teacher/reschedule-requests', eventKey: 'reschedule-request:request-a'}), null);
  assert.equal(await service.resolve({workspaceId: 'other', route: '/teacher/reschedule-requests', eventKey: 'reschedule-request:request-a'}), null);
});
test('unknown or wrong-role portal events fail closed', async () => {
  const {service, notification} = setup();
  assert.equal(await service.resolve({...notification, eventKey: 'unknown:session-a'}), null);
  assert.equal(await service.resolve({...notification, route: '/student/sessions/session-a'}), null);
});
test('expired reminders and completed targets are suppressed for teacher as well as portals', async () => {
  const {db, service, notification} = setup();
  db.data.targets = [{_id: 'target-a', workspaceId: 'a', studentId: 'child-a', status: 'active', progress: 50}];
  const reminder = {...notification, recipientAccountId: 'teacher-a', route: '/teacher/targets/target-a', eventKey: 'target-due:target-a:date:teacher:teacher-a'};
  assert.ok(await service.resolve(reminder));
  assert.equal(await service.resolve({...reminder, deliveryExpiresAt: new Date(0)}), null);
  db.data.targets[0].progress = 100; assert.equal(await service.resolve(reminder), null);
});
test('renewed subscription suppresses pending reminder for the old expiration', async () => {
  const {db, service} = setup();
  const oldEnd = new Date(Date.now() + 86400_000);
  db.data.subscriptions = [{_id: 'sub-a', workspaceId: 'a', plan: 'basic', paidThrough: oldEnd}];
  const notification = {workspaceId: 'a', recipientAccountId: 'teacher-a', route: '/teacher/subscription', eventKey: `subscription-expiring:sub-a:${oldEnd.getTime()}:1:teacher:teacher-a`, deliveryExpiresAt: oldEnd};
  assert.ok(await service.resolve(notification));
  db.data.subscriptions[0].paidThrough = new Date(oldEnd.getTime() + 30 * 86400_000);
  assert.equal(await service.resolve(notification), null);
});
