// Source-only transactional contracts, no app/bootstrap/live DB/provider.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
require('reflect-metadata');
const {ValidationPipe, SetMetadata} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const dto = source('modules/tutor-tools/tutor-tools.dto.ts');
const {ScopedService} = source('common/scoped.service.ts', {'../database/database.module':{Database:class {}}});
const {NotificationEventsService} = source('modules/notifications/notification-events.service.ts', {
  '../../database/database.module':{Database:class {}}, './delivery.service':{NotificationDelivery:class {}},
});
const {AssignmentsService} = source('modules/tutor-tools/assignments.service.ts', {
  '../../common/scoped.service':{ScopedService}, '../../common/query.dto':{},
  '../notifications/notification-events.service':{NotificationEventsService},
  '../subscriptions/subscriptions.service':{SubscriptionsService:class {}}, './tutor-tools.dto':dto,
});
const actor={_id:randomUUID(),workspaceId:'workspace',role:'teacher'};
const a=randomUUID(), b=randomUUID(), c=randomUUID(), subjectId=randomUUID();
const draft = (extra={}) => ({studentIds:[a,b],subjectId,kind:'task',title:'Latihan pecahan',content:'Kerjakan soal satu sampai lima.',status:'published',visibility:'shared',dueAt:'2031-01-31T10:00:00Z',...extra});
function setup() {
  const db=memoryDb({students:[a,b,c].map((id,index)=>({_id:id,workspaceId:actor.workspaceId,status:'active',name:`Siswa ${index}`,familyId:index<2?'family':'other-family'})),
    subjects:[{_id:subjectId,workspaceId:actor.workspaceId,name:'Matematika'}],families:[{_id:'family',workspaceId:actor.workspaceId}],
    portalAccounts:[{_id:'student-a',workspaceId:actor.workspaceId,role:'student',studentId:a,status:'active'},
      {_id:'student-b',workspaceId:actor.workspaceId,role:'student',studentId:b,status:'active'},
      {_id:'parent',workspaceId:actor.workspaceId,role:'parent',familyId:'family',status:'active'}],
    assignments:[],submissions:[],notifications:[],audits:[]});
  const trace=[], gates=[];
  let committed=false;
  db.connection.transaction=async operation=>{
    const before=structuredClone(db.data); committed=false;
    try {const value=await operation({testSession:true}); committed=true;trace.push('commit');return value;}
    catch(error){for(const name of Object.keys(db.data)) delete db.data[name];Object.assign(db.data,before);trace.push('rollback');throw error;}
  };
  const events=new NotificationEventsService(db,{deliver:async id=>{assert.equal(committed,true);trace.push(`deliver:${id}`);}});
  const subscriptions={requireFeature:async(workspace,feature)=>{assert.equal(workspace,actor.workspaceId);assert.equal(feature,'assignments');gates.push(feature);}};
  const service=new AssignmentsService(new ScopedService(db),subscriptions,events);
  return {db,service,events,subscriptions,trace,gates};
}

test('batch DTO accepts 1–100 unique UUIDs and rejects empty/duplicate/ownership/group payloads',async()=>{
  const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
  const validate=value=>pipe.transform(value,{type:'body',metatype:dto.AssignmentBatchDto});
  assert.deepEqual((await validate(draft())).studentIds,[a,b]);
  await validate(draft({studentIds:Array.from({length:100},()=>randomUUID())}));
  for(const patch of [{studentIds:[]},{studentIds:null},{studentIds:[a,a]},{studentIds:['bad']},{studentIds:a},
    {studentIds:Array.from({length:101},()=>randomUUID())},{studentId:a},{groupId:'group'}, {workspaceId:'foreign'},
    {kind:'unknown'},{title:'a'},{content:''},{dueAt:'bad'},{status:'unknown'},{visibility:'teacher'}]) {
    await assert.rejects(validate(draft(patch)));
  }
});

