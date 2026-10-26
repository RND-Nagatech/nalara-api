const {UnauthorizedException} = require('@nestjs/common');
const {InvitationsService} = require('../dist/modules/invitations/invitations.service');
const {referralMessages} = require('../dist/modules/invitations/referral-errors');

describe('Referral error diagnosis stays on the backend', () => {
  const code='A'.repeat(20);
  const invitation={_id:'invite',workspaceId:'workspace',audience:'parent',familyId:'family',expiresAt:null};
  function serviceWith(record) {
    const query=value=>({session(){return this;},async lean(){return value;}});
    const db={collection:jest.fn(name=>({findOne:jest.fn(()=>query(name==='invitations'?record:{_id:'family',currentInvitationId:record?._id}))}))};
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
