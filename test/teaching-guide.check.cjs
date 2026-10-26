const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {validate} = require('class-validator');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const {TeachingGuideService} = source('modules/teaching-guide/teaching-guide.service.ts', {
  '../../database/database.module': {Database: class {}},
});
const {TeachingGuidePreferencesDto} = source('modules/teaching-guide/teaching-guide.dto.ts');
const actor = {_id: 'teacher-a', workspaceId: 'a'};

function setup(extra = {}) {
  const data = {users: [{...actor}], subjects: [], students: [], schedules: [], targets: [], ...extra};
  const db = memoryDb(data);
  const base = db.collection.bind(db);
  const pipelines = [];
  db.collection = name => {
    const model = base(name);
    if (name === 'students') model.collection = {name: 'students'};
    if (name === 'portalAccounts') model.aggregate = pipeline => ({option: async options => {
      pipelines.push({pipeline, options});
      const scoped = pipeline[0].$match.workspaceId;
      return (data.portalAccounts ?? []).filter(account => account.workspaceId === scoped &&
        account.role === 'parent' && account.status === 'active' && typeof account.familyId === 'string' && account.familyId !== '' &&
        data.students.some(child => child.workspaceId === scoped && child.familyId === account.familyId && child.status === 'active'))
        .slice(0, 1).map(account => ({_id: account._id}));
    }});
    return model;
  };
  return {db, data, pipelines, service: new TeachingGuideService(db)};
}

test('new tutor starts at zero, only the server derives milestones', async () => {
  const {service} = setup();
  assert.deepEqual(await service.get(actor), {tutorialSeen: false, hasSubject: false, hasStudent: false,
    hasSchedule: false, hasTarget: false, parentConnected: false});
});

test('each successful stored resource advances setup on the next read, without client completion writes', async () => {
  const {service, data} = setup();
  const fields = {subjects: 'hasSubject', students: 'hasStudent', schedules: 'hasSchedule', targets: 'hasTarget'};
  for (const [collection, field] of Object.entries(fields)) {
    assert.equal((await service.get(actor))[field], false);
    data[collection].push({workspaceId: actor.workspaceId});
    assert.equal((await service.get(actor))[field], true);
  }
});

test('guide endpoints retain the application teacher authentication guard', () => {
  const {TeachingGuideController} = source('modules/teaching-guide/teaching-guide.module.ts', {
    '../../common/api': {Actor: () => () => {}},
    './teaching-guide.dto': {TeachingGuidePreferencesDto},
    './teaching-guide.service': {TeachingGuideService},
  });
  assert.equal(Reflect.getMetadata('path', TeachingGuideController), 'teaching-guide');
  assert.equal(Reflect.getMetadata('public', TeachingGuideController), undefined);
  for (const method of ['get', 'preferences']) {
    assert.equal(Reflect.getMetadata('public', TeachingGuideController.prototype[method]), undefined);
  }
  assert.equal(Reflect.getMetadata('path', TeachingGuideController.prototype.preferences), 'preferences');
});

test('existing saved data counts, including prior archived/cancelled setup', async () => {
  const {service} = setup({subjects: [{workspaceId: 'a'}], students: [{workspaceId: 'a', status: 'archived'}],
    schedules: [{workspaceId: 'a', status: 'cancelled'}], targets: [{workspaceId: 'a', status: 'completed'}]});
  const result = await service.get(actor);
  assert.equal(result.hasSubject && result.hasStudent && result.hasSchedule && result.hasTarget, true);
  assert.equal(result.parentConnected, false);
});

test('another workspace never completes this tutor checklist', async () => {
  const {service} = setup({subjects: [{workspaceId: 'b'}], students: [{workspaceId: 'b'}],
    schedules: [{workspaceId: 'b'}], targets: [{workspaceId: 'b'}]});
  const result = await service.get(actor);
  assert.equal(result.hasSubject || result.hasStudent || result.hasSchedule || result.hasTarget, false);
  await assert.rejects(service.get({...actor, workspaceId: 'b'}), /Akun Guru tidak ditemukan/);
});

