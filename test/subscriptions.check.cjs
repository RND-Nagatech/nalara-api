// Isolated policy checks: transpile source in memory only. No dist, application,
// listener, network request, database, Redis or Firebase is started.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function source(file, mocks = {}) {
  const filename = path.resolve(__dirname, '../src', file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true}}).outputText;
  const result = {exports: {}};
  const resolve = name => Object.hasOwn(mocks, name) ? mocks[name] : require(name);
  new Function('require', 'module', 'exports', compiled)(resolve, result, result.exports);
  return result.exports;
}
const catalog = source('modules/subscriptions/catalog.ts');
const config = {get: () => undefined};
const policy = source('modules/subscriptions/subscriptions.service.ts', {'../../database/database.module': {Database: class {}}, './catalog': catalog});
const provider = source('modules/subscriptions/singapay.provider.ts');
const billingModule = source('modules/subscriptions/billing.service.ts', {'../../database/database.module': {Database: class {}}, './catalog': catalog, './subscriptions.service': policy, './singapay.provider': provider});
test('Basic 30 students / Rp39k; Pro unlimited / Rp79k, no attachment entitlement', () => {
  const [basic, pro] = catalog.planCatalog(config);
  assert.equal(basic.studentLimit, 30); assert.equal(basic.price, 39000);
  assert.equal(pro.studentLimit, null); assert.equal(pro.price, 79000);
  assert.equal(basic.features.length, 0); assert.ok(pro.features.includes('pdfExport'));
  assert.ok(!pro.features.includes('attachments'));
});
test('catalog prices can be changed by server configuration', () => {
  const [basic] = catalog.planCatalog({get: key => key === 'SUBSCRIPTION_BASIC_PRICE' ? 45000 : undefined});
  assert.equal(basic.price, 45000);
});
test('trial and paid access expire exactly at the server deadline', () => {
  const end = new Date('2026-11-01T00:00:00Z');
  const row = {plan: 'trial', trialEndsAt: end};
  assert.equal(catalog.effectiveSubscription(row, new Date(end - 1)).active, true);
  assert.equal(catalog.effectiveSubscription(row, end).active, false);
  assert.equal(catalog.effectiveSubscription({...row, plan: 'basic', paidThrough: end}, end).status, 'expired');
});
test('a paid plan without verified paidThrough is never active', () => {
  assert.equal(catalog.effectiveSubscription({plan: 'pro', trialEndsAt: new Date('2099-01-01')}).active, false);
});
test('monthly renewal clamps month-end and handles leap years', () => {
  assert.equal(catalog.nextBillingDate(new Date('2026-01-31T08:15:00Z')).toISOString(), '2026-02-28T08:15:00.000Z');
  assert.equal(catalog.nextBillingDate(new Date('2028-01-31T08:15:00Z')).toISOString(), '2028-02-29T08:15:00.000Z');
  assert.equal(catalog.nextBillingDate(new Date('2026-12-15T08:15:00Z')).toISOString(), '2027-01-15T08:15:00.000Z');
});
test('Basic cannot invoke Pro features and returns a machine-readable paywall', async () => {
  const service = new policy.SubscriptionsService({}, config);
  service.state = async () => ({active: true, features: []});
  await assert.rejects(service.requireFeature('tenant-a', 'pdfExport'), error => error.getStatus() === 402 && error.getResponse().code === 'FEATURE_NOT_INCLUDED');
});
test('expired access cannot invoke Pro features', async () => {
  const service = new policy.SubscriptionsService({}, config);
  service.state = async () => ({active: false, features: []});
  await assert.rejects(service.requireFeature('tenant-a', 'pdfExport'), error => error.getResponse().code === 'SUBSCRIPTION_REQUIRED');
});
test('trial exposes all Pro features but a five-student limit', async () => {
  const service = new policy.SubscriptionsService({}, config);
  service.ensure = async () => ({plan:'trial',trialStartedAt:new Date(),trialEndsAt:new Date(Date.now()+86400000)});
  const state = await service.state('tenant-a');
  assert.equal(state.studentLimit,5); assert.deepEqual(state.features,[...catalog.proFeatures]);
});
test('background entitlement lookup never starts a trial',async () => {
  let reads=0;
  const service = new policy.SubscriptionsService({collection: name => {assert.equal(name,'subscriptions');return {findOne: () => ({lean:async () => {reads++;return null;}})};}},config);
  assert.equal(await service.canUse('tenant-a','automaticReminders'),false); assert.equal(reads,1);
});
function capacityService(plan, count) {
  const now = Date.now(); let lockSession, countSession;
  const db = {collection: name => name === 'subscriptions' ? {findOneAndUpdate: (filter, update, options) => { assert.equal(filter.workspaceId, 'tenant-a'); lockSession = options.session; return {lean: async () => ({plan, trialEndsAt: new Date(now + 86400000), paidThrough: new Date(now + 86400000)})}; }} : {countDocuments: filter => {assert.equal(filter.workspaceId, 'tenant-a'); assert.equal(filter.status, 'active'); return {session: async s => {countSession = s; return count; }}; }}};
  return {service: new policy.SubscriptionsService(db, config), sessions: () => [lockSession, countSession]};
}
test('trial permits at most 5 active students using the same transaction lock', async () => {
  const allowed = capacityService('trial', 4), session = {};
  await allowed.service.capacity('tenant-a', session); assert.deepEqual(allowed.sessions(), [session, session]);
  await assert.rejects(capacityService('trial', 5).service.capacity('tenant-a', {}), error => error.getResponse().code === 'STUDENT_LIMIT_REACHED');
});
test('Basic permits 30 and Pro has no active-student count cap', async () => {
  await capacityService('basic', 29).service.capacity('tenant-a', {});
  await assert.rejects(capacityService('basic', 30).service.capacity('tenant-a', {}));
  await capacityService('pro', 100000).service.capacity('tenant-a', {});
});
test('payment facts reject missing/invalid amounts and distinguish paid from pending', () => {
  assert.equal(provider.paymentFacts({reff_no: 'r', amount: {value: '79000.00', currency: 'IDR'}, status: 'PAID'}).amount, 79000);
  assert.equal(provider.paymentFacts({reff_no: 'r', amount: 'not-an-amount', status: 'paid'}).amount, null);
  assert.equal(provider.paymentFacts({reff_no: 'r', amount: 79000, status: 'pending'}).paid, false);
});
test('provider confirmation matches stored reference, exact amount, currency and status', async () => {
  const adapter = new provider.SingaPayProvider({get: key => key === 'SINGAPAY_ACCOUNT_ID' ? 'account-a' : undefined});
  const history = overrides => ({reff_no: 'TRANSACTION-123', payment_link_reff_no: 'wanted', amount: '79000.00', status: 'paid', payment_link: {id: 123, reff_no: 'wanted', account: {id: 'account-a'}}, ...overrides});
  for (const row of [
    history({payment_link_reff_no:'other'}), history({amount: {value:79000,currency:'USD'}}), history({amount:1}), history({status:'pending'}),
    history({payment_link:{id:999,reff_no:'wanted',account:{id:'account-a'}}}),
    history({payment_link:{id:123,reff_no:'wanted',account:{id:'other-account'}}}),
    {reff_no:'wanted',amount:79000,status:'paid'},
  ]) {
    adapter.client = {paymentLinkHistories: {list: async () => ({items:[row],raw:{pagination:{currentPage:1,totalPages:1}}})}};
    assert.equal(await adapter.paid('wanted', 79000, '123'), null);
  }
  adapter.client.paymentLinkHistories.list = async (_account, filters) => {
    assert.equal(filters.reff_no,undefined); assert.equal(filters.amount,79000);
    return {items: [history({})]};
  };
  const paid = await adapter.paid('wanted', 79000,'123');
  assert.equal(paid.reference, 'wanted'); assert.equal(paid.transactionReference,'TRANSACTION-123');
});
test('nested payment-link reference is supported without equating it to transaction reff_no',async()=>{
  const facts=provider.paymentFacts({reff_no:'transaction-ref',amount:'79000.00',status:'paid',payment_link:{id:123,reff_no:'order-ref'}});
  assert.equal(facts.reference,'order-ref');assert.equal(facts.transactionReference,'transaction-ref');assert.deepEqual(facts.linkIds,['123']);
  assert.equal(provider.paymentFacts({payment_link_reff_no:'one',payment_link:{reff_no:'two'}}).reference,'');
});
test('paid history lookup paginates and never uses the link reference as a transaction filter',async()=>{
  const adapter=new provider.SingaPayProvider(config);const pages=[];
  adapter.client={paymentLinkHistories:{list:async(_account,filters)=>{
    pages.push(filters.page);assert.equal(filters.reff_no,undefined);
    return {items:filters.page===1?[{reff_no:'tx-other',payment_link_reff_no:'other',amount:79000,status:'paid'}]:[{reff_no:'tx-a',payment_link_reff_no:'wanted',amount:'79000.00',status:'paid',payment_link:{id:123,reff_no:'wanted'}}],raw:{pagination:{currentPage:filters.page,totalPages:2}}};
  }}};
  assert.equal((await adapter.paid('wanted',79000,'123')).reference,'wanted');assert.deepEqual(pages,[1,2]);
});
test('history scans are bounded and report an incomplete lookup instead of declaring payment failure',async()=>{
  const adapter=new provider.SingaPayProvider(config);let calls=0;
  adapter.client={paymentLinkHistories:{list:async(_account,filters)=>{calls++;return {items:[{payment_link_reff_no:'other'}],raw:{pagination:{currentPage:filters.page,totalPages:99}}};}}};
  await assert.rejects(adapter.paid('wanted',79000),error=>error.getStatus()===503);assert.equal(calls,5);
});
test('checkout is disabled unless SingaPay is explicitly configured', async () => {
  const adapter = new provider.SingaPayProvider(config);
  assert.equal(adapter.configured, false);
  await assert.rejects(adapter.create('r', 79000), error => error.getStatus() === 503);
});
test('unverified callbacks never reach reconciliation', async () => {
  const service = new billingModule.BillingService({}, {}, {verify: async () => {throw new Error('invalid signature');}});
  let touched = false; service.reconcile = async () => {touched = true;};
  await assert.rejects(service.webhook('{}', {})); assert.equal(touched, false);
});
test('a confirmed order grants one billing period even when reconciliation repeats', async () => {
  const order = {_id: 'order-a', workspaceId: 'tenant-a', reference: 'ref-a', amount: 79000, plan: 'pro', status: 'pending'};
  const subscription = {_id: 'sub-a', plan: 'trial'}; let grants = 0;
  const db = {connection: {transaction: fn => fn({})}, collection: name => {
    if (name === 'subscriptionOrders') return {findOne: () => ({lean: async () => ({...order})}), findOneAndUpdate: () => ({lean: async () => {if(order.status === 'paid') return null; order.status = 'paid'; return {...order};}}), updateOne: async () => {}};
    if (name === 'subscriptions') return {findOneAndUpdate: () => ({lean: async () => ({...subscription})}), updateOne: async (_filter, update) => {grants++; Object.assign(subscription, update.$set);}};
    return {create: async () => {}};
  }};
  order.providerId='123';
  const service = new billingModule.BillingService(db, {}, {paid: async (reference,amount,linkId) => {assert.equal(reference,'ref-a');assert.equal(amount,79000);assert.equal(linkId,'123');return true;}});
  await service.reconcile('ref-a'); await service.reconcile('ref-a');
  assert.equal(grants, 1); assert.equal(subscription.plan, 'pro'); assert.ok(subscription.paidThrough instanceof Date);
});
test('subscription sync checks only the authenticated workspace pending order',async()=>{
  let reconciled;
  const db={collection:name=>{assert.equal(name,'subscriptionOrders');return {findOne:filter=>{assert.equal(filter.workspaceId,'tenant-a');assert.equal(filter.open,true);assert.deepEqual(filter.status,{$in:['creating','pending']});return {lean:async()=>({reference:'ref-a'})};}};}};
  const service=new billingModule.BillingService(db,{},{});service.reconcile=async reference=>{reconciled=reference;};
  service.recoverLink=async reference=>{assert.equal(reference,'ref-a');};
  assert.equal(await service.synchronize({workspaceId:'tenant-a'}),undefined);assert.equal(reconciled,'ref-a');
});
test('subscription sync without an open order never calls the payment provider',async()=>{
  const service=new billingModule.BillingService({collection:()=>({findOne:()=>({lean:async()=>null})})},{},{});
  service.reconcile=async()=>assert.fail('No pending order');
  assert.equal(await service.synchronize({workspaceId:'tenant-a'}),undefined);
});
test('subscription sync preserves existing access and returns an explicit warning on verification failure',async()=>{
  const service=new billingModule.BillingService({collection:()=>({findOne:()=>({lean:async()=>({_id:'order-a',reference:'ref-a'})})})},{},{});
  service.logger={warn:()=>{}};
  service.reconcile=async()=>{throw new Error('provider unavailable');};
  assert.match(await service.synchronize({workspaceId:'tenant-a'}),/belum dapat disinkronkan/);
});
test('signed callback resolves payment-link identity then re-verifies before recording delivery',async()=>{
  const order={reference:'ref-a',status:'pending'};let reconciled,recorded;
  const db={collection:name=>name==='billingEvents'?{exists:async()=>false,create:async row=>{assert.equal(order.status,'paid');recorded=row.reference;}}:{findOne:filter=>{assert.equal(filter.reference,'ref-a');return {lean:async()=>order};}}};
  const service=new billingModule.BillingService(db,{}, {verify:async()=>({type:'payment-link-transaction',payload:{data:{transaction:{reff_no:'transaction-a',type:'pl',status:'paid',amount:{value:'79000.00',currency:'IDR'}},payment:{method:'payment_link',additional_info:{payment_link:{id:123,reff_no:'ref-a'}}}}}})});
  service.reconcile=async reference=>{reconciled=reference;order.status='paid';};
  assert.deepEqual(await service.webhook('{}',{}),{received:true});assert.equal(reconciled,'ref-a');assert.equal(recorded,'ref-a');
});
test('conflicting signed callback link references are rejected before reconciliation',async()=>{
  const service=new billingModule.BillingService({collection:()=>({exists:async()=>false})},{},{verify:async()=>({type:'payment-link-transaction',payload:{data:{payment_link_reff_no:'ref-a',payment:{additional_info:{payment_link:{reff_no:'ref-b'}}}}}})});
  service.reconcile=async()=>assert.fail('Conflicting payment identity');
  await assert.rejects(service.webhook('{}',{}),error=>error.getStatus()===409);
});
test('unknown merchant payment callbacks do not grant a Nalara subscription',async()=>{
  const service=new billingModule.BillingService({collection:name=>name==='billingEvents'?{exists:async()=>false}:{findOne:()=>({lean:async()=>null})}}, {},{verify:async()=>({type:'payment-link-transaction',payload:{data:{payment_link_reff_no:'unrelated-order'}}})});
  service.reconcile=async()=>assert.fail('Unrelated payment');
  assert.deepEqual(await service.webhook('{}',{}),{received:true,ignored:true});
});
const assignmentModule = source('modules/tutor-tools/assignments.service.ts',{
  '../../common/scoped.service':{ScopedService:class{}},
  '../../common/query.dto':{ListQuery:class{}},
  '../notifications/notification-events.service':{NotificationEventsService:class{}},
  '../subscriptions/subscriptions.service':policy,
  './tutor-tools.dto':{AssignmentDto:class{},FeedbackDto:class{},SubmissionDto:class{}},
});
test('parent assignment reads are restricted to children in the authenticated family',async () => {
  const account={_id:'parent-a',workspaceId:'tenant-a',role:'parent',familyId:'family-a'};
  let checked=false;
  const db={collection:name=>{
    if(name==='students') return {find:filter=>{assert.equal(filter.familyId,'family-a');assert.equal(filter.workspaceId,'tenant-a');return {select:()=>({lean:async()=>[{_id:'child-a'}]})};}};
    if(name==='assignments') return {findOne:filter=>{assert.deepEqual(filter.studentId,{$in:['child-a']});assert.equal(filter.visibility,'shared');assert.equal(filter.status,'published');assert.equal(filter.workspaceId,'tenant-a');checked=true;return {lean:async()=>null};}};
    throw new Error('Unexpected collection');
  }};
  const service=new assignmentModule.AssignmentsService({db},{},{});
  await assert.rejects(service.portalGet(account,'other-child-task'),error=>error.getStatus()===404);assert.equal(checked,true);
});
for (const role of ['parent','student']) test(`${role} assignment listing preserves tenant, student scope and allowed visibility`,async()=>{
  const account={_id:`${role}-a`,workspaceId:'tenant-a',role,familyId:'family-a',studentId:'child-a'};
  const row={_id:'assignment-a',workspaceId:'tenant-a',studentId:'child-a',subjectId:'subject-a',status:'published',visibility:'shared'};
  let findFilter,countFilter;
  const db={collection:name=>{
    if(name==='students') return {find:filter=>{
      assert.equal(filter.workspaceId,'tenant-a');assert.equal(filter.status,'active');
      if(role==='parent') assert.equal(filter.familyId,'family-a');else assert.equal(filter._id,'child-a');
      return {select:()=>({lean:async()=>[{_id:'child-a'}]})};
    }};
    if(name==='assignments') return {
      find:filter=>{
        findFilter=filter;
        return {sort:()=>({skip:value=>{assert.equal(value,5);return {limit:limit=>{assert.equal(limit,5);return {lean:async()=>[row]};}};}})};
      },
      countDocuments:async filter=>{countFilter=filter;return 6;},
    };
    throw new Error('Unexpected collection');
  }};
  const scope={db,teachingNames:async(actor,rows)=>{assert.equal(actor.workspaceId,'tenant-a');assert.equal(rows[0].studentId,'child-a');return rows.map(item=>({...item,studentName:'Student'}));}};
  const service=new assignmentModule.AssignmentsService(scope,{},{});
  const result=await service.portalList(account,{page:2,limit:5});
  assert.deepEqual(findFilter,countFilter);assert.equal(findFilter.workspaceId,'tenant-a');assert.deepEqual(findFilter.studentId,{$in:['child-a']});assert.equal(findFilter.status,'published');
  assert.deepEqual(findFilter.visibility,role==='parent'?'shared':{$in:['student','shared']});
  assert.equal(result.items[0].studentName,'Student');assert.equal(result.total,6);assert.equal(result.page,2);
});
test('portal assignment listing rejects an unrelated student before querying assignments',async()=>{
  const db={collection:name=>{assert.equal(name,'students');return {find:()=>({select:()=>({lean:async()=>[{_id:'child-a'}]})})};}};
  const service=new assignmentModule.AssignmentsService({db},{},{});
  await assert.rejects(service.portalList({workspaceId:'tenant-a',role:'parent',familyId:'family-a'},{studentId:'other-child',page:1,limit:5}),error=>error.getStatus()===404);
});
test('a parent cannot submit an answer as a child',async () => {
  const service=new assignmentModule.AssignmentsService({}, {}, {});
  await assert.rejects(service.submit({role:'parent'},'task-a',{text:'answer',version:0}),error=>error.getStatus()===404);
});
test('expired guard allows only archival for quota management, not other student writes',async () => {
  const {SubscriptionGuard}=source('modules/subscriptions/subscriptions.guard.ts',{'./subscriptions.service':policy});
  const service={requireActive:async()=>{throw new policy.SubscriptionRequired('expired');}};
  const guard=new SubscriptionGuard({getAllAndOverride:()=>false},service);
  const request={user:{workspaceId:'tenant-a'},method:'PATCH',path:'/api/v1/students/11111111-1111-4111-8111-111111111111',body:{status:'archived'}};
  const context={getHandler:()=>()=>{},getClass:()=>class{},switchToHttp:()=>({getRequest:()=>request})};
  assert.equal(await guard.canActivate(context),true);
  request.body={status:'archived',name:'injected change'};
  await assert.rejects(guard.canActivate(context),error=>error.getStatus()===402);
  request.body={status:'active'};
  await assert.rejects(guard.canActivate(context),error=>error.getStatus()===402);
});
