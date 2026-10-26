// Source-only contracts with a transactional fake; no Nest bootstrap/live DB/FCM.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const dto = source('modules/lesson-reports/reports.dto.ts');
const {ScopedService} = source('common/scoped.service.ts', {'../database/database.module':{Database:class {}}});
const {NotificationEventsService} = source('modules/notifications/notification-events.service.ts', {
  '../../database/database.module':{Database:class {}},'./delivery.service':{NotificationDelivery:class {}},
});
const {NotificationAudienceService} = source('modules/notifications/notification-audience.service.ts', {'../../database/database.module':{Database:class {}}});
const {ReportsService} = source('modules/lesson-reports/reports.service.ts', {
  '../../common/scoped.service':{ScopedService}, '../../common/query.dto':{}, './reports.dto':dto,
  '../notifications/notification-events.service':{NotificationEventsService},
  '../schedules/schedule-groups':source('modules/schedules/schedule-groups.ts'),
  '../../common/calendar-lock':source('common/calendar-lock.ts'),
});
const actor={_id:randomUUID(),workspaceId:randomUUID(),role:'teacher'};
const first=randomUUID(),second=randomUUID(),third=randomUUID(),subject=randomUUID();
const childA=randomUUID(),childB=randomUUID(),childC=randomUUID(),targetA=randomUUID(),targetB=randomUUID();
const draft=(extra={})=>({topic:'Operasi pecahan',summary:'Latihan penjumlahan dan pengurangan.',visibility:'shared',status:'published',
  entries:[{sessionId:first,targetIds:[targetA]},{sessionId:second,targetIds:[targetB]}],...extra});
function setup() {
  const db=memoryDb({
    workspaces:[{_id:actor.workspaceId}],
    sessions:[first,second,third].map((id,index)=>({_id:id,workspaceId:actor.workspaceId,
      studentId:[childA,childB,childC][index],subjectId:subject,groupId:'group',status:'scheduled',
      startAt:'2030-01-01T10:00:00Z',endAt:'2030-01-01T11:00:00Z'})),
    students:[childA,childB,childC].map(id=>({_id:id,workspaceId:actor.workspaceId,familyId:'family',status:'active'})),
    families:[{_id:'family',workspaceId:actor.workspaceId}],
    portalAccounts:[childA,childB,childC].map(id=>({_id:`account-${id}`,workspaceId:actor.workspaceId,studentId:id,role:'student',status:'active'})).concat([
      {_id:'parent',workspaceId:actor.workspaceId,familyId:'family',role:'parent',status:'active'},
    ]),
    targets:[{_id:targetA,workspaceId:actor.workspaceId,studentId:childA,subjectId:subject},
      {_id:targetB,workspaceId:actor.workspaceId,studentId:childB,subjectId:subject}],
    reports:[],notifications:[],audits:[],
  });
  const collection=db.collection.bind(db);
  // Add the Mongoose query session method without altering the shared fake.
  db.collection=name=>{const model=collection(name);if(name==='reports') {
    const exists=model.exists;model.exists=filter=>({session:async()=>exists(filter)});
  } return model;};
  const trace=[];
  let committed=false;
  db.connection.transaction=async operation=>{
    const before=structuredClone(db.data);committed=false;
    try {const result=await operation({transaction:true});committed=true;trace.push('commit');return result;}
    catch(error) {for(const name of Object.keys(db.data)) delete db.data[name];Object.assign(db.data,before);trace.push('rollback');throw error;}
  };
  const events=new NotificationEventsService(db,{deliver:async id=>{assert.equal(committed,true);trace.push(`deliver:${id}`);}});
  return {db,events,trace,service:new ReportsService(new ScopedService(db),events),audience:new NotificationAudienceService(db)};
}

test('DTO validates 1–100 unique child sessions, per-child targets and common report fields',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  const validate=value=>pipe.transform(value,{type:'body',metatype:dto.BatchReportDto});
  assert.equal((await validate(draft())).entries.length,2);
  await validate(draft({entries:Array.from({length:100},()=>({sessionId:randomUUID()}))}));
  for(const patch of [{entries:[]},{entries:null},{entries:[null]}, {entries:[{sessionId:'bad'}]},
    {entries:[{sessionId:first},{sessionId:first}]}, {entries:Array.from({length:101},()=>({sessionId:randomUUID()}))},
    {entries:[{sessionId:first,studentId:childA}]},{entries:[{sessionId:first,targetIds:[targetA,targetA]}]},
    {entries:[{sessionId:first,targetIds:['bad']}]},{targetIds:[targetA]}, {workspaceId:'foreign'},
    {studentIds:[childA]}, {status:'unknown'},{visibility:'parent'},{topic:'a'},{summary:''}]) {
    await assert.rejects(validate(draft(patch)));
  }
});

test('batch creates independent reports/audits/outbox atomically, then delivers after commit',async()=>{
  const {db,service,trace}=setup();
  const result=await service.createBatch(actor,first,draft());
  assert.equal(result.total,2);assert.equal(new Set(result.items.map(row=>row._id)).size,2);
  assert.deepEqual(result.items.map(row=>row.studentId),[childA,childB]);
  assert.deepEqual(result.items.map(row=>row.targetIds),[[targetA],[targetB]]);
  assert.ok(result.items.every(row=>row.status==='published' && row.publishedAt instanceof Date));
  assert.ok(result.items.every(row=>row.entries===undefined && row.studentIds===undefined));
  assert.equal(db.data.audits.length,4);assert.equal(db.data.notifications.length,4);
  assert.equal(db.data.workspaces[0].scheduleVersion,1);assert.equal(trace[0],'commit');assert.equal(trace.length,5);
  for(const report of result.items) {
    const events=db.data.notifications.filter(event=>event.route.endsWith(report._id));
    assert.deepEqual(events.map(event=>event.recipientAccountId).sort(),['parent',`account-${report.studentId}`].sort());
  }
});