test('tutorial acknowledgement is idempotent and scoped to the authenticated teacher', async () => {
  const {service, data} = setup({users: [{...actor}, {_id: 'teacher-b', workspaceId: 'b'}]});
  assert.deepEqual(await service.preferences(actor), {tutorialSeen: true});
  assert.equal((await service.get(actor)).tutorialSeen, true);
  assert.equal(data.users[1].teachingTutorialSeen, undefined);
  await assert.rejects(service.preferences({...actor, workspaceId: 'b'}), /Akun Guru tidak ditemukan/);
  assert.deepEqual(await service.preferences(actor), {tutorialSeen: true});
  assert.equal((await service.get(actor)).hasSubject, false);
});

test('optional parent step requires current parent access and a child in this workspace', async () => {
  const {service, data, pipelines} = setup({
    students: [{workspaceId: 'a', familyId: 'family-a', status: 'active'}],
    portalAccounts: [{_id: 'parent-a', workspaceId: 'a', familyId: 'family-a', role: 'parent', status: 'active'}],
  });
  assert.equal((await service.get(actor)).parentConnected, true);
  assert.equal(pipelines[0].options.maxTimeMS, 10000);
  assert.equal(pipelines[0].pipeline[1].$lookup.let.workspaceId, '$workspaceId');
  assert.ok(pipelines[0].pipeline[1].$lookup.pipeline[0].$match.$expr.$and.some(
    clause => clause.$eq[0] === '$workspaceId' && clause.$eq[1] === '$$workspaceId'));
  data.portalAccounts[0].status = 'revoked';
  assert.equal((await service.get(actor)).parentConnected, false);
  data.portalAccounts[0].status = 'active'; data.students[0].workspaceId = 'b';
  assert.equal((await service.get(actor)).parentConnected, false);
  data.students[0].workspaceId = 'a'; data.students[0].status = 'archived';
  assert.equal((await service.get(actor)).parentConnected, false);
});

test('database errors propagate rather than inventing an empty checklist', async () => {
  const {service, db} = setup();
  const original = db.collection;
  db.collection = name => name === 'subjects' ? {exists: async () => {throw new Error('database unavailable');}} : original(name);
  await assert.rejects(service.get(actor), /database unavailable/);
});

test('only tutorialSeen true is accepted; legacy preferences and completion injection are rejected', async () => {
  assert.equal((await validate(Object.assign(new TeachingGuidePreferencesDto(), {tutorialSeen: true}))).length, 0);
  for (const tutorialSeen of [undefined, null, false, 'true', 1]) {
    assert.ok((await validate(Object.assign(new TeachingGuidePreferencesDto(), {tutorialSeen}))).length > 0);
  }
  const pipe = new ValidationPipe({whitelist: true, forbidNonWhitelisted: true, transform: true});
  for (const injected of ['dismissed', 'hasTarget', 'hasSubject', 'workspaceId', 'userId', 'completedCount']) {
    await assert.rejects(pipe.transform({tutorialSeen: true, [injected]: 'injected'}, {
      type: 'body', metatype: TeachingGuidePreferencesDto,
    }));
  }
});

test('only the exact non-domain preference route bypasses an expired subscription', async () => {
  const {SubscriptionGuard} = source('modules/subscriptions/subscriptions.guard.ts', {
    './subscriptions.service': {SubscriptionsService: class {}},
  });
  let gated = 0;
  const guard = new SubscriptionGuard({getAllAndOverride: () => false}, {
    requireActive: async () => {gated++; throw new Error('subscription required');},
  });
  const request = {user: actor, method: 'PATCH', path: '/api/v1/teaching-guide/preferences'};
  const context = {getHandler() {}, getClass() {}, switchToHttp: () => ({getRequest: () => request})};
  assert.equal(await guard.canActivate(context), true);
  for (const path of ['/api/v1/teaching-guide/complete', '/api/v1/students/student-a', '/api/v1/teaching-guide/preferences/other']) {
    request.path = path;
    await assert.rejects(guard.canActivate(context), /subscription required/);
  }
  assert.equal(gated, 3);
});
