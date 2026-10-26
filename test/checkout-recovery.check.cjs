const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ApiError, AuthenticationError, ConfigurationError} = require('@aliziodev/singapay');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const catalog = source('modules/subscriptions/catalog.ts');
const providerModule = source('modules/subscriptions/singapay.provider.ts');
const {BillingService} = source('modules/subscriptions/billing.service.ts', {
  '../../database/database.module': {Database: class {}},
  './subscriptions.service': {SubscriptionsService: class {}},
  './catalog': catalog, './singapay.provider': providerModule,
});
const actor = {workspaceId: 'tenant-a'};
const oldOrder = (extra = {}) => ({_id:'old', workspaceId:'tenant-a', reference:'old-ref', amount:39000,
  plan:'basic', status:'creating', open:true, createdAt:new Date(Date.now()-3600_000), ...extra});
const gatewayError = (status, code = null) => new ApiError({status, code, message:'sensitive gateway response', raw:{secret:'do-not-log'}});

function setup(orders = []) {
  const db = memoryDb({subscriptionOrders:orders, subscriptions:[{_id:'sub',workspaceId:'tenant-a',plan:'trial'}], audits:[]});
  const original = db.collection.bind(db);
  db.collection = name => {
    const collection = original(name);
    if (name === 'students') collection.countDocuments = async () => 0;
    if (name === 'subscriptionOrders') {
      const create = collection.create;
      collection.create = async input => {
        if (db.data.subscriptionOrders.some(row => row.workspaceId === input.workspaceId && row.open)) throw Object.assign(new Error('duplicate open'), {code:11000});
        return create({status:'creating',open:true,createdAt:new Date(),...input});
      };
    }
    return collection;
  };
  const calls = {create:0, paid:0, recover:0, cancel:0};
  const provider = {configured:true,
    create:async()=>{calls.create++;return {providerId:'123',checkoutUrl:'https://checkout.invalid/new'};},
    paid:async()=>{calls.paid++;return null;},
    recover:async()=>{calls.recover++;return null;},
    cancel:async()=>{calls.cancel++;},
  };
  const service = new BillingService(db,{state:async()=>({active:true,plan:'trial'}),config:{get:()=>undefined}},provider);
  const warnings=[];service.logger={warn:row=>warnings.push(row)};
  return {db,provider,service,calls,warnings};
}

