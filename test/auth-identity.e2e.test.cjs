const {randomUUID} = require('node:crypto');
const databaseName = `nalara_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27018/${databaseName}?replicaSet=rs0`;
process.env.CORS_ORIGINS = 'http://localhost:8080';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
const {createApplication} = require('../dist/main');
const {Database} = require('../dist/database/database.module');
let app, db, base, teacher;
const password = 'StrongPassword123!';
async function post(path, body) {
  if (path === 'register') body = {passwordConfirmation:body.password, ...body};
  const response = await fetch(`${base}/api/v1/auth/${path}`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  return {status:response.status, ...await response.json()};
}
beforeAll(async () => {
  app = await createApplication();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  db = app.get(Database);
  const result = await post('register', {name:'Guru Phone', email:'phone@example.test', phone:'081234567890', password});
  expect(result.status).toBe(201);
  teacher = result.data.user;
});
afterAll(async () => {
  if (db && db.connection.name === databaseName) await db.connection.dropDatabase();
  if (app) await app.close();
});
describe('Phone login with real Mongo uniqueness and legacy accounts', () => {
  test('same account authenticates by email and every accepted phone format', async () => {
    for (const identity of [{email:'PHONE@EXAMPLE.TEST'}, {phone:'081234567890'}, {phone:'6281234567890'}, {phone:'+62 (812) 3456-7890'}]) {
      const result = await post('login', {...identity, password});
      expect(result.status).toBe(200);
      expect(result.data.user._id).toBe(teacher._id);
      expect(result.data.user.phone).toBe('+6281234567890');
      expect(result.data.user.passwordHash).toBeUndefined();
    }
  });
  test('duplicate email or equivalent phone cannot create another workspace', async () => {
    const before = await db.collection('workspaces').countDocuments();
    const emailDuplicate = await post('register', {name:'Duplicate', email:'phone@example.test', phone:'081234567891', password});
    expect(emailDuplicate.status).toBe(409);
    expect(emailDuplicate.error.message).toBe('Email tersebut sudah terdaftar. Silakan login atau ganti kata sandi.');
    expect((await post('register', {name:'Duplicate', email:'duplicate@example.test', phone:'+62 812-3456-7890', password})).status).toBe(409);
    expect(await db.collection('workspaces').countDocuments()).toBe(before);
  });
  test('new registrations reject missing or malformed phones', async () => {
    expect((await post('register', {name:'Missing', email:'missing@example.test', password})).status).toBe(400);
    expect((await post('register', {name:'Malformed', email:'malformed@example.test', phone:{$ne:null}, password})).status).toBe(400);
  });
  test('wrong password and unknown phone return clear backend messages', async () => {
    const wrong = await post('login', {phone:'081234567890', password:'WrongPassword123!'});
    const unknown = await post('login', {phone:'081234567899', password});
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.error.message).toBe('Nomor HP atau kata sandi salah. Silakan cek kembali atau gunakan Lupa kata sandi.');
    expect(unknown.error.message).toBe('Nomor HP atau kata sandi salah. Silakan cek kembali atau gunakan Lupa kata sandi.');
  });
  test('ambiguous identity or unregistered email never issues a session', async () => {
    const before = await db.collection('authSessions').countDocuments();
    expect((await post('login', {email:'phone@example.test', phone:'081234567890', password})).status).toBe(400);
    const missing = await post('login', {email:'unregistered@example.test', password});
    expect(missing.status).toBe(401);
    expect(missing.error.message).toBe('Email atau kata sandi salah. Silakan cek kembali atau gunakan Lupa kata sandi.');
    expect(await db.collection('authSessions').countDocuments()).toBe(before);
  });
  test('multiple legacy users without phone remain valid email accounts', async () => {
    const source = await db.collection('users').findById(teacher._id).select('+passwordHash').lean();
    for (const email of ['legacy-one@example.test', 'legacy-two@example.test']) {
      const record = await db.collection('users').create({name:'Legacy Guru', email, passwordHash:source.passwordHash, workspaceId:teacher.workspaceId});
      const result = await post('login', {email, password});
      expect(result.status).toBe(200);
      expect(result.data.user._id).toBe(record._id);
      expect(result.data.user.phone).toBeUndefined();
    }
  });
  test('concurrent registration with one phone commits only one workspace', async () => {
    const before = await db.collection('workspaces').countDocuments();
    const results = await Promise.all(['a', 'b'].map(suffix => post('register', {name:'Concurrent Guru', email:`concurrent-${suffix}@example.test`, phone:'081234567893', password})));
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(await db.collection('workspaces').countDocuments()).toBe(before + 1);
    expect(await db.collection('users').countDocuments({phone:'+6281234567893'})).toBe(1);
  });
});
