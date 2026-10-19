const {test} = require('node:test');
const assert = require('node:assert/strict');
const {source} = require('./helpers/source.cjs');
const {memoryDb, matches} = require('./helpers/memory-db.cjs');
const {StudentPortalService} = source('modules/student-portal/student-portal.service.ts', {
  '../../database/database.module': {Database: class {}}, '../../common/query.dto': {ListQuery: class {}},
  '../learning-plans/progress.rules': {}, '../dashboard/dashboard.rules': {},
});
test('student inbox includes due-target reminders but not siblings or private progress using the same target route', async () => {
  const db = memoryDb({
    students: [{_id: 'child-a', workspaceId: 'a', status: 'active'}],
    targets: [{_id: 'target-a', workspaceId: 'a', studentId: 'child-a'}, {_id: 'sibling-target', workspaceId: 'a', studentId: 'child-b'}],
  });
  const service = new StudentPortalService(db);
  const filter = await service.notificationScope({_id: 'student-a', workspaceId: 'a', role: 'student', studentId: 'child-a'});
  const row = {recipientAccountId: 'student-a', workspaceId: 'a', eventKey: 'target-due:target-a:2026-10-19:student:student-a', route: '/student/targets/target-a'};
  assert.equal(matches(row, filter), true);
  assert.equal(matches({...row, route: '/student/targets/sibling-target'}, filter), false);
  assert.equal(matches({...row, workspaceId: 'other'}, filter), false);
  assert.equal(matches({...row, eventKey: 'progress:private-history:student:student-a'}, filter), false);
});
