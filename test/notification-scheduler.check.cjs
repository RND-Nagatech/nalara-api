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

test('group reminders notify the teacher once while parent/student events remain child-specific',async()=>{
  const startAt=new Date('2026-10-19T02:00:00Z'),endAt=new Date('2026-10-19T03:00:00Z');
  const db=memoryDb({
    users:[{_id:'teacher',workspaceId:'w',role:'teacher',timezone:'Asia/Jakarta'}],
    students:[{_id:'a',workspaceId:'w',name:'Anak A'},{_id:'b',workspaceId:'w',name:'Anak B'}],
    subjects:[{_id:'piano',workspaceId:'w',name:'Piano'}],
    sessions:['a','b'].map(id=>({_id:`session-${id}`,workspaceId:'w',studentId:id,subjectId:'piano',groupId:'group',startAt,endAt,status:'scheduled'})),
  });
  const created=[];
  const events={teacherIds:async()=>['teacher'],studentRecipients:async(_,id)=>({parentIds:[`parent-${id}`],studentIds:[`student-${id}`]}),create:async rows=>{created.push(...rows);return [];},deliverAfterCommit:async()=>{}};
  const worker=new NotificationScheduler({get:()=>undefined},db,events,{canUse:async()=>true});
  await worker.run(new Date('2026-10-18T03:00:00Z'));
  assert.equal(created.length,5);
  const teacherEvents=created.filter(row=>row.recipientAccountId==='teacher');
  assert.equal(teacherEvents.length,1); assert.match(teacherEvents[0].body,/2 siswa/);
  const {NotificationAudienceService}=source('modules/notifications/notification-audience.service.ts',{'../../database/database.module':{Database:class {}}});
  // Ignore the fixed fixture deadline; exercise the real resource/role resolver.
  assert.deepEqual(await new NotificationAudienceService(db).resolve({...teacherEvents[0],deliveryExpiresAt:undefined}),{accountType:'teacher',accountIds:['teacher']});
  for(const id of ['a','b']) {
    const parent=created.find(row=>row.recipientAccountId===`parent-${id}`);
    assert.equal(parent.route,`/parent/sessions/session-${id}`);
    assert.match(parent.body,new RegExp(`Anak ${id.toUpperCase()}`));
    assert.ok(!parent.body.includes(`Anak ${id==='a'?'B':'A'}`));
  }
});

test('session H-1 uses the series timezone across midnight, with stable keys after teacher-zone changes', async () => {
  const db = memoryDb({
    users: [{_id: 'teacher', workspaceId: 'w', role: 'teacher', timezone: 'Asia/Jakarta'}],
    students: [{_id: 'child', workspaceId: 'w', name: 'Anak'}],
    subjects: [{_id: 'subject', workspaceId: 'w', name: 'Musik'}],
    schedules: [
      {_id: 'wit', workspaceId: 'w', timezone: 'Asia/Jayapura'},
      {_id: 'wib', workspaceId: 'w', timezone: 'Asia/Jakarta'},
      {_id: 'wita', workspaceId: 'w', timezone: 'Asia/Makassar'},
      {_id: 'foreign', workspaceId: 'other', timezone: 'Asia/Jakarta'},
    ],
    // At 16:30Z it is already Oct 19 WITA/WIT, but still Oct 18 WIB.
    sessions: [
      {_id: 'wit-tomorrow', workspaceId: 'w', scheduleId: 'wit', studentId: 'child', subjectId: 'subject', startAt: new Date('2026-10-19T15:30:00Z'), status: 'scheduled'},
      {_id: 'wita-tomorrow', workspaceId: 'w', scheduleId: 'wita', studentId: 'child', subjectId: 'subject', startAt: new Date('2026-10-19T16:30:00Z'), status: 'scheduled'},
      {_id: 'wib-today', workspaceId: 'w', scheduleId: 'wib', studentId: 'child', subjectId: 'subject', startAt: new Date('2026-10-18T16:45:00Z'), status: 'scheduled'},
      {_id: 'wib-tomorrow', workspaceId: 'w', scheduleId: 'wib', studentId: 'child', subjectId: 'subject', startAt: new Date('2026-10-19T02:00:00Z'), status: 'scheduled'},
      {_id: 'foreign-session', workspaceId: 'other', scheduleId: 'foreign', startAt: new Date('2026-10-19T15:30:00Z'), status: 'scheduled'},
    ],
  });
  const batches = [];
  const events = {teacherIds: async () => ['teacher'], studentRecipients: async () => ({parentIds: ['parent'], studentIds: ['student']}), create: async rows => {batches.push(rows); return [];}, deliverAfterCommit: async () => {}};
  const worker = new NotificationScheduler({get: () => undefined}, db, events, {canUse: async () => true});
  const now = new Date('2026-10-18T16:30:00Z');
  await worker.remindSessions('w', 'Asia/Jakarta', now);
  await worker.remindSessions('w', 'Asia/Jayapura', now);
  assert.deepEqual(batches[0], batches[1]);
  assert.equal(batches[0].length, 9);
  const wib = batches[0].filter(e => e.route.endsWith('/wib-tomorrow'));
  const wit = batches[0].filter(e => e.route.endsWith('/wit-tomorrow'));
  const wita = batches[0].filter(e => e.route.endsWith('/wita-tomorrow'));
  assert.ok(wib.every(e => e.body.includes('WIB') && e.deliveryExpiresAt.toISOString() === '2026-10-18T17:00:00.000Z'));
  assert.ok(wit.every(e => e.body.includes('WIT') && e.deliveryExpiresAt.toISOString() === '2026-10-19T15:00:00.000Z'));
  assert.ok(wita.every(e => e.body.includes('WITA') && e.deliveryExpiresAt.toISOString() === '2026-10-19T16:00:00.000Z'));
  assert.equal(wib.length, 3); assert.equal(wit.length, 3); assert.equal(wita.length, 3);
});