test('batch creates private child assignments with common content and notifications only after commit',async()=>{
  const {db,service,trace,gates}=setup();
  const result=await service.saveBatch(actor,draft());
  assert.equal(result.total,2); assert.equal(new Set(result.items.map(row=>row._id)).size,2);
  assert.deepEqual(result.items.map(row=>row.studentId),[a,b]);
  assert.equal(gates.length,1); assert.equal(db.data.audits.length,2);
  assert.equal(db.data.notifications.length,4);assert.equal(trace[0],'commit');assert.equal(trace.length,5);
  for(const row of result.items) {
    assert.equal(row.title,'Latihan pecahan');assert.equal(row.workspaceId,actor.workspaceId);
    assert.equal(row.dueAt.toISOString(),'2031-01-31T10:00:00.000Z');assert.equal(row.studentIds,undefined);assert.equal(row.groupId,undefined);
    const messages=db.data.notifications.filter(n=>n.eventKey.startsWith(`assignment:${row._id}:`));
    assert.deepEqual(messages.map(n=>n.recipientAccountId).sort(),['parent',row.studentId===a?'student-a':'student-b'].sort());
  }
});

test('draft/archived create no push; private material only notifies its own students and drops deadlines',async()=>{
  for(const status of ['draft','archived']) {
    const {db,service}=setup(); await service.saveBatch(actor,draft({status}));
    assert.equal(db.data.assignments.length,2);assert.equal(db.data.notifications.length,0);
  }
  const {db,service}=setup();
  await service.saveBatch(actor,draft({kind:'material',visibility:'student'}));
  assert.ok(db.data.assignments.every(row=>row.dueAt===undefined));
  assert.deepEqual(db.data.notifications.map(n=>n.recipientAccountId).sort(),['student-a','student-b']);
});

test('unknown/archived/foreign pupils or subjects reject the complete batch before writing',async()=>{
  for(const failure of ['missing','archived','foreign','foreign-subject']) {
    const {db,service,trace}=setup();
    if(failure==='missing') db.data.students.splice(1,1);
    if(failure==='archived') db.data.students[1].status='archived';
    if(failure==='foreign') db.data.students[1].workspaceId='other';
    if(failure==='foreign-subject') db.data.subjects[0].workspaceId='other';
    await assert.rejects(service.saveBatch(actor,draft()));
    assert.equal(db.data.assignments.length,0);assert.equal(db.data.notifications.length,0);assert.equal(db.data.audits.length,0);
    assert.deepEqual(trace,['rollback']);
  }
});

test('failure while saving another child or its outbox rolls back every assignment/audit/event',async()=>{
  for(const failure of ['assignment','outbox']) {
    const {db,service,events,trace}=setup();
    if(failure==='assignment') {
      const base=db.collection.bind(db);let writes=0;
      db.collection=name=>{const model=base(name);if(name==='assignments'){const create=model.create;model.create=async(...args)=>{if(++writes===2) throw new Error('write unavailable');return create(...args);};}return model;};
    } else {const create=events.create.bind(events);let writes=0;events.create=async(...args)=>{if(++writes===2)throw new Error('outbox unavailable');return create(...args);};}
    await assert.rejects(service.saveBatch(actor,draft()),/unavailable/);
    assert.equal(db.data.assignments.length,0);assert.equal(db.data.notifications.length,0);assert.equal(db.data.audits.length,0);
    assert.deepEqual(trace,['rollback']);
  }
});

test('Basic/expired feature gate stops batch writes, including draft requests',async()=>{
  const {db,service,subscriptions}=setup(); subscriptions.requireFeature=async()=>{throw new Error('Pro required');};
  await assert.rejects(service.saveBatch(actor,draft({status:'draft'})),/Pro required/);
  assert.equal(db.data.assignments.length,0);
});

test('service also rejects invalid recipient counts and duplicates before opening transaction',async()=>{
  const {db,service,trace}=setup();
  for(const studentIds of [[],null,[a,a],Array.from({length:101},()=>randomUUID())]) await assert.rejects(service.saveBatch(actor,draft({studentIds})),/1–100/);
  assert.equal(db.data.assignments.length,0);assert.equal(trace.length,0);
});