test('stale orphan cancellation closes only that order; next plan gets a new reference and link',async()=>{
  const state=setup([oldOrder()]);
  const cancelled=await state.service.cancel(actor,'old');
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.open,false);
  assert.equal(state.calls.create,0);assert.equal(state.calls.cancel,0);
  const next=await state.service.checkout(actor,'pro');
  assert.notEqual(next.reference,'old-ref');assert.notEqual(next._id,'old');
  assert.equal(next.status,'pending');assert.equal(next.providerId,'123');assert.equal(state.calls.create,1);
  assert.equal(state.db.data.subscriptionOrders.length,2);assert.equal(state.db.data.subscriptionOrders[0].status,'cancelled');
  assert.equal(state.db.data.subscriptions[0].plan,'trial');
});
test('definitive create rejection closes failed order and logs no raw gateway data',async()=>{
  const state=setup();state.provider.create=async()=>{throw gatewayError(422,'SP018');};
  await assert.rejects(state.service.checkout(actor,'basic'),error=>error.getResponse().code==='PAYMENT_CREATION_REJECTED');
  const row=state.db.data.subscriptionOrders[0];assert.equal(row.open,false);assert.equal(row.status,'failed');
  assert.equal(row.creationErrorCode,'SP018');assert.equal(row.creationErrorStatus,422);
  assert.equal(row.creationLeaseUntil,undefined);assert.ok(!JSON.stringify(state.warnings).includes('sensitive'));
  assert.ok(!JSON.stringify(state.warnings).includes('do-not-log'));
  state.provider.create=async()=>({providerId:'456',checkoutUrl:'https://checkout.invalid/next'});
  assert.equal((await state.service.checkout(actor,'pro')).providerId,'456');
});
test('timeout, 5xx and duplicate/unknown outcome codes never release an open order',async()=>{
  for (const error of [new Error('timeout'),gatewayError(503),gatewayError(400),gatewayError(422,'SP005'),gatewayError(400,'SP004')]) {
    const state=setup();state.provider.create=async()=>{throw error;};
    await assert.rejects(state.service.checkout(actor,'basic'),failure=>failure.getStatus()===503);
    assert.equal(state.db.data.subscriptionOrders[0].open,true);assert.equal(state.db.data.subscriptionOrders[0].status,'creating');
    await assert.rejects(state.service.checkout(actor,'pro'),failure=>failure.getStatus()===409);
    await assert.rejects(state.service.cancel(actor,state.db.data.subscriptionOrders[0]._id),failure=>failure.getStatus()===409);
    assert.equal(state.calls.paid,0);
  }
});
test('known pre-request SDK failures close order rather than stranding it',async()=>{
  for (const failure of [new AuthenticationError('private'),new ConfigurationError('private')]) {
    const state=setup();state.provider.create=async()=>{throw failure;};
    await assert.rejects(state.service.checkout(actor,'basic'),error=>error.getResponse().code==='PAYMENT_CREATION_REJECTED');
    assert.equal(state.db.data.subscriptionOrders[0].open,false);
  }
});
test('active creation lease and fresh legacy order cannot be cancelled during creation',async()=>{
  for(const row of [oldOrder({creationLeaseUntil:new Date(Date.now()+60000)}),oldOrder({createdAt:new Date()})]) {
    const state=setup([row]);await assert.rejects(state.service.cancel(actor,'old'),error=>error.getStatus()===409);
    assert.deepEqual(state.calls,{create:0,paid:0,recover:0,cancel:0});assert.equal(row.open,true);
  }
});
test('provider/history failure keeps orphan open instead of interpreting failure as absence',async()=>{
  for(const failing of ['paid','recover']) {
    const state=setup([oldOrder()]);state.provider[failing]=async()=>{throw new Error('provider unavailable');};
    await assert.rejects(state.service.cancel(actor,'old'));
    assert.equal(state.db.data.subscriptionOrders[0].open,true);assert.equal(state.db.data.subscriptionOrders[0].status,'creating');
  }
});
test('recovered unpaid link is cancelled at provider before closing locally',async()=>{
  const state=setup([oldOrder()]);state.provider.recover=async()=>({providerId:'789',checkoutUrl:'https://checkout.invalid/existing'});
  state.provider.cancel=async id=>{assert.equal(id,'789');assert.equal(state.db.data.subscriptionOrders[0].open,true);state.calls.cancel++;};
  const result=await state.service.cancel(actor,'old');assert.equal(result.status,'cancelled');assert.equal(state.calls.cancel,1);
  assert.equal(state.calls.paid,2);assert.equal(state.calls.create,0);
});
test('provider cancellation failure never closes order or issues replacement link',async()=>{
  const state=setup([oldOrder({providerId:'789',checkoutUrl:'https://checkout.invalid/existing',status:'pending'})]);
  state.provider.cancel=async()=>{throw gatewayError(403);};
  await assert.rejects(state.service.cancel(actor,'old'));assert.equal(state.db.data.subscriptionOrders[0].open,true);
  assert.equal(state.calls.create,0);
});
test('paid before cancellation is verified/granted once, then cancellation is rejected',async()=>{
  const state=setup([oldOrder()]);state.provider.paid=async()=>({paid:true});
  await assert.rejects(state.service.cancel(actor,'old'),error=>error.getStatus()===409);
  assert.equal(state.db.data.subscriptionOrders[0].status,'paid');assert.equal(state.db.data.subscriptions[0].plan,'basic');
  assert.equal(state.calls.cancel,0);assert.equal(state.db.data.audits.length,1);
});
test('concurrent verified webhook cannot be overwritten by cancellation or late create response',async()=>{
  const state=setup([oldOrder({providerId:'789',status:'pending'})]);
  state.provider.cancel=async()=>Object.assign(state.db.data.subscriptionOrders[0],{status:'paid',open:false});
  await assert.rejects(state.service.cancel(actor,'old'),error=>error.getStatus()===409);
  assert.equal(state.db.data.subscriptionOrders[0].status,'paid');
  const creating=setup();creating.provider.create=async()=>{
    Object.assign(creating.db.data.subscriptionOrders[0],{status:'paid',open:false});
    return{providerId:'123',checkoutUrl:'https://checkout.invalid/existing'};
  };
  assert.equal((await creating.service.checkout(actor,'pro')).status,'paid');
  assert.equal(creating.db.data.subscriptionOrders[0].status,'paid');
});
test('repeat cancellation is idempotent and foreign order does not call provider',async()=>{
  const state=setup([oldOrder({status:'cancelled',open:false})]);
  assert.equal((await state.service.cancel(actor,'old')).status,'cancelled');
  await assert.rejects(state.service.cancel({workspaceId:'tenant-b'},'old'),error=>error.getStatus()===404);
  assert.deepEqual(state.calls,{create:0,paid:0,recover:0,cancel:0});
});
test('subscription sync recovers a lost checkout link as well as verifying settlement',async()=>{
  const state=setup([oldOrder()]);state.provider.recover=async()=>({providerId:'123',checkoutUrl:'https://checkout.invalid/existing'});
  assert.equal(await state.service.synchronize(actor),undefined);
  assert.equal(state.db.data.subscriptionOrders[0].status,'pending');assert.equal(state.calls.create,0);
});

