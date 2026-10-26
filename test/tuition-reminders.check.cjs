// Source-only fake checks: no Nest bootstrap, live Mongo, FCM or app build.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb, matches} = require('./helpers/memory-db.cjs');
const databaseMock = {'../../database/database.module':{Database:class {}}};
const {NotificationAudienceService} = source('modules/notifications/notification-audience.service.ts', databaseMock);
const {NotificationEventsService} = source('modules/notifications/notification-events.service.ts', {...databaseMock,'./delivery.service':{NotificationDelivery:class {}}});
const {NotificationScheduler} = source('modules/notifications/notification-scheduler.service.ts', {
  ...databaseMock, './notification-events.service':{NotificationEventsService:class {}},
  '../subscriptions/subscriptions.service':{SubscriptionsService:class {}}, '../subscriptions/catalog':source('modules/subscriptions/catalog.ts'),
});
const {teacherNotificationScope} = source('modules/notifications/teacher-notification-scope.ts');
const dto = source('modules/tutor-tools/tutor-tools.dto.ts');
const {TutorToolsService} = source('modules/tutor-tools/tutor-tools.service.ts', {
  '../../common/scoped.service':{ScopedService:class {}}, '../../common/query.dto':{},
  '../learning-plans/progress.rules':{}, './tutor-tools.dto':dto,
  './branding-logo.service':{BrandingLogoService:class {}}, './report-pdf':{},
});
const actor = {_id:'teacher',workspaceId:'w',role:'teacher',timezone:'Asia/Jakarta'};
const fee = {_id:'fee',workspaceId:'w',studentId:'child',amount:250000,dueDate:'2031-01-01',status:'unpaid',version:1};
function setup(preferences, timezone='Asia/Jakarta') {
  const db=memoryDb({users:[{...actor,timezone}],students:[{_id:'child',workspaceId:'w',familyId:'family',status:'active',name:'Alya'}],
    families:[{_id:'family',workspaceId:'w'}],tuitionFees:[{...fee}],tutorPreferences:preferences ? [{workspaceId:'w',...preferences}] : [],
    portalAccounts:[{_id:'parent',workspaceId:'w',familyId:'family',role:'parent',status:'active'}, {_id:'pupil',workspaceId:'w',studentId:'child',role:'student',status:'active'}],notifications:[]});
  const events=new NotificationEventsService(db,{deliver:async()=>{}});
  const worker=new NotificationScheduler({get:()=>undefined},db,events,{canUse:async()=>true});
  const prefs=new TutorToolsService({db},{});
  return {db,worker,prefs,audience:new NotificationAudienceService(db)};
}
const teacherRows = db => db.data.notifications.filter(n=>n.eventKey.startsWith('tuition-check:'));
const parentRows = db => db.data.notifications.filter(n=>n.eventKey.startsWith('tuition-due:'));

test('teacher starts on local due date, repeats once/day while overdue; parent stays H-1/H0 only',async()=>{
  const {db,worker}=setup();
  await worker.run(new Date('2030-12-30T17:01:00Z'));
  assert.equal(teacherRows(db).length,0); assert.equal(parentRows(db).length,1);
  await worker.run(new Date('2030-12-31T17:01:00Z'));
  await worker.run(new Date('2031-01-01T16:59:00Z'));
  assert.equal(teacherRows(db).length,1); assert.equal(parentRows(db).length,2);
  const notification=teacherRows(db)[0];
  assert.equal(notification.route,'/teacher/students/child?tab=tuition');
  assert.match(notification.body,/masih tercatat belum lunas.*perbarui statusnya/);
  assert.equal(notification.deliveryExpiresAt.toISOString(),'2031-01-01T17:00:00.000Z');
  notification.readAt=new Date();
  await worker.run(new Date('2031-01-01T17:01:00Z'));
  await worker.run(new Date('2031-01-02T12:00:00Z'));
  assert.equal(teacherRows(db).length,2); assert.equal(parentRows(db).length,2);
  assert.equal(db.data.tuitionFees[0].status,'unpaid');
  assert.ok(db.data.notifications.every(n=>n.recipientAccountId!=='pupil'));
});

