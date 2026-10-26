require('reflect-metadata');
const {randomUUID} = require('node:crypto');
const {plainToInstance} = require('class-transformer');
const {validate} = require('class-validator');
const {createReferralCode, normalizeReferralCode, referralCodeHash} = require('../dist/modules/invitations/referral-code');
const {InvitationCodeDto, RedeemCodeDto} = require('../dist/modules/invitations/invitations.dto');
const {assertUsableInvitation, referralMessages} = require('../dist/modules/invitations/referral-errors');
const {FamilyDto, UpdateFamilyDto} = require('../dist/modules/families/families.dto');
const {StudentDto} = require('../dist/modules/students/students.dto');
const {familiesSchemas} = require('../dist/modules/families/families.schemas');

describe('Referral and family contracts', () => {
  test('20 unbiased random symbols have a grouped, case-insensitive display', () => {
    const code = createReferralCode();
    expect(code.raw).toMatch(/^[A-HJ-NP-Z2-9]{20}$/);
    expect(normalizeReferralCode(` ${code.display.toLowerCase()} `)).toBe(code.raw);
    expect(normalizeReferralCode(code.raw.toLowerCase())).toBe(code.raw);
    expect(referralCodeHash(code.raw)).toHaveLength(64);
    expect(referralCodeHash(code.raw)).not.toBe(code.raw);
    expect(new Set(Array.from({length:100}, () => createReferralCode().raw)).size).toBe(100);
  });
  test('legacy base64 remains case sensitive; new malformed/non-string codes fail', async () => {
    const legacy = 'Ab'.repeat(21) + '_';
    expect(normalizeReferralCode(legacy)).toBe(legacy);
    for (const token of [null, {$ne:null}, 123, '', 'NLR-A0000-AAAAA-AAAAA-AAAAA']) {
      expect((await validate(plainToInstance(RedeemCodeDto, {token, audience:'parent'}))).length).toBeGreaterThan(0);
    }
  });
  test('every malformed/empty code yields one readable backend message on verify and redeem', async () => {
    for (const Dto of [InvitationCodeDto,RedeemCodeDto]) {
      for (const token of [undefined,null,{$ne:null},123,'','bad-code']) {
        const errors=await validate(plainToInstance(Dto,{token,audience:'parent'}));
        expect(errors).toHaveLength(1);
        expect(Object.values(errors[0].constraints)).toEqual([referralMessages.wrongCode]);
      }
    }
  });
  test('wrong, inactive, and mismatched role messages are distinct and contain no target data', () => {
    const now=new Date('2026-10-14T00:00:00Z');
    const valid={audience:'parent',familyId:randomUUID(),expiresAt:new Date(now.getTime()+1000)};
    expect(() => assertUsableInvitation(null,'parent')).toThrow(referralMessages.wrongCode);
    expect(() => assertUsableInvitation(valid,'student')).toThrow(referralMessages.wrongRole);
    for (const record of [
      {...valid,revokedAt:null}, {...valid,revokedAt:now}, {...valid,familyId:undefined},
      {...valid,audience:undefined}, {audience:'student',expiresAt:valid.expiresAt},
    ]) expect(() => assertUsableInvitation(record,'parent')).toThrow(referralMessages.inactiveCode);
    for (const record of [valid, {...valid,expiresAt:null}, {...valid,expiresAt:now,redeemedAt:now}, {...valid,expiresAt:undefined}]) {
      expect(() => assertUsableInvitation(record,'parent')).not.toThrow();
    }
  });
  test('redeem requires audience and forbids actor/workspace/teacher escalation', async () => {
    const token = createReferralCode().display;
    for (const audience of [undefined, null, 'teacher']) {
      expect((await validate(plainToInstance(RedeemCodeDto, {token, audience}))).map(e=>e.property)).toContain('audience');
    }
    const dto = plainToInstance(RedeemCodeDto, {token, audience:'parent', workspaceId:randomUUID()});
    expect((await validate(dto, {whitelist:true, forbidNonWhitelisted:true})).map(e=>e.property)).toContain('workspaceId');
  });
  test('one family accepts multiple children and canonicalizes parent phone', async () => {
    const dto = plainToInstance(FamilyDto, {parentName:' Ibu Alya ', parentPhone:'081234567890', studentIds:[randomUUID(),randomUUID()]});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.parentName).toBe('Ibu Alya');
    expect(dto.parentPhone).toBe('+6281234567890');
    const id = randomUUID();
    dto.studentIds = [id,id];
    expect((await validate(dto)).map(e=>e.property)).toContain('studentIds');
  });
  test('family edits require version and parent phone uniqueness is tenant-scoped', async () => {
    const fields = {parentName:'Orang Tua', parentPhone:'081234567890', studentIds:[]};
    expect((await validate(plainToInstance(UpdateFamilyDto, fields))).map(e=>e.property)).toContain('version');
    expect(await validate(plainToInstance(UpdateFamilyDto, {...fields,version:0}))).toHaveLength(0);
    const index = familiesSchemas.families.indexes().find(([keys]) => keys.parentPhone === 1);
    expect(index[0]).toEqual({workspaceId:1,parentPhone:1});
    expect(index[1].unique).toBe(true);
  });
  test('student assignment accepts UUID, omission, or explicit detach; not injected objects', async () => {
    for (const familyId of [undefined, null, randomUUID()]) {
      expect(await validate(plainToInstance(StudentDto, {name:'Alya',familyId}))).toHaveLength(0);
    }
    expect((await validate(plainToInstance(StudentDto, {name:'Alya',familyId:{$ne:null}}))).map(e=>e.property)).toContain('familyId');
  });
});