test('legacy single create and per-child edits preserve response, locked recipient and notification idempotency',async()=>{
  const {db,service}=setup();const {studentIds,...content}=draft();
  const row=await service.save(actor,{...content,studentId:studentIds[0]});
  assert.equal(row.studentId,a);assert.deepEqual(row.submissions,[]);assert.equal(db.data.notifications.length,2);
  await service.save(actor,{...content,studentId:a,title:'Judul diperbarui'},row._id);
  assert.equal(db.data.notifications.length,2);
  await assert.rejects(service.save(actor,{...content,studentId:b},row._id),/tidak dapat diubah/);
  await assert.rejects(service.save({...actor,workspaceId:'foreign'},{...content,studentId:a},row._id));
  assert.equal(db.data.assignments.length,1);
});

test('same-family siblings have private answers and cannot read or submit to one another',async()=>{
  const {db,service}=setup();const result=await service.saveBatch(actor,draft());
  const [first,second]=result.items;
  const pupil=db.data.portalAccounts[0], sibling=db.data.portalAccounts[1], parent=db.data.portalAccounts[2];
  await assert.rejects(service.portalGet(pupil,second._id));await assert.rejects(service.portalGet(sibling,first._id));
  await assert.rejects(service.submit(pupil,second._id,{text:'Wrong child',version:0}));
  await service.submit(pupil,first._id,{text:'Answer A',version:0});
  await service.submit(sibling,second._id,{text:'Answer B',version:0});
  assert.equal((await service.portalGet(pupil,first._id)).submissions[0].text,'Answer A');
  assert.equal((await service.portalGet(sibling,second._id)).submissions[0].text,'Answer B');
  assert.equal((await service.portalGet(parent,first._id)).studentId,a);
  assert.equal((await service.portalGet(parent,second._id)).studentId,b);
  await assert.rejects(service.portalGet({...parent,familyId:'other-family'},first._id));
});

test('editing one child never changes the other copy or its submission/feedback',async()=>{
  const {db,service}=setup();const result=await service.saveBatch(actor,draft());
  const [first,second]=result.items;const {studentIds,...content}=draft();
  await service.save(actor,{...content,studentId:studentIds[0],title:'Hanya untuk A'},first._id);
  assert.equal(db.data.assignments.find(row=>row._id===second._id).title,'Latihan pecahan');
  const answer=await service.submit(db.data.portalAccounts[1],second._id,{text:'Jawaban B',version:0});
  await service.feedback(actor,answer._id,{feedback:'Bagus',version:1});
  assert.equal((await service.get(actor,first._id)).submissions.length,0);
  assert.equal((await service.get(actor,second._id)).submissions[0].feedback,'Bagus');
});

test('batch route remains teacher-authenticated and gated by the existing assignments feature',()=>{
  const {TutorToolsController}=source('modules/tutor-tools/tutor-tools.module.ts',{
    '../../common/api':{Actor:()=>()=>{},IdPipe:class{},Public:()=>()=>{}},'../../common/query.dto':{},
    '../invitations/invitations.module':{InvitationsModule:class{}},'../invitations/portal.guard':{PortalAuthGuard:class{}},
    '../notifications/notifications.module':{NotificationsModule:class{}},
    '../subscriptions/subscriptions.guard':{RequireFeature:feature=>SetMetadata('subscriptionFeature',feature)},
    './tutor-tools.dto':dto,'./tutor-tools.service':{TutorToolsService:class{}},'./assignments.service':{AssignmentsService},
    './branding-logo.service':{BrandingLogoService:class{}},'../../storage/logo-storage.service':{LogoStorageModule:class{},MAX_LOGO_BYTES:2097152},
  });
  const handler=TutorToolsController.prototype.createBatch;
  assert.equal(Reflect.getMetadata('path',handler),'assignments/batch');
  assert.equal(Reflect.getMetadata('subscriptionFeature',handler),'assignments');
  assert.equal(Reflect.getMetadata('public',TutorToolsController),undefined);assert.equal(Reflect.getMetadata('public',handler),undefined);
});
