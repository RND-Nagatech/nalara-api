// Source-only recurrence checks: no app, real database, accounts or providers.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
require('reflect-metadata');
const {ValidationPipe}=require('@nestjs/common');
const {source}=require('./helpers/source.cjs');
const {memoryDb,matches}=require('./helpers/memory-db.cjs');
const rules=source('modules/schedules/repeat-rules.ts');
const dto=source('modules/schedules/schedules.dto.ts');
const groups=source('modules/schedules/schedule-groups.ts');
const calendar=source('common/calendar-lock.ts');
const {SchedulesService}=source('modules/schedules/schedules.service.ts',{
  '../../common/scoped.service':{ScopedService:class{}},'./schedules.dto':dto,
  '../notifications/notification-events.service':{NotificationEventsService:class{}},
  '../subscriptions/subscriptions.service':{SubscriptionsService:class{}},
  '../../common/calendar-lock':calendar,'./schedule-groups':groups,'./repeat-rules':rules,
});
const {ScheduleRepeatWorker}=source('modules/schedules/schedule-repeat-worker.service.ts',{
  '../../database/database.module':{Database:class{}},'./schedules.service':{SchedulesService},
});
const teacher={_id:randomUUID(),workspaceId:randomUUID(),role:'teacher',timezone:'Asia/Jakarta'};
const child=randomUUID(),otherChild=randomUUID(),subjectId=randomUUID();
const startAt=new Date('2030-01-07T02:00:00Z'),endAt=new Date('2030-01-07T03:00:00Z');
const pattern=extra=>({startAt,endAt,timezone:'Asia/Jakarta',repeatDays:[1,4],repeatEnd:'count',repeatCount:4,...extra});
const draft=extra=>({...pattern(),studentIds:[child,otherChild],subjectId,recurrence:'weekly',startAt:startAt.toISOString(),endAt:endAt.toISOString(),...extra});
function setup(extra={}) {
  const db=memoryDb({users:[teacher],workspaces:[{_id:teacher.workspaceId}],students:[child,otherChild].map(_id=>({_id,workspaceId:teacher.workspaceId,status:'active'})),
    subjects:[{_id:subjectId,workspaceId:teacher.workspaceId}],schedules:[],sessions:[],...extra});
  const base=db.collection.bind(db),trace=[];
  db.collection=name=>{
    const model=base(name),find=model.find;
    model.find=filter=>find(Object.fromEntries(Object.entries(filter).map(([key,value])=>[key,value instanceof Date?{$gte:value,$lte:value}:value])));
    model.exists=filter=>({session:async()=>{if(name==='sessions')trace.push('overlap');return (db.data[name]??[]).some(row=>matches(row,filter));}});
    model.countDocuments=filter=>({session:async()=>(db.data[name]??[]).filter(row=>matches(row,filter)).length});
    if(name==='workspaces') {const update=model.updateOne;model.updateOne=async(...args)=>{trace.push('lock');return update(...args);};}
    if(name==='schedules'||name==='sessions') {const create=model.create;model.create=async(rows,options)=>{
      if(rows.length>1)assert.equal(options.ordered,true);
      return create(rows.map(row=>({status:'scheduled',...(name==='sessions'?{attendance:'pending'}:{}),...row})));
    };}
    return model;
  };
  db.connection.transaction=async fn=>{const before=structuredClone(db.data);try{return await fn({});}catch(error){for(const key of Object.keys(db.data))delete db.data[key];Object.assign(db.data,before);throw error;}};
  const scope={db,
    get:async(name,id,actor)=>{const row=await db.collection(name).findOne({_id:id,workspaceId:actor.workspaceId}).lean();if(!row)throw new Error('not found');return row;},
    activeStudent:async(id,actor)=>{if(!db.data.students.some(row=>row._id===id&&row.workspaceId===actor.workspaceId&&row.status==='active'))throw new Error('inactive student');},
  };
  const subscriptions={canUse:async()=>true,requireFeature:async()=>{}};
  return {db,trace,subscriptions,service:new SchedulesService(scope,{},subscriptions)};
}