test('drafts/internal reports never notify; student visibility never reaches parents',async()=>{
  for(const patch of [{status:'draft'},{visibility:'teacher'}]) {
    const {db,service,trace}=setup();await service.createBatch(actor,first,draft(patch));
    assert.equal(db.data.reports.length,2);assert.equal(db.data.notifications.length,0);assert.deepEqual(trace,['commit']);
  }
  const {db,service}=setup();await service.createBatch(actor,first,draft({visibility:'student'}));
  assert.deepEqual(db.data.notifications.map(event=>event.recipientAccountId).sort(),[`account-${childA}`,`account-${childB}`].sort());
});

test('a single selected recipient and unselected group members stay isolated',async()=>{
  const {db,service}=setup();const result=await service.createBatch(actor,second,draft({entries:[{sessionId:second}]}));
  assert.equal(result.total,1);assert.equal(result.items[0].studentId,childB);assert.deepEqual(result.items[0].targetIds,[]);
  assert.equal(db.data.reports.some(row=>row.studentId===childA || row.studentId===childC),false);
});

test('cross-workspace, different/moved occurrence, subject mismatch and cancelled child reject all writes',async()=>{
  for(const mutate of [
    db=>{db.data.sessions[1].workspaceId='foreign';}, db=>{db.data.sessions[1].groupId='different';},
    db=>{db.data.sessions[1].startAt='2030-01-02T10:00:00Z';}, db=>{db.data.sessions[1].subjectId='different';},
    db=>{db.data.sessions[1].status='cancelled';}, db=>{db.data.workspaces[0]._id='foreign';},
  ]) {
    const {db,service,trace}=setup();mutate(db);await assert.rejects(service.createBatch(actor,first,draft()));
    assert.equal(db.data.reports.length,0);assert.equal(db.data.notifications.length,0);assert.equal(db.data.audits.length,0);
    assert.deepEqual(trace,['rollback']);
  }
});

test('private evaluated targets must match each recipient and subject in the same workspace',async()=>{
  for(const mutate of [
    db=>{db.data.targets[1].studentId=childA;},db=>{db.data.targets[1].subjectId='other';},
    db=>{db.data.targets[1].workspaceId='foreign';},db=>{db.data.targets.pop();},
  ]) {
    const {db,service}=setup();mutate(db);await assert.rejects(service.createBatch(actor,first,draft()));
    assert.equal(db.data.reports.length,0);assert.equal(db.data.notifications.length,0);
  }
});

test('existing reports and repeated requests never overwrite or duplicate child reports',async()=>{
  const {db,service}=setup();await service.createBatch(actor,first,draft({status:'draft'}));
  const original=structuredClone(db.data.reports);
  await assert.rejects(service.createBatch(actor,first,draft()),error=>error.getStatus()===409);
  assert.deepEqual(db.data.reports,original);assert.equal(db.data.notifications.length,0);
  const another=setup();another.db.data.reports.push({_id:randomUUID(),workspaceId:actor.workspaceId,sessionId:second,status:'draft'});
  await assert.rejects(another.service.createBatch(actor,first,draft()),error=>error.getStatus()===409);
  assert.equal(another.db.data.reports.length,1);assert.equal(another.db.data.audits.length,0);
});

test('failure on another recipient or its notification rolls back every report/audit/outbox',async()=>{
  for(const failure of ['report','outbox']) {
    const {db,service,events,trace}=setup();
    if(failure==='report') {
      const collection=db.collection.bind(db);let writes=0;
      db.collection=name=>{const model=collection(name);if(name==='reports') {const create=model.create;model.create=async(...args)=>{if(++writes===2)throw new Error('write unavailable');return create(...args);};}return model;};
    } else {const create=events.create.bind(events);let writes=0;events.create=async(...args)=>{if(++writes===2)throw new Error('outbox unavailable');return create(...args);};}
    await assert.rejects(service.createBatch(actor,first,draft()),/unavailable/);
    assert.equal(db.data.reports.length,0);assert.equal(db.data.notifications.length,0);assert.equal(db.data.audits.length,0);
    assert.deepEqual(trace,['rollback']);
  }
});

test('portal delivery resolves only the selected child, never a sibling even within one family',async()=>{
  const {db,service,audience}=setup();await service.createBatch(actor,first,draft());
  const event=db.data.notifications.find(row=>row.recipientAccountId===`account-${childA}`);
  assert.ok(await audience.resolve(event));
  assert.equal(await audience.resolve({...event,recipientAccountId:`account-${childB}`}),null);
  assert.equal(await audience.resolve({...event,recipientAccountId:`account-${childC}`}),null);
  db.data.reports[0].visibility='teacher';assert.equal(await audience.resolve(event),null);
});

test('legacy publish stays idempotent and preserves the same per-child audience',async()=>{
  const {db,service}=setup();const result=await service.createBatch(actor,first,draft({status:'draft'}));
  const report=result.items[0];await service.publish(actor,report.sessionId,report._id);
  await service.publish(actor,report.sessionId,report._id);
  assert.equal(db.data.reports[0].status,'published');assert.equal(db.data.notifications.length,2);
  assert.equal(db.data.reports[1].status,'draft');
});