function adapter() {
  const service=new providerModule.SingaPayProvider({get:()=>undefined});service.accountId='account-a';return service;
}
const page=(items,current=1,total=1)=>({items,raw:{pagination:{currentPage:current,totalPages:total,perPage:1}}});
const link=(extra={})=>({id:123,reff_no:'wanted',total_amount:'39000.00',account:{id:'account-a'},payment_url:'https://checkout.invalid/existing',...extra});
test('link recovery scans later account pages before declaring absence',async()=>{
  const service=adapter();let later=0;
  service.client={paymentLinks:{list:async()=>page([link({reff_no:'other'})],1,2)},client:{send:async request=>{
    assert.equal(request.method,'GET');assert.equal(request.query.page,2);assert.match(request.path,/account-a$/);later++;
    return page([link()],2,2);
  }}};
  assert.equal((await service.recover('wanted',39000)).providerId,'123');assert.equal(later,1);
});
test('link recovery returns absence only from a complete pagination response',async()=>{
  const service=adapter();service.client={paymentLinks:{list:async()=>page([])}};
  assert.equal(await service.recover('wanted',39000),null);
  service.client={paymentLinks:{list:async()=>({items:[]})}};
  await assert.rejects(service.recover('wanted',39000),error=>error.getStatus()===503);
});
test('missing paid-history pagination is uncertainty, never proof of nonpayment',async()=>{
  const service=adapter();service.client={paymentLinkHistories:{list:async()=>({items:[]})}};
  await assert.rejects(service.paid('wanted',39000),error=>error.getStatus()===503);
});
test('truncated repeated pages or identity mismatch never become absence',async()=>{
  const service=adapter();service.client={paymentLinks:{list:async()=>page([link({reff_no:'other'})],1,99)},client:{send:async request=>page([link({reff_no:'other'})],request.query.page,99)}};
  await assert.rejects(service.recover('wanted',39000),error=>error.getStatus()===503);
  for(const row of [link({total_amount:1}),link({account:{id:'foreign'}}),link({id:'bad-id'})]) {
    service.client={paymentLinks:{list:async()=>page([row])}};
    await assert.rejects(service.recover('wanted',39000),error=>error.getStatus()===503);
  }
});
test('known link ID remains recoverable for cancellation even when its URL is invalid',async()=>{
  const service=adapter();service.client={paymentLinks:{list:async()=>page([link({payment_url:'http://unsafe.invalid'})])}};
  assert.deepEqual(await service.recover('wanted',39000),{providerId:'123'});
});
test('provider delete treats only explicit not-found as idempotent',async()=>{
  const service=adapter();service.client={paymentLinks:{delete:async()=>{throw gatewayError(404);}}};
  await service.cancel('123');
  for(const error of [gatewayError(403),gatewayError(503),new Error('timeout')]) {
    service.client.paymentLinks.delete=async()=>{throw error;};await assert.rejects(service.cancel('123'));
  }
});