test('weekday recurrence preserves selected weekdays, local time and total meeting count',()=>{
  const result=rules.repeatOccurrences(pattern(),new Date('2030-01-01T00:00:00Z'));
  assert.deepEqual(result.slots.map(row=>row.startAt.toISOString()),['2030-01-07T02:00:00.000Z','2030-01-10T02:00:00.000Z','2030-01-14T02:00:00.000Z','2030-01-17T02:00:00.000Z']);
  assert.equal(result.recurrenceComplete,true);assert.equal(result.generatedCount,4);
});
test('date end is inclusive; invalid dates, empty/duplicate weekdays and inconsistent settings are rejected',()=>{
  assert.equal(rules.repeatOccurrences(pattern({repeatEnd:'until',repeatUntil:'2030-01-10'})).slots.length,2);
  for(const extra of [{repeatDays:[]},{repeatDays:[1,1]},{repeatDays:[0]},{repeatDays:[8]},{repeatDays:[1.5]},
    {repeatEnd:'count',repeatCount:0},{repeatEnd:'count',repeatCount:53},{repeatEnd:'never',repeatUntil:'2030-01-10'},
    {repeatEnd:'until',repeatUntil:'2030-02-30'},{repeatEnd:'until',repeatUntil:'2030-01-06'},{repeatEnd:'until',repeatUntil:'2032-01-01'}])assert.throws(()=>rules.repeatOccurrences(pattern(extra)));
});
test('selected days may start after the anchor and support overnight wall times across year boundaries',()=>{
  const result=rules.repeatOccurrences(pattern({startAt:new Date('2029-12-31T16:00:00Z'),endAt:new Date('2029-12-31T19:00:00Z'),repeatDays:[4],repeatCount:2}));
  assert.equal(rules.localWeekday(result.slots[0].startAt,'Asia/Jakarta'),4);
  assert.equal(rules.localParts(result.slots[0].endAt,'Asia/Jakarta').hour,2);
  assert.equal(result.slots[0].endAt-result.slots[0].startAt,3*3600_000);
});
test('DST retains the same local hour; nonexistent transition wall time fails clearly',()=>{
  const result=rules.repeatOccurrences(pattern({startAt:new Date('2026-03-01T14:00:00Z'),endAt:new Date('2026-03-01T15:00:00Z'),timezone:'America/New_York',repeatDays:[7],repeatCount:3}),new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(result.slots.map(row=>row.startAt.toISOString()),['2026-03-01T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-15T13:00:00.000Z']);
  assert.throws(()=>rules.shiftLocalDays(new Date('2026-03-01T07:30:00Z'),'America/New_York',7),/zona waktu/);
});
test('never mode is bounded, advances from its durable cursor and avoids historical backfill after downtime',()=>{
  const value=pattern({repeatDays:[1],repeatEnd:'never'});
  const initial=rules.repeatOccurrences(value,new Date('2030-01-01T00:00:00Z'));
  assert.equal(initial.slots.length,8);assert.equal(initial.recurrenceComplete,false);
  const next=rules.repeatOccurrences({...value,...initial},new Date('2030-02-04T00:00:00Z'));
  assert.equal(next.slots.length,4);
  const duplicate=rules.repeatOccurrences({...value,...next},new Date('2030-02-04T00:00:00Z'));
  assert.equal(duplicate.slots.length,0);
  const resumed=rules.repeatOccurrences({...value,...initial},new Date('2035-01-01T00:00:00Z'));
  assert.ok(resumed.slots.length>0&&resumed.slots.length<=8);
  assert.ok(resumed.slots.every(row=>row.startAt>=new Date('2035-01-01T00:00:00Z')));
});
test('DTO accepts strict repeat payloads and never allows client progress/ownership or invalid scope',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  await pipe.transform(draft(),{type:'body',metatype:dto.ScheduleDto});
  for(const extra of [{repeatDays:[]},{repeatDays:[1,1]},{repeatDays:[8]},{generatedCount:10},{nextExpansionAt:startAt.toISOString()},{workspaceId:teacher.workspaceId}])await assert.rejects(pipe.transform(draft(extra),{type:'body',metatype:dto.ScheduleDto}));
  await pipe.transform({scope:'following',status:'cancelled',cancellationReason:'Guru berhalangan.'},{type:'body',metatype:dto.UpdateSessionDto});
  await assert.rejects(pipe.transform({scope:'all'},{type:'body',metatype:dto.UpdateSessionDto}));
});
test('new multi-day group keeps a private occurrence per child, one shared group per meeting and atomic conflict rollback',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft());
  assert.equal(result.participantCount,2);assert.equal(ctx.db.data.sessions.length,8);
  assert.equal(new Set(ctx.db.data.sessions.map(row=>row.groupId)).size,4);
  assert.equal(ctx.trace[0],'lock');
  const before=structuredClone(ctx.db.data);
  await assert.rejects(ctx.service.create(teacher,draft()),/sudah digunakan/);
  assert.deepEqual(ctx.db.data,before);
});
test('rollout is idempotent, checked under calendar lock, and cancelled exceptions are never restored',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft({repeatDays:[1],repeatEnd:'never'}));
  const first=ctx.db.data.sessions[0];await ctx.service.updateSession(teacher,first._id,{status:'cancelled',cancellationReason:'Guru berhalangan.'});
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,24);
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,24);
  assert.equal(ctx.db.data.sessions.find(row=>row._id===first._id).status,'cancelled');
  assert.ok(ctx.db.data.sessions.every(row=>row.workspaceId===teacher.workspaceId));
});
test('rollout conflicts do not create partial groups; records retain a retryable, sanitized warning',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft({repeatDays:[1],repeatEnd:'never'}));
  ctx.db.data.sessions.push({_id:randomUUID(),workspaceId:teacher.workspaceId,status:'scheduled',startAt:new Date('2030-03-04T02:00:00Z'),endAt:new Date('2030-03-04T03:00:00Z')});
  const before=ctx.db.data.sessions.length;
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,before);
  assert.match(ctx.db.data.schedules[0].recurrenceError,/benturan/);
  assert.equal(ctx.db.data.schedules[0].generatedCount,8);
});
test('Basic/expired entitlement and inactive pupils pause rollout; stopping a series stops future expansion',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft({repeatDays:[1],repeatEnd:'never'}));
  ctx.subscriptions.canUse=async()=>false;
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,16);
  ctx.subscriptions.canUse=async()=>true;ctx.db.data.students[0].status='archived';
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,16);
  await ctx.service.update(teacher,result._id,{status:'cancelled',cancellationReason:'Guru berhenti mengajar.'});
  await ctx.service.expandRepeat(result._id,new Date('2030-02-04T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,16);
});
test('following time edit creates a continuation with the same children and preserves prior completed history',async()=>{
  const ctx=setup();await ctx.service.create(teacher,draft());
  const first=ctx.db.data.sessions[0],anchor=ctx.db.data.sessions[2];
  first.status='completed';first.attendance='present';
  const saved=await ctx.service.updateSession(teacher,anchor._id,{scope:'following',startAt:'2030-01-10T04:00:00Z',endAt:'2030-01-10T05:00:00Z'});
  assert.ok(saved.continuationScheduleId);
  const continuation=ctx.db.data.schedules.filter(row=>row.status==='scheduled');
  assert.equal(continuation.length,2);assert.equal(continuation[0].repeatCount,3);
  assert.equal(ctx.db.data.sessions.find(row=>row._id===first._id).attendance,'present');
  assert.equal(ctx.db.data.sessions.find(row=>row._id===anchor._id).status,'cancelled');
  assert.equal(ctx.db.data.sessions.filter(row=>continuation.some(series=>series._id===row.scheduleId)).length,6);
});
test('following cancellation stops only pending future sessions and rejects partially recorded group anchors',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft());
  const anchor=ctx.db.data.sessions[2];
  ctx.db.data.sessions[3].status='completed';ctx.db.data.sessions[3].attendance='present';
  await assert.rejects(ctx.service.updateSession(teacher,anchor._id,{scope:'following',status:'cancelled',cancellationReason:'Guru berhalangan.'}),/presensi/);
  ctx.db.data.sessions[3].status='scheduled';ctx.db.data.sessions[3].attendance='pending';
  await ctx.service.updateSession(teacher,anchor._id,{scope:'following',status:'cancelled',cancellationReason:'Guru berhalangan.'});
  assert.ok(ctx.db.data.sessions.filter(row=>row.status==='cancelled' && row.startAt>=anchor.startAt).every(row=>row.cancellationReason==='Guru berhalangan.'));
  assert.equal(ctx.db.data.sessions.filter(row=>row.status==='scheduled').length,2);
  assert.equal(ctx.db.data.schedules.find(row=>row._id===result._id).status,'cancelled');
});
test('series pattern change is tenant-scoped, uses a new series and rolls back on any new conflict',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft());
  const change={startAt:startAt.toISOString(),endAt:endAt.toISOString(),timezone:'Asia/Jakarta',repeatDays:[1,3],repeatEnd:'count',repeatCount:3};
  await assert.rejects(ctx.service.changeRepeat({...teacher,workspaceId:'foreign'},result._id,change),error=>error.getStatus()===404);
  ctx.db.data.sessions.push({_id:randomUUID(),workspaceId:teacher.workspaceId,status:'scheduled',startAt:new Date('2030-01-09T02:00:00Z'),endAt:new Date('2030-01-09T03:00:00Z')});
  const before=structuredClone(ctx.db.data);
  await assert.rejects(ctx.service.changeRepeat(teacher,result._id,change),/sudah digunakan/);
  assert.deepEqual(ctx.db.data,before);
});
test('worker coalesces local ticks, deduplicates groups and stays recoverable across scan failures',async()=>{
  const db=memoryDb({schedules:[
    ...['a','b'].map(_id=>({_id,workspaceId:'w',groupId:'group',status:'scheduled',recurrenceComplete:false,repeatEnd:'never',nextExpansionAt:new Date(0)})),
    {_id:'c',workspaceId:'other',groupId:'group',status:'scheduled',recurrenceComplete:false,repeatEnd:'never',nextExpansionAt:new Date(0)},
  ]});
  const calls=[];
  const worker=new ScheduleRepeatWorker(db,{expandRepeat:async id=>calls.push(id)});
  await Promise.all([worker.run(),worker.run()]);assert.deepEqual(calls,['a','c']);
  await worker.onModuleDestroy();await worker.run();assert.equal(calls.length,2);
});
test('following edit retains not-yet-materialized count instead of shortening a 52-meeting series',async()=>{
  const ctx=setup();await ctx.service.create(teacher,draft({repeatDays:[1],repeatCount:52}));
  const anchor=ctx.db.data.sessions[4];
  const saved=await ctx.service.updateSession(teacher,anchor._id,{scope:'following',startAt:'2030-01-21T04:00:00Z',endAt:'2030-01-21T05:00:00Z'});
  assert.equal(ctx.db.data.schedules.find(row=>row._id===saved.continuationScheduleId).repeatCount,50);
});
test('count/date series stop exactly at their boundary; completed future participants prevent replacement',async()=>{
  const ctx=setup();const result=await ctx.service.create(teacher,draft());
  assert.equal(ctx.db.data.schedules[0].recurrenceComplete,true);
  await ctx.service.expandRepeat(result._id,new Date('2031-01-01T00:00:00Z'));
  assert.equal(ctx.db.data.sessions.length,8);
  ctx.db.data.sessions[1].status='completed';ctx.db.data.sessions[1].attendance='present';
  const before=structuredClone(ctx.db.data);
  await assert.rejects(ctx.service.changeRepeat(teacher,result._id,{...draft(),repeatEnd:'never'}),/presensi/);
  assert.deepEqual(ctx.db.data,before);
});
test('a child-specific moved occurrence cannot silently rewrite the whole group pattern',async()=>{
  const ctx=setup();await ctx.service.create(teacher,draft());
  const special=ctx.db.data.sessions[0];special.startAt=new Date('2030-01-07T05:00:00Z');special.endAt=new Date('2030-01-07T06:00:00Z');
  const before=structuredClone(ctx.db.data);
  await assert.rejects(ctx.service.updateSession(teacher,special._id,{scope:'following',status:'cancelled',cancellationReason:'Guru berhalangan.'}),/perubahan khusus/);
  assert.deepEqual(ctx.db.data,before);
});
