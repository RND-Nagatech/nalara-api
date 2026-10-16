require('reflect-metadata');
const {plainToInstance} = require('class-transformer');
const {validate} = require('class-validator');
const {hash} = require('argon2');
const {RegisterDto, LoginDto, ResetDto} = require('../dist/modules/auth/auth.dto');
const {assertPasswordPolicy} = require('../dist/modules/auth/password-policy');
const {AuthService} = require('../dist/modules/auth/auth.service');
const registration = password => ({name:'Guru', email:'guru@example.test', phone:'081234567890', password, passwordConfirmation:password});
describe('Server-owned registration/password guards', () => {
  test('a strong password of exactly eight characters is accepted', async () => {
    expect(() => assertPasswordPolicy('Aa1!abcd')).not.toThrow();
    expect(await validate(plainToInstance(RegisterDto, registration('Aa1!abcd')))).toHaveLength(0);
  });
  test.each([
    ['Aa1!abc','minimal 8'],
    ['aa1!abcd','huruf besar'],
    ['AA1!ABCD','huruf kecil'],
    ['AaA!abcd','angka'],
    ['Aa12abcd','simbol'],
    ['Aa1 abcd','simbol'],
    ['Aa1!'+'a'.repeat(125),'maksimal 128'],
  ])('rejects %s with clear Indonesian policy message', async (password, message) => {
    expect(() => assertPasswordPolicy(password)).toThrow(message);
    const errors = await validate(plainToInstance(RegisterDto, registration(password)));
    expect(errors.map(error => error.property)).toContain('password');
  });
  test.each([undefined, null, '', 'Aa1!abce'])('confirmation %p is rejected by backend', async passwordConfirmation => {
    const errors = await validate(plainToInstance(RegisterDto, {...registration('Aa1!abcd'), passwordConfirmation}));
    expect(errors.map(error => error.property)).toContain('passwordConfirmation');
  });
  test('reset adopts new policy, login does not retroactively reject an old password', async () => {
    expect(await validate(plainToInstance(ResetDto, {resetToken:'a'.repeat(43), newPassword:'Aa1!abcd'}))).toHaveLength(0);
    expect(await validate(plainToInstance(LoginDto, {email:'guru@example.test', password:'old-pass'}))).toHaveLength(0);
  });
  test('direct service/seed calls cannot bypass strength or confirmation', async () => {
    const db = {collection:jest.fn()};
    const service = new AuthService(db, {}, {});
    await expect(service.register(registration('aa1!abcd'))).rejects.toThrow('huruf besar');
    await expect(service.register({...registration('Aa1!abcd'), passwordConfirmation:'different'})).rejects.toThrow('Ulangi kata sandi harus sama');
    expect(db.collection).not.toHaveBeenCalled();
  });
  test('reset rejects the previous password without consuming the reset token', async () => {
    const previousPassword = 'Aa1!abcd';
    const passwordHash = await hash(previousPassword);
    const users = {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue({
            _id: 'user-1',
            passwordHash,
          }),
        })),
      })),
    };
    const db = {collection: jest.fn(() => users)};
    const passwordResetOtp = {
      peek: jest.fn().mockResolvedValue('user-1'),
      consume: jest.fn(),
    };
    const service = new AuthService(db, {}, passwordResetOtp, {});

    await expect(service.reset({resetToken:'reset-token', newPassword:previousPassword}))
      .rejects.toThrow('Password baru tidak boleh sama dengan password sebelumnya.');
    expect(passwordResetOtp.consume).not.toHaveBeenCalled();
  });
  test('racing duplicate email returns the same actionable conflict message', async () => {
    const db = {collection:() => ({exists:async () => false}), connection:{transaction:async () => {throw {code:11000, keyPattern:{email:1}};}}};
    const service = new AuthService(db, {}, {});
    await expect(service.register(registration('Aa1!abcd'))).rejects.toThrow('Email tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
  });
});
