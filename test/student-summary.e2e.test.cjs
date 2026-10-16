const {randomUUID}=require('node:crypto');
const databaseName=`nalara_test_${randomUUID().replaceAll('-','')}`;
process.env.MONGODB_URI=`mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.NODE_ENV='test';process.env.LOG_LEVEL='silent';process.env.CORS_ORIGINS='http://localhost:8080';
const {createApplication}=require('../dist/main');
const {Database}=require('../dist/database/database.module');
const {StudentSummaryService}=require('../dist/modules/students/student-summary.service');
const {StudentListProgressService}=require('../dist/modules/students/student-list-progress.service');
let app,db,base,teacher,other,student,empty,many,service,listProgress;
const now=new Date('2026-10-15T05:00:00Z');
async function request(path,body,session) {
  const response=await fetch(`${base}/api/v1${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session.accessToken}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,...await response.json()};
}
beforeAll(async()=>{
  app=await createApplication();await app.listen(0,'127.0.0.1');base=await app.getUrl();db=app.get(Database);service=app.get(StudentSummaryService);
  listProgress=app.get(StudentListProgressService);
  const accounts=[];
  for(let i=0;i<2;i++) {
    const result=await request('/auth/register',{name:`Guru ${i}`,email:`summary-${i}@example.test`,phone:`08123456789${i}`,password:'StrongPassword123!',passwordConfirmation:'StrongPassword123!'});
    expect(result.status).toBe(201);accounts.push(result.data);
  }
  [teacher,other]=accounts;
  const workspaceId=teacher.user.workspaceId;
  [student,empty,many]=await db.collection('students').create([{workspaceId,name:'Alya'},{workspaceId,name:'Belum ada target'},{workspaceId,name:'Lebih dari satu halaman'}]);
  const subject=await db.collection('subjects').create({workspaceId,name:'Matematika'});
  const plan=await db.collection('plans').create({workspaceId,studentId:student._id,subjectId:subject._id,title:'Periode Oktober',startAt:new Date('2026-09-30T17:00:00Z'),endAt:new Date('2026-10-31T16:59:59Z')});
  const make=(progress,status='active')=>({_id:randomUUID(),workspaceId,studentId:student._id,subjectId:subject._id,planId:plan._id,title:'Target',progress,status,version:0,createdAt:new Date('2026-10-01T00:00:00Z'),updatedAt:now});
  const targets=[make(20),make(100,'completed'),make(40),make(90,'archived'),make(90,'cancelled')];
  await db.collection('targets').collection.insertMany(targets);
  await db.collection('histories').create([
    {workspaceId,studentId:student._id,planId:plan._id,targetId:targets[0]._id,before:0,after:20,actorId:teacher.user._id,createdAt:new Date('2026-10-13T03:00:00Z')},
    {workspaceId,studentId:student._id,planId:plan._id,targetId:targets[1]._id,before:0,after:100,actorId:teacher.user._id,createdAt:new Date('2026-10-14T03:00:00Z')},
    {workspaceId:other.user.workspaceId,studentId:student._id,planId:plan._id,targetId:targets[0]._id,before:99,after:99,actorId:other.user._id,createdAt:new Date('2026-10-14T04:00:00Z')},
  ]);
  const manyPlan=await db.collection('plans').create({workspaceId,studentId:many._id,subjectId:subject._id,title:'Banyak target',startAt:plan.startAt,endAt:plan.endAt});
  await db.collection('targets').collection.insertMany(Array.from({length:105},()=>({...make(10),studentId:many._id,planId:manyPlan._id})));
});
afterAll(async()=>{if(db?.connection.name===databaseName) await db.connection.dropDatabase();if(app) await app.close();});
describe('Backend-owned student summary',()=>{
  test('list enrichment returns a complete weekly mean per row, preserving order and null',async()=>{
    const rows=await listProgress.enrich(teacher.user,[many.toObject(),empty.toObject(),student.toObject()],now);
    expect(rows.map(row=>row._id)).toEqual([many._id,empty._id,student._id]);
    expect(rows[0].learningSummary).toMatchObject({weeklyProgress:10,targetCount:105});
    expect(rows[1].learningSummary).toMatchObject({weeklyProgress:null,targetCount:0,subjectNames:[]});
    expect(rows[2].learningSummary).toEqual({weeklyProgress:53,targetCount:3,subjectNames:['Matematika'],weekStartDate:'2026-10-12',weekEndDate:'2026-10-18',timezone:'Asia/Jakarta'});
    expect(await listProgress.enrich(teacher.user,[],now)).toEqual([]);
    const page=await request('/students?limit=1&page=1',null,teacher);
    expect(page.status).toBe(200);
    expect(page.data).toMatchObject({total:await db.collection('students').countDocuments({workspaceId:teacher.user.workspaceId}),page:1,limit:1});
    expect(page.data.items).toHaveLength(1);
    expect(page.data.items[0].learningSummary).toMatchObject({targetCount:expect.any(Number),subjectNames:expect.any(Array)});
  });

  test('weekly list means weight targets, exclude foreign/ineligible rows and respect plan boundaries',async()=>{
    const workspaceId=teacher.user.workspaceId;
    const row=await db.collection('students').create({workspaceId,name:'Weighted weekly mean'});
    const subjects=await db.collection('subjects').create([{workspaceId,name:'IPA'},{workspaceId,name:'Bahasa Inggris'}]);
    const makePlan=(subjectId,startAt='2026-10-11T17:00:00Z',endAt='2026-10-18T16:59:59Z')=>({_id:randomUUID(),workspaceId,studentId:row._id,subjectId,title:'Rencana',startAt:new Date(startAt),endAt:new Date(endAt)});
    const plans=[makePlan(subjects[0]._id),makePlan(subjects[1]._id),makePlan(subjects[0]._id,'2026-10-01T00:00:00Z','2026-10-11T16:59:59.999Z'),makePlan(subjects[0]._id,'2026-10-18T17:00:00Z','2026-11-01T00:00:00Z')];
    plans.push({...makePlan(subjects[0]._id),workspaceId:other.user.workspaceId});
    await db.collection('plans').create(plans);
    const makeTarget=(plan,progress,status='active',extra={})=>({_id:randomUUID(),workspaceId,studentId:row._id,subjectId:plan.subjectId,planId:plan._id,title:'Target',status,progress,...extra});
    await db.collection('targets').create([
      makeTarget(plans[0],0),makeTarget(plans[0],20),makeTarget(plans[0],12,'completed'),makeTarget(plans[1],100),
      makeTarget(plans[0],100,'archived'),makeTarget(plans[0],100,'cancelled'),
      makeTarget(plans[0],100,'active',{workspaceId:other.user.workspaceId}),
      makeTarget(plans[0],100,'active',{studentId:randomUUID()}),
      makeTarget(plans[2],100),makeTarget(plans[3],100),
      makeTarget(plans[4],100,'active',{workspaceId:other.user.workspaceId}),
    ]);
    const [result]=await listProgress.enrich(teacher.user,[row.toObject()],now);
    expect(result.learningSummary).toMatchObject({weeklyProgress:55,targetCount:4,subjectNames:['Bahasa Inggris','IPA']});
    const [zero]=await listProgress.enrich(teacher.user,[row.toObject()],new Date('2026-12-01T00:00:00Z'));
    expect(zero.learningSummary).toMatchObject({weeklyProgress:null,targetCount:0});
    const newStudent=await db.collection('students').create({workspaceId,name:'Zero progress'});
    const newPlan={...makePlan(subjects[0]._id),studentId:newStudent._id};
    await db.collection('plans').create(newPlan);
    await db.collection('targets').create(makeTarget(newPlan,0,'active',{studentId:newStudent._id}));
    const [untouched]=await listProgress.enrich(teacher.user,[newStudent.toObject()],now);
    expect(untouched.learningSummary).toMatchObject({weeklyProgress:0,targetCount:1});
  });

  test('eligible counts/rounding/week/chart use full scoped records, not a list page',async()=>{
    const value=await service.get(teacher.user,student._id,now);
    expect(value.overall).toEqual({progress:53,targetCount:3});
    expect(value.weekly).toMatchObject({targetCount:3,completedCount:1,completionProgress:33,startDate:'2026-10-12',endDate:'2026-10-18'});
    expect(value.trend).toHaveLength(7);
    expect(value.trend.at(-1)).toMatchObject({progress:53,targetCount:3,date:'2026-10-15'});
    expect(value.trend[0].progress).toBe(13);
    expect(value.trendScope).toBe('currently_eligible_targets');
    const full=await service.get(teacher.user,many._id,now);
    expect(full.overall).toEqual({progress:10,targetCount:105});
    expect(full.weekly.targetCount).toBe(105);
    expect(full.trend).toEqual([]);
  });
  test('empty data is null/not zero and never invents trend points',async()=>{
    const value=await service.get(teacher.user,empty._id,now);
    expect(value.overall).toEqual({progress:null,targetCount:0});
    expect(value.weekly).toMatchObject({targetCount:0,completedCount:0,completionProgress:null});
    expect(value.trend).toEqual([]);
  });
  test('route rejects anonymous/foreign/invalid IDs and ignores client ownership/time',async()=>{
    expect((await request(`/students/${student._id}/summary`)).status).toBe(401);
    expect((await request(`/students/${student._id}/summary`,null,other)).status).toBe(404);
    expect((await request('/students/invalid/summary',null,teacher)).status).toBe(400);
    const before=Date.now();
    const result=await request(`/students/${student._id}/summary?workspaceId=${other.user.workspaceId}&now=2000-01-01`,null,teacher);
    expect(result.status).toBe(200);expect(result.data.studentId).toBe(student._id);
    expect(new Date(result.data.generatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});
