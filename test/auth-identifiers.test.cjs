require('reflect-metadata');
const {plainToInstance} = require('class-transformer');
const {validate} = require('class-validator');
const {LoginDto, RegisterDto} = require('../dist/modules/auth/auth.dto');
const {normalizePhone} = require('../dist/modules/auth/phone-number');
const {authSchemas} = require('../dist/modules/auth/auth.schemas');

describe('Email and Indonesian phone contracts', () => {
  test.each(['081234567890', '6281234567890', '+6281234567890', ' 0812-3456-7890 ', '+62 (812) 3456-7890'])('normalizes %s to one unique key', value => {
    expect(normalizePhone(value)).toBe('+6281234567890');
  });
  test.each([null, 81234567890, '', '81234567890', '+12025550123', '02123456789', '0812abc567890', '081234567890 ext 1', {$gt: ''}, '0'.repeat(33)])('rejects malformed/non-mobile input %p', value => {
    expect(normalizePhone(value)).toBeNull();
  });
  test('register requires both email and a normalized phone', async () => {
    const dto = plainToInstance(RegisterDto, {name:'Guru', email:' GURU@EXAMPLE.TEST ', phone:'0812-3456-7890', password:'StrongPassword123!', passwordConfirmation:'StrongPassword123!'});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('guru@example.test');
    expect(dto.phone).toBe('+6281234567890');
    expect((await validate(plainToInstance(RegisterDto, {name:'Guru', email:'guru@example.test', password:'StrongPassword123!'}))).map(error => error.property)).toContain('phone');
  });
  test.each([{phone:null}, {phone:{$ne:null}}, {email:null}, {}])('login rejects absent or non-string identity %p', async identity => {
    const dto = plainToInstance(LoginDto, {...identity, password:'StrongPassword123!'});
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
  test('role/ownership payload is still forbidden', async () => {
    const dto = plainToInstance(RegisterDto, {name:'Guru', email:'guru@example.test', phone:'081234567890', password:'StrongPassword123!', passwordConfirmation:'StrongPassword123!', role:'admin'});
    expect((await validate(dto, {whitelist:true, forbidNonWhitelisted:true})).map(error => error.property)).toContain('role');
  });
  test('phone uniqueness excludes legacy users that have no phone', () => {
    const index = authSchemas.users.indexes().find(([keys]) => keys.phone === 1);
    expect(index[1]).toMatchObject({unique:true, partialFilterExpression:{phone:{$type:'string'}}});
  });
});
