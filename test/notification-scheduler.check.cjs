const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const catalog = source('modules/subscriptions/catalog.ts');
const {NotificationScheduler} = source('modules/notifications/notification-scheduler.service.ts', {
  '../../database/database.module': {Database: class {}}, './notification-events.service': {NotificationEventsService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
  '../subscriptions/catalog': catalog,
});
test('one workspace failure does not stop another and new H-1 events expire at the next local midnight', async () => {
  const db = memoryDb({
    users: [{workspaceId: 'unavailable', role: 'teacher', timezone: 'Asia/Jakarta'}, {workspaceId: 'healthy', role: 'teacher', timezone: 'Asia/Jakarta'}],
    students: [{_id: 'child', workspaceId: 'healthy', name: 'Student'}],
    subjects: [{_id: 'subject', workspaceId: 'healthy', name: 'Music'}],
    plans: [{_id: 'plan', workspaceId: 'healthy', studentId: 'child', endAt: new Date('2026-10-19T16:59:59.999Z')}],
    targets: [{_id: 'target', workspaceId: 'healthy', planId: 'plan', studentId: 'child', title: 'Goal', progress: 50, status: 'active'}],
    sessions: [{_id: 'session', workspaceId: 'healthy', studentId: 'child', subjectId: 'subject', startAt: new Date('2026-10-19T02:00:00Z'), status: 'scheduled'}],
  });
  const created = [], delivered = [];
  const events = {
    studentRecipients: async () => ({parentIds: ['parent'], studentIds: ['student']}), teacherIds: async () => ['teacher'],
    create: async rows => {created.push(...rows); return rows.map(row => row.eventKey);},
    deliverAfterCommit: async ids => {delivered.push(...ids);},
  };
  const worker = new NotificationScheduler({get: () => undefined}, db, events, {canUse: async workspaceId => {if (workspaceId === 'unavailable') throw new Error('tenant unavailable'); return true;}});
  worker.logger = {warn() {}};
  await worker.run(new Date('2026-10-18T03:00:00Z'));
  assert.equal(created.length, 6); assert.equal(delivered.length, 6);
  assert.ok(created.every(row => row.workspaceId === 'healthy' && row.deliveryExpiresAt.toISOString() === '2026-10-18T17:00:00.000Z'));
});
test('H-3/H-1 subscription reminders are not Pro-gated and do not create a missing trial', async () => {
  const now = new Date('2026-10-18T03:00:00Z');
  const db = memoryDb({
    users: [{workspaceId: 'basic', role: 'teacher', timezone: 'Asia/Jakarta'}, {workspaceId: 'trial', role: 'teacher', timezone: 'Asia/Jakarta'}, {workspaceId: 'missing', role: 'teacher', timezone: 'Asia/Jakarta'}],
    subscriptions: [
      {_id: 'sub-basic', workspaceId: 'basic', plan: 'basic', trialEndsAt: new Date(0), paidThrough: new Date(now.getTime() + 86400_000)},
      {_id: 'sub-trial', workspaceId: 'trial', plan: 'trial', trialEndsAt: new Date(now.getTime() + 3 * 86400_000)},
    ],
  });
  const eventsByKey = new Map();
  const events = {teacherIds: async workspaceId => [`teacher-${workspaceId}`], create: async rows => {for (const row of rows) eventsByKey.set(row.eventKey, row); return [];}, deliverAfterCommit: async () => {}};
  const worker = new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => false}); worker.logger = {warn() {}};
  await worker.run(now); await worker.run(now);
  assert.equal(eventsByKey.size, 2); assert.equal(db.data.subscriptions.length, 2);
  assert.ok([...eventsByKey.values()].every(row => row.route === '/teacher/subscription' && row.deliveryExpiresAt > now));
});
