// Isolated source contracts only: no Nest bootstrap, network or real database.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const {ValidationPipe, ForbiddenException, UnauthorizedException, ServiceUnavailableException} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb, matches} = require('./helpers/memory-db.cjs');
const {DeleteAccountDto} = source('modules/account-deletion/account-deletion.dto.ts');
const {AccountDeletionService} = source('modules/account-deletion/account-deletion.service.ts', {
  '../../database/database.module': {Database: class {}},
  '../auth/firebase-auth.service': {FirebaseAuthService: class {}},
  './account-deletion.dto': {DeleteAccountDto},
  argon2: {verify: async (hash, password) => hash === 'hash' && password === 'correct-password'},
});
const {AccountDeletionWorker, deletionDue, erasedWorkspaceCollections, collectionErasurePolicy} = source('modules/account-deletion/account-deletion.worker.ts', {
  '../../database/database.module': {Database: class {}},
  '../auth/firebase-auth.service': {FirebaseAuthService: class {}},
  '../subscriptions/billing.service': {BillingService: class {}},
  '../../storage/logo-storage.service': {LogoStorage: class {}},
});
const actor = {_id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222'};
const other = {_id: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444'};
const consent = {confirmation: 'HAPUS AKUN', acknowledged: true};
const proof = {...consent, password: 'correct-password'};
const old = new Date(Date.now() - 1000);
function setup(extra = {}) {
  const data = {
    users: [{...actor, email: 'owner@example.test', passwordHash: 'hash', firebaseUid: 'firebase-owner'}, {...other}],
    workspaces: [{_id: actor.workspaceId, ownerId: actor._id}, {_id: other.workspaceId, ownerId: other._id}],
    subscriptions: [{workspaceId: actor.workspaceId, plan: 'pro'}, {workspaceId: other.workspaceId, plan: 'basic'}],
    ...extra,
  };
  const db = memoryDb(data);
  const base = db.collection.bind(db);
  const calls = [];
  db.collection = name => {
    const model = base(name);
    model.findById = id => model.findOne({_id: id});
    const wrap = resolve => {const result = Promise.resolve().then(resolve); result.session = () => result; return result;};
    model.exists = filter => wrap(() => (data[name] ?? []).some(row => matches(row, filter)));
    model.countDocuments = filter => wrap(() => (data[name] ?? []).filter(row => matches(row, filter)).length);
    for (const operation of ['deleteMany', 'updateMany', 'updateOne']) {
      const original = model[operation];
      model[operation] = (...args) => {calls.push({name, operation, filter: structuredClone(args[0])}); return original(...args);};
    }
    return model;
  };
  db.connection.transaction = async fn => {
    const snapshot = structuredClone(data);
    try {return await fn({});}
    catch (error) {
      for (const key of Object.keys(data)) data[key].splice(0, data[key].length, ...(snapshot[key] ?? []));
      throw error;
    }
  };
  const firebase = {
    deleted: [], proofs: [],
    async verifyIdToken(token, revoked) {this.proofs.push({token, revoked}); return {uid: 'firebase-owner', auth_time: Date.now() / 1000, firebase: {sign_in_provider: 'google.com'}};},
    async deleteUser(uid) {this.deleted.push(uid);},
  };
  const billing = {cancelled: [], async cancel(who, id) {this.cancelled.push({who, id});}};
  const service = new AccountDeletionService(db, firebase);
  const logos = {purged: [], async purgeWorkspace(workspaceId) {this.purged.push(workspaceId); return true;}};
  const worker = new AccountDeletionWorker(db, firebase, billing, {get: () => undefined}, logos);
  worker.logger = {log() {}, warn() {}};
  return {db, data, calls, firebase, billing, logos, service, worker};
}
function readyJob(ctx, extra = {}) {
  ctx.data.workspaces[0].deletionRequestedAt = old;
  ctx.data.accountDeletions = [{_id: 'job', ...actor, userId: actor._id, requestedAt: old,
    nextAttemptAt: old, status: 'pending', attempts: 0, ...extra}];
  ctx.data.accountDeletions[0]._id = 'job';
}

test('summary counts actual scoped data and does not expose password or Firebase UID', async () => {
  const {service} = setup({students: [{workspaceId: actor.workspaceId}, {workspaceId: other.workspaceId}],
    targets: [{workspaceId: actor.workspaceId}], subscriptionOrders: [{workspaceId: other.workspaceId, open: true}]});
  const result = await service.summary(actor);
  assert.equal(result.students, 1); assert.equal(result.targets, 1);
  assert.equal(result.openPayment, false); assert.equal(result.googleLinked, true);
  assert.equal(result.passwordHash, undefined); assert.equal(result.firebaseUid, undefined);
});

test('wrong password returns 403 without closing the session or mutating data', async () => {
  const ctx = setup(); const before = structuredClone(ctx.data);
  await assert.rejects(ctx.service.request(actor, {...proof, password: 'wrong'}), error => error instanceof ForbiddenException && error.getStatus() === 403);
  assert.deepEqual(ctx.data, before); assert.deepEqual(ctx.firebase.deleted, []);
});

test('requires explicit consent and exactly one proof, never a client supplied target', async () => {
  for (const payload of [{...proof, confirmation: ''}, {...proof, acknowledged: false}, consent, {...proof, idToken: 'token'}]) {
    const ctx = setup(); await assert.rejects(ctx.service.request(actor, payload));
    assert.equal((ctx.data.accountDeletions ?? []).length, 0);
  }
  const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
  await assert.rejects(pipe.transform({...proof, workspaceId: other.workspaceId}, {type: 'body', metatype: DeleteAccountDto}));
  await assert.rejects(pipe.transform({...consent, password: ''}, {type: 'body', metatype: DeleteAccountDto}));
  assert.deepEqual(await pipe.transform(proof, {type: 'body', metatype: DeleteAccountDto}), Object.assign(new DeleteAccountDto(), proof));
});

test('owner and shared workspace checks fail closed before any erasure', async () => {
  for (const who of [{...actor, workspaceId: other.workspaceId}, {...actor, _id: other._id}]) {
    const ctx = setup(); await assert.rejects(ctx.service.summary(who));
  }
  const ctx = setup(); ctx.data.users.push({_id: 'second-teacher', workspaceId: actor.workspaceId});
  await assert.rejects(ctx.service.request(actor, proof), /lebih dari satu akun Guru/);
  assert.equal(ctx.calls.length, 0);
});

test('Google proof checks revocation, same UID, google provider and recent auth_time', async () => {
  const ctx = setup(); await ctx.service.request(actor, {...consent, idToken: 'proof-token'});
  assert.deepEqual(ctx.firebase.proofs, [{token: 'proof-token', revoked: true}]);
  assert.equal(ctx.data.accountDeletions[0].firebaseUid, 'firebase-owner');
  assert.deepEqual(ctx.firebase.deleted, []); // HTTP acceptance is not provider erasure.
});

for (const [name, changes] of Object.entries({
  'different account': {uid: 'someone-else'}, 'old authentication': {auth_time: Date.now() / 1000 - 3600, iat: Date.now() / 1000},
  'future authentication': {auth_time: Date.now() / 1000 + 3600}, 'missing authentication time': {auth_time: undefined},
  'another provider': {firebase: {sign_in_provider: 'password'}},
})) {
  test(`Google rejects ${name} without deletion`, async () => {
    const ctx = setup(); const verify = ctx.firebase.verifyIdToken.bind(ctx.firebase);
    ctx.firebase.verifyIdToken = async (...args) => ({...await verify(...args), ...changes});
    await assert.rejects(ctx.service.request(actor, {...consent, idToken: 'proof-token'}), ForbiddenException);
    assert.equal((ctx.data.accountDeletions ?? []).length, 0);
  });
}

test('revoked Google proof becomes 403; provider outage remains retriable and does not erase', async () => {
  for (const failure of [new UnauthorizedException('revoked'), new ServiceUnavailableException('offline')]) {
    const ctx = setup(); ctx.firebase.verifyIdToken = async () => {throw failure;};
    await assert.rejects(ctx.service.request(actor, {...consent, idToken: 'proof-token'}), error => error.getStatus() === (failure instanceof UnauthorizedException ? 403 : 503));
    assert.equal((ctx.data.accountDeletions ?? []).length, 0);
  }
});

test('acceptance atomically closes only owner, portal sessions, invitations and notification delivery', async () => {
  const ctx = setup({authSessions: [{userId: actor._id}, {userId: other._id}],
    portalAccounts: [{_id: 'portal-a', workspaceId: actor.workspaceId, status: 'active'}, {_id: 'portal-b', workspaceId: other.workspaceId, status: 'active'}],
    portalSessions: [{accountId: 'portal-a'}, {accountId: 'portal-b'}],
    notificationDevices: [{workspaceId: actor.workspaceId}, {workspaceId: other.workspaceId}],
    invitations: [{workspaceId: actor.workspaceId}, {workspaceId: other.workspaceId}],
    notifications: [{workspaceId: actor.workspaceId, deliveryStatus: 'delivering', deliveryClaimId: 'claim'}, {workspaceId: other.workspaceId, deliveryStatus: 'pending'}]});
  assert.equal((await ctx.service.request(actor, proof)).status, 'pending');
  assert.ok(ctx.data.users[0].deletionRequestedAt);
  assert.ok(ctx.data.subscriptions[0].deletionRequestedAt);
  assert.deepEqual(ctx.data.authSessions, [{userId: other._id}]);
  assert.deepEqual(ctx.data.portalSessions, [{accountId: 'portal-b'}]);
  assert.equal(ctx.data.portalAccounts[0].status, 'revoked');
  assert.equal(ctx.data.portalAccounts[1].status, 'active');
  assert.equal(ctx.data.notifications[0].deliveryStatus, 'suppressed');
  assert.equal(ctx.data.notifications[0].deliveryClaimId, undefined);
  assert.equal(ctx.data.notifications[1].deliveryStatus, 'pending');
  assert.equal(ctx.data.invitations[1].revokedAt, undefined);
  const job = ctx.data.accountDeletions[0];
  for (const privateKey of ['email', 'phone', 'password', 'passwordHash', 'idToken']) assert.equal(job[privateKey], undefined);
});

test('transaction failure rolls back account closure and durable request together (fake contract)', async () => {
  const ctx = setup(); const base = ctx.db.collection;
  ctx.db.collection = name => {
    const model = base(name);
    if (name === 'notificationDevices') model.deleteMany = async () => {throw new Error('write failed');};
    return model;
  };
  await assert.rejects(ctx.service.request(actor, proof), /write failed/);
  assert.equal(ctx.data.users[0].deletionRequestedAt, undefined);
  assert.equal((ctx.data.accountDeletions ?? []).length, 0);
});

test('all workspace batch policies are included in the erasure list', () => {
  assert.deepEqual(Object.entries(collectionErasurePolicy).filter(([, policy]) => policy === 'workspace-batch').map(([name]) => name).sort(), [...erasedWorkspaceCollections].sort());
  assert.equal(collectionErasurePolicy.accountDeletions, 'tombstone');
});

test('worker erases only the confirmed workspace and Firebase app identity, retaining a minimal tombstone', async () => {
  const ctx = setup();
  for (const name of erasedWorkspaceCollections) ctx.data[name] = [{_id: `${name}-a`, workspaceId: actor.workspaceId}, {_id: `${name}-b`, workspaceId: other.workspaceId}];
  await ctx.service.request(actor, proof);
  await ctx.worker.run();
  for (const name of erasedWorkspaceCollections) assert.deepEqual(ctx.data[name], [{_id: `${name}-b`, workspaceId: other.workspaceId}]);
  assert.equal(ctx.data.users.length, 1); assert.equal(ctx.data.users[0]._id, other._id);
  assert.equal(ctx.data.workspaces.length, 1); assert.equal(ctx.data.workspaces[0]._id, other.workspaceId);
  assert.deepEqual(ctx.firebase.deleted, ['firebase-owner']);
  assert.equal(ctx.data.accountDeletions[0].firebaseUid, undefined);
  assert.equal(ctx.data.accountDeletions[0].status, 'completed');
  assert.ok(ctx.calls.filter(call => call.operation === 'deleteMany').every(call => Object.keys(call.filter).length > 0));
});

test('bounded batch retries remaining data and rechecks tombstone for late in-flight writes', async () => {
  const ctx = setup({students: Array.from({length: 501}, (_, index) => ({_id: String(index), workspaceId: actor.workspaceId}))});
  readyJob(ctx);
  await ctx.worker.run(); assert.equal(ctx.data.students.length, 1); assert.equal(ctx.data.accountDeletions[0].status, 'pending');
  ctx.data.accountDeletions[0].nextAttemptAt = old;
  await ctx.worker.run(); assert.equal(ctx.data.students.length, 0); assert.equal(ctx.data.accountDeletions[0].status, 'completed');
  ctx.data.students.push({_id: 'late-write', workspaceId: actor.workspaceId});
  ctx.data.accountDeletions[0].nextAttemptAt = old;
  await ctx.worker.run(); assert.equal(ctx.data.students.length, 0);
});

test('Firebase outage leaves access closed and durable retry; later success completes', async () => {
  const ctx = setup(); await ctx.service.request(actor, proof);
  ctx.firebase.deleteUser = async () => {throw new Error('offline');};
  await ctx.worker.run(); assert.equal(ctx.data.accountDeletions[0].status, 'pending');
  assert.equal(ctx.data.users.some(user => user._id === actor._id), false);
  assert.equal(ctx.data.accountDeletions[0].firebaseUid, 'firebase-owner');
  ctx.firebase.deleteUser = async () => {}; ctx.data.accountDeletions[0].nextAttemptAt = old;
  await ctx.worker.run(); assert.equal(ctx.data.accountDeletions[0].status, 'completed');
});

test('account deletion purges only its workspace logo files and retries storage failure', async () => {
  const ctx = setup(); readyJob(ctx);
  ctx.logos.purgeWorkspace = async workspaceId => {ctx.logos.purged.push(workspaceId); throw new Error('storage unavailable');};
  await ctx.worker.run();
  assert.deepEqual(ctx.logos.purged, [actor.workspaceId]);
  assert.equal(ctx.data.accountDeletions[0].status, 'pending');
  assert.equal(ctx.data.workspaces.some(row => row._id === actor.workspaceId), true);
  ctx.logos.purgeWorkspace = async () => true; ctx.data.accountDeletions[0].nextAttemptAt = old;
  await ctx.worker.run(); assert.equal(ctx.data.accountDeletions[0].status, 'completed');
});

test('existing unpaid payment is cancelled before removing only its scoped order/event', async () => {
  const ctx = setup({subscriptionOrders: [{_id: 'order-a', workspaceId: actor.workspaceId, open: true, status: 'pending', reference: 'NLR-a'},
    {_id: 'order-b', workspaceId: other.workspaceId, open: true, status: 'pending', reference: 'NLR-b'}],
    billingEvents: [{reference: 'NLR-a'}, {reference: 'NLR-b'}]});
  readyJob(ctx); await ctx.worker.run();
  assert.deepEqual(ctx.billing.cancelled, [{who: {workspaceId: actor.workspaceId}, id: 'order-a'}]);
  assert.equal(ctx.data.subscriptionOrders[0]._id, 'order-b'); assert.deepEqual(ctx.data.billingEvents, [{reference: 'NLR-b'}]);
});

test('payment outage retains the order and retries, independently still cleans Firebase', async () => {
  const ctx = setup({subscriptionOrders: [{_id: 'order', workspaceId: actor.workspaceId, open: true, status: 'pending', reference: 'NLR-a'}]});
  readyJob(ctx, {firebaseUid: 'firebase-owner'}); ctx.billing.cancel = async () => {throw new Error('provider unavailable');};
  await ctx.worker.run(); assert.equal(ctx.data.subscriptionOrders.length, 1);
  assert.equal(ctx.data.accountDeletions[0].status, 'pending'); assert.deepEqual(ctx.firebase.deleted, ['firebase-owner']);
});

test('malformed job or transferred/shared workspace never erases anything', async () => {
  for (const scenario of ['invalid-id', 'transferred', 'shared']) {
    const ctx = setup({students: [{_id: 'student', workspaceId: actor.workspaceId}]}); readyJob(ctx);
    if (scenario === 'invalid-id') ctx.data.accountDeletions[0].workspaceId = undefined;
    if (scenario === 'transferred') ctx.data.workspaces[0].ownerId = other._id;
    if (scenario === 'shared') ctx.data.users.push({_id: 'second', workspaceId: actor.workspaceId});
    await ctx.worker.run(); assert.equal(ctx.data.students.length, 1); assert.equal(ctx.calls.some(call => call.operation === 'deleteMany'), false);
    assert.equal(ctx.data.accountDeletions[0].status, 'pending');
  }
});

test('active lease is skipped, expired lease recovered, lost claim cannot continue batch deletes', async () => {
  const ctx = setup({students: [{_id: 'student', workspaceId: actor.workspaceId}]});
  readyJob(ctx, {claimId: 'old', leaseUntil: new Date(Date.now() + 60_000)});
  await ctx.worker.run(); assert.equal(ctx.data.students.length, 1);
  ctx.data.accountDeletions[0].leaseUntil = old;
  const base = ctx.db.collection;
  ctx.db.collection = name => {
    const model = base(name);
    if (name === 'accountDeletions') {
      const original = model.updateOne;
      model.updateOne = (filter, changes) => {
        if (changes.$set?.leaseUntil) {ctx.data.accountDeletions[0].claimId = 'another-worker'; return Promise.resolve({matchedCount: 0});}
        return original(filter, changes);
      };
    }
    return model;
  };
  await ctx.worker.run(); assert.equal(ctx.data.students.length, 1);
  assert.equal(ctx.data.accountDeletions[0].claimId, 'another-worker');
  assert.equal(ctx.data.accountDeletions[0].status, 'processing');
  assert.equal(matches({nextAttemptAt: old, leaseUntil: old}, deletionDue()), true);
});

test('controller remains teacher-authenticated, no-store, DELETE accepted and throttled', () => {
  const {AccountDeletionController} = source('modules/account-deletion/account-deletion.module.ts', {
    '../../common/api': {Actor: () => () => {}}, '../auth/auth.module': {AuthModule: class {}},
    './account-deletion.service': {AccountDeletionService}, './account-deletion.worker': {AccountDeletionWorker}, './account-deletion.dto': {DeleteAccountDto},
    '../../storage/logo-storage.service': {LogoStorageModule: class {}},
  });
  assert.equal(Reflect.getMetadata('path', AccountDeletionController), 'account-deletion');
  assert.equal(Reflect.getMetadata('public', AccountDeletionController), undefined);
  assert.equal(Reflect.getMetadata('__httpCode__', AccountDeletionController.prototype.remove), 202);
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', AccountDeletionController.prototype.remove), 5);
});

test('expired subscription may delete account, not arbitrary protected mutations', async () => {
  const {SubscriptionGuard} = source('modules/subscriptions/subscriptions.guard.ts', {'./subscriptions.service': {SubscriptionsService: class {}}});
  let blocked = 0;
  const guard = new SubscriptionGuard({getAllAndOverride: () => undefined}, {requireActive: async () => {blocked++; throw new Error('expired');}});
  const context = (method, path) => ({getHandler() {}, getClass() {}, switchToHttp: () => ({getRequest: () => ({user: actor, method, path})})});
  assert.equal(await guard.canActivate(context('DELETE', '/api/v1/account-deletion')), true);
  await assert.rejects(guard.canActivate(context('DELETE', '/api/v1/students/id')), /expired/);
  assert.equal(blocked, 1);
});

const {AuthService, tokenHash, safeUser} = source('modules/auth/auth.service.ts', {
  '../../database/database.module': {Database: class {}}, './auth.dto': {},
  './firebase-auth.service': {FirebaseAuthService: class {}},
  './phone-number': {normalizePhone: value => value}, './password-policy': {assertPasswordPolicy() {}},
  './password-reset-otp.service': {PasswordResetOtpService: class {}}, './resend-mail.service': {ResendMailService: class {}},
  '../subscriptions/subscriptions.service': {SubscriptionsService: class {}},
  argon2: {verify: async () => true, hash: async () => 'hash', argon2id: 2},
});
function authFor(ctx, ensure = async () => {}) {
  return new AuthService(ctx.db, ctx.firebase, {}, {}, {ensure});
}

test('old Google UID stays blocked after Firebase cleanup via a nonreversible fingerprint', async () => {
  const ctx = setup(); await ctx.service.request(actor, proof); await ctx.worker.run();
  assert.equal(ctx.data.accountDeletions[0].firebaseUidHash, tokenHash('firebase-owner'));
  ctx.firebase.verifyIdToken = async () => ({uid: 'firebase-owner', email: 'owner@example.test', email_verified: true});
  await assert.rejects(authFor(ctx).loginWithGoogle({idToken: 'stale-token'}), ForbiddenException);
  assert.equal(ctx.data.users.length, 1);
});

test('Google linking cannot attach an identity after account deletion wins the user write', async () => {
  const ctx = setup(); delete ctx.data.users[0].firebaseUid;
  ctx.firebase.verifyIdToken = async () => ({uid: 'firebase-owner', email: 'owner@example.test', email_verified: true});
  const base = ctx.db.collection;
  ctx.db.collection = name => {
    const model = base(name);
    if (name === 'users') {
      const original = model.updateOne;
      model.updateOne = (filter, changes) => {
        if (changes.$set?.firebaseUid) ctx.data.users[0].deletionRequestedAt = old;
        return original(filter, changes);
      };
    }
    return model;
  };
  await assert.rejects(authFor(ctx).loginWithGoogle({idToken: 'proof'}), /Informasi akun berubah/);
  assert.equal(ctx.data.users[0].firebaseUid, undefined); assert.equal((ctx.data.authSessions ?? []).length, 0);
});

test('login session issuance rechecks closure transactionally after password validation', async () => {
  const ctx = setup();
  const auth = authFor(ctx, async () => {ctx.data.users[0].deletionRequestedAt = old;});
  await assert.rejects(auth.login({email: 'owner@example.test', password: 'correct-password'}), ForbiddenException);
  assert.equal((ctx.data.authSessions ?? []).length, 0);
});

test('teacher guard refuses a closed account even if an old session row remains', async () => {
  const ctx = setup({authSessions: [{userId: actor._id, accessHash: tokenHash('a'.repeat(43)), accessExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 60_000)}]});
  ctx.data.users[0].role = 'teacher'; ctx.data.users[0].deletionRequestedAt = old;
  const {AuthGuard} = source('modules/auth/auth.guard.ts', {
    '../../database/database.module': {Database: class {}}, '../../common/api': {}, './auth.service': {tokenHash, safeUser},
  });
  const request = {headers: {authorization: `Bearer ${'a'.repeat(43)}`}};
  const context = {getHandler() {}, getClass() {}, switchToHttp: () => ({getRequest: () => request})};
  await assert.rejects(new AuthGuard({getAllAndOverride: () => false}, ctx.db).canActivate(context), UnauthorizedException);
  assert.equal(request.user, undefined);
});

test('a verified late payment never restores entitlements to a deleted workspace', async () => {
  const ctx = setup({subscriptionOrders: [{_id: 'order', workspaceId: actor.workspaceId, plan: 'pro', amount: 79000, reference: 'NLR-a', status: 'pending', open: true}]});
  await ctx.service.request(actor, proof);
  const catalog = source('modules/subscriptions/catalog.ts');
  const {BillingService} = source('modules/subscriptions/billing.service.ts', {
    '../../database/database.module': {Database: class {}}, './catalog': catalog,
    './subscriptions.service': {SubscriptionsService: class {}}, './singapay.provider': {SingaPayProvider: class {}},
  });
  const before = structuredClone(ctx.data.subscriptions[0]);
  await new BillingService(ctx.db, {}, {paid: async () => true}).reconcile('NLR-a');
  assert.deepEqual(ctx.data.subscriptions[0], before);
  assert.equal(ctx.data.subscriptionOrders[0].status, 'paid');
  assert.equal(ctx.data.subscriptionOrders[0].periodEnd, undefined);
  assert.equal((ctx.data.audits ?? []).length, 0);
});

test('Firebase user-not-found is an idempotent success; other provider failures retry', async () => {
  const {FirebaseAuthService} = source('modules/auth/firebase-auth.service.ts', {
    'firebase-admin/app': {}, 'firebase-admin/auth': {},
  });
  const service = new FirebaseAuthService({});
  const deleted = [];
  service.getAuthClient = () => ({deleteUser: async uid => {deleted.push(uid); throw Object.assign(new Error('absent'), {code: 'auth/user-not-found'});}});
  await service.deleteUser('firebase-owner'); assert.deepEqual(deleted, ['firebase-owner']);
  service.getAuthClient = () => ({deleteUser: async () => {throw new Error('offline');}});
  await assert.rejects(service.deleteUser('firebase-owner'), ServiceUnavailableException);
});