test('fee revision, multiple schedulers and read do not bypass same-day teacher cap',async()=>{
  const {db,worker}=setup(); const now=new Date('2030-12-31T18:00:00Z');
  const second=new NotificationScheduler({get:()=>undefined},db,new NotificationEventsService(db,{deliver:async()=>{}}),{canUse:async()=>true});
  await Promise.all([worker.run(now),second.run(now)]);
  db.data.tuitionFees[0].version=2; db.data.tuitionFees[0].amount=300000;
  teacherRows(db)[0].readAt=new Date();
  await worker.run(now);
  assert.equal(teacherRows(db).length,1); assert.equal(teacherRows(db)[0].tuitionFeeVersion,1);
  await worker.run(new Date('2031-01-01T18:00:00Z'));
  assert.equal(teacherRows(db).length,2); assert.equal(teacherRows(db)[1].tuitionFeeVersion,2);
});

test('resuming after downtime creates only the current local day, never an overdue backlog',async()=>{
  const {db,worker}=setup();
  await worker.run(new Date('2031-01-05T18:00:00Z'));
  assert.equal(teacherRows(db).length,1); assert.match(teacherRows(db)[0].eventKey,/:2031-01-06:teacher:/);
  assert.equal(parentRows(db).length,0);
});

test('turning preference back on does not duplicate the same local day',async()=>{
  const {db,worker}=setup({tuitionTeacherReminders:true,tuitionParentReminders:false});
  const now=new Date('2030-12-31T18:00:00Z');
  await worker.run(now);
  db.data.tutorPreferences[0].tuitionTeacherReminders=false;
  await worker.run(now);
  db.data.tutorPreferences[0].tuitionTeacherReminders=true;
  await worker.run(now);
  assert.equal(teacherRows(db).length,1);
});

test('separate preferences independently stop teacher/parent generation; legacy defaults on',async()=>{
  for(const [teacher,parent] of [[true,true],[true,false],[false,true],[false,false]]) {
    const {db,worker}=setup({tuitionTeacherReminders:teacher,tuitionParentReminders:parent,reminders:false});
    await worker.run(new Date('2030-12-31T18:00:00Z'));
    assert.equal(teacherRows(db).length,Number(teacher)); assert.equal(parentRows(db).length,Number(parent));
  }
  const {db,worker}=setup({reminders:false});
  await worker.run(new Date('2030-12-31T18:00:00Z'));
  assert.equal(teacherRows(db).length,1); assert.equal(parentRows(db).length,1);
});

test('marking paid stops both audiences; archive and feature gate stop reminders',async()=>{
  for(const stop of ['paid','archived','no-entitlement']) {
    const {db,worker}=setup();
    if(stop==='paid') db.data.tuitionFees[0].status='paid';
    if(stop==='archived') db.data.students[0].status='archived';
    if(stop==='no-entitlement') worker.subscriptions={canUse:async()=>false};
    await worker.run(new Date('2030-12-31T18:00:00Z'));
    assert.equal(db.data.notifications.length,0);
  }
});

test('daily teacher window follows timezone/DST and is not a rolling 24h timer',async()=>{
  const {db,worker}=setup(undefined,'America/New_York');
  db.data.tuitionFees[0].dueDate='2030-03-10';
  await worker.run(new Date('2030-03-10T04:59:00Z')); assert.equal(teacherRows(db).length,0);
  await worker.run(new Date('2030-03-10T05:01:00Z'));
  assert.equal(teacherRows(db)[0].deliveryExpiresAt.toISOString(),'2030-03-11T04:00:00.000Z');
  await worker.run(new Date('2030-03-11T04:01:00Z')); assert.equal(teacherRows(db).length,2);
});

function queued() {
  return {workspaceId:'w',recipientAccountId:'teacher',route:'/teacher/students/child?tab=tuition',
    eventKey:'tuition-check:fee:2031-01-01:teacher:teacher',tuitionFeeVersion:1,deliveryExpiresAt:new Date('2031-01-02T00:00:00Z')};
}
test('queued teacher delivery rechecks paid/version/active pupil/current teacher/exact route/expiry',async()=>{
  const changes=[
    c=>c.db.data.tuitionFees[0].status='paid',c=>c.db.data.tuitionFees[0].version++,
    c=>c.db.data.students[0].status='archived',c=>c.db.data.users[0].deletionRequestedAt=new Date(),
    c=>c.notification.route='/teacher/students/other?tab=tuition',c=>c.notification.recipientAccountId='parent',
    c=>c.notification.route='/parent/students/child?tab=tuition',c=>c.notification.tuitionFeeVersion=undefined,
    c=>c.notification.deliveryExpiresAt=new Date(0),c=>c.db.data.tuitionFees[0].dueDate='2031-01-03',
    c=>c.db.data.tuitionFees[0].workspaceId='other',c=>c.notification.eventKey='tuition-check:fee:2031-01-01:student:teacher',
  ];
  const valid=setup(); assert.deepEqual(await valid.audience.resolve(queued()),{accountType:'teacher',accountIds:['teacher']});
  for(const change of changes) {
    const c={...setup(),notification:queued()}; change(c);
    assert.equal(await c.audience.resolve(c.notification),null);
  }
});

