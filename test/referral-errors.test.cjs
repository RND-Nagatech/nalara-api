const {UnauthorizedException} = require('@nestjs/common');
const {InvitationsService} = require('../dist/modules/invitations/invitations.service');
const {referralMessages} = require('../dist/modules/invitations/referral-errors');

describe('Referral error diagnosis stays on the backend', () => {
  const code='A'.repeat(20);
  const invitation={_id:'invite',workspaceId:'workspace',audience:'parent',familyId:'family',expiresAt:new Date(Date.now()+86400_000)};
  function serviceWith(record) {
    const query={session(){return this;},async lean(){return record;}};
    const db={collection:jest.fn(()=>({findOne:jest.fn(()=>query)}))};
    return new InvitationsService(db,{});
  }
  test('unknown code returns the wrong-code message without reading a target', async () => {
    const service=serviceWith(null), profile=jest.spyOn(service,'profile');
    await expect(service.verify(code,'parent')).rejects.toThrow(referralMessages.wrongCode);
    expect(profile).not.toHaveBeenCalled();
  });
  test('an unavailable family/student makes the invitation inactive', async () => {
    const service=serviceWith(invitation);
    jest.spyOn(service,'profile').mockRejectedValueOnce(new UnauthorizedException('No linked children'));
    await expect(service.verify(code,'parent')).rejects.toThrow(referralMessages.inactiveCode);
  });
  test('database/network failures are not relabeled as incorrect or inactive codes', async () => {
    const service=serviceWith(invitation), failure=new Error('Database unavailable');
    jest.spyOn(service,'profile').mockRejectedValueOnce(failure);
    await expect(service.verify(code,'parent')).rejects.toBe(failure);
  });
});