test('switching preference off suppresses already queued events independently, including parent',async()=>{
  const {db,audience}=setup();
  const parent={workspaceId:'w',recipientAccountId:'parent',route:'/parent/students/child?tab=tuition',eventKey:'tuition-due:fee:1:2031-01-01:today:parent:parent'};
  db.data.tutorPreferences.push({workspaceId:'w',tuitionTeacherReminders:false,tuitionParentReminders:true});
  assert.equal(await audience.resolve(queued()),null); assert.equal((await audience.resolve(parent)).accountType,'parent');
  db.data.tutorPreferences[0].tuitionTeacherReminders=true; db.data.tutorPreferences[0].tuitionParentReminders=false;
  assert.equal((await audience.resolve(queued())).accountType,'teacher'); assert.equal(await audience.resolve(parent),null);
});

test('inbox and Home scope hide settled/revised/archived fee reminders without hiding ordinary messages',async()=>{
  const {db}=setup();
  const ordinary={eventKey:'target-created:target',recipientAccountId:'teacher'};
  const notification=queued();
  let filter=await teacherNotificationScope(db,actor);
  assert.ok(matches(notification,filter)); assert.ok(matches(ordinary,filter));
  assert.ok(!matches({...notification,recipientAccountId:'other'},filter));
  for(const field of ['paid','revision','archive']) {
    db.data.tuitionFees[0]={...fee}; db.data.students[0].status='active';
    if(field==='paid') db.data.tuitionFees[0].status='paid';
    if(field==='revision') db.data.tuitionFees[0].version=2;
    if(field==='archive') db.data.students[0].status='archived';
    filter=await teacherNotificationScope(db,actor);
    assert.ok(!matches(notification,filter)); assert.ok(matches(ordinary,filter));
  }
});

test('preference DTO accepts optional booleans for older apps, rejects null/string/ownership',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  const old={reminders:true,progress:false,reports:true,assignments:false};
  const validate=value=>pipe.transform(value,{type:'body',metatype:dto.PreferencesDto});
  await validate(old); await validate({...old,tuitionTeacherReminders:false,tuitionParentReminders:true});
  for(const field of ['tuitionTeacherReminders','tuitionParentReminders']) {
    for(const value of [null,'false',0,{}]) await assert.rejects(validate({...old,[field]:value}));
  }
  await assert.rejects(validate({...old,workspaceId:'other'}));
});

test('defaults and saved flags roundtrip; older/branding payloads preserve flags and workspace isolation',async()=>{
  const {db,prefs}=setup();
  assert.equal((await prefs.preferences(actor)).tuitionTeacherReminders,true);
  db.data.tutorPreferences.push({workspaceId:'w',logoKey:'keep',reminders:true});
  assert.equal((await prefs.preferences(actor)).tuitionParentReminders,true);
  await prefs.savePreferences(actor,{reminders:true,progress:true,reports:true,assignments:true,tuitionTeacherReminders:false,tuitionParentReminders:false});
  await prefs.savePreferences(actor,{reminders:false,progress:false,reports:false,assignments:false,tuitionTeacherReminders:undefined});
  await prefs.savePreferences(actor,{displayName:'Tutor',tagline:'',footer:'',accentColor:'#155D49'});
  const saved=await prefs.preferences(actor);
  assert.equal(saved.tuitionTeacherReminders,false); assert.equal(saved.tuitionParentReminders,false); assert.equal(saved.logoVersion,'keep');
  assert.equal((await prefs.preferences({...actor,workspaceId:'other'})).tuitionTeacherReminders,true);
});
