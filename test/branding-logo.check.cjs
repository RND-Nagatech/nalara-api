// Source-only contracts and disposable file fixtures, no application or live DB.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, writeFile, symlink} = require('node:fs/promises');
const {join, dirname, resolve} = require('node:path');
const {tmpdir} = require('node:os');
const sharp = require('sharp');
require('reflect-metadata');
const {SetMetadata, ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {memoryDb} = require('./helpers/memory-db.cjs');
const storageModule = source('storage/logo-storage.service.ts');
const {LogoStorage, MAX_LOGO_BYTES} = storageModule;
const logoModule = source('modules/tutor-tools/branding-logo.service.ts', {
  '../../database/database.module': {Database: class {}}, '../../storage/logo-storage.service': storageModule,
});
const {BrandingLogoService, normalizeLogo} = logoModule;
const dto = source('modules/tutor-tools/tutor-tools.dto.ts');
const pdf = source('modules/tutor-tools/report-pdf.ts');
const {fixture} = require('../scripts/preview-report-pdf.cjs');
const {TutorToolsService} = source('modules/tutor-tools/tutor-tools.service.ts', {
  '../../common/scoped.service': {ScopedService: class {}}, '../../common/query.dto': {},
  '../learning-plans/progress.rules': {}, './tutor-tools.dto': dto,
  './branding-logo.service': logoModule, './report-pdf': pdf,
});
const actor = {_id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', name: 'Nadia', timezone: 'Asia/Jakarta'};
const other = '33333333-3333-4333-8333-333333333333';
const key = '44444444-4444-4444-8444-444444444444';
async function image(format = 'png', width = 40, height = 30) {
  return sharp({create: {width, height, channels: 4, background: {r: 20, g: 90, b: 65, alpha: 0.6}}})[format]().toBuffer();
}
const upload = (buffer, mimetype = 'image/png') => ({buffer, size: buffer.length, mimetype, originalname: '../../never-used.png'});
function setup(extra = {}) {
  const data = {workspaces: [{_id: actor.workspaceId, ownerId: actor._id}], tutorPreferences: [], ...extra};
  const db = memoryDb(data);
  const storage = {files: new Map(), removed: [],
    async write(workspaceId, bytes) {assert.equal(workspaceId, actor.workspaceId); this.files.set(key, bytes); return key;},
    async read(workspaceId, id) {assert.equal(workspaceId, actor.workspaceId); if (!this.files.has(id)) throw new Error('absent'); return this.files.get(id);},
    async remove(workspaceId, id) {this.removed.push({workspaceId, id}); this.files.delete(id);},
  };
  const service = new BrandingLogoService(db, storage);
  service.logger = {warn() {}};
  return {db, data, storage, service};
}

test('PNG and JPEG are decoded, bounded and re-encoded to static PNG without metadata', async () => {
  for (const format of ['png', 'jpeg']) {
    const bytes = await image(format, 900, 500);
    const normalized = await normalizeLogo(upload(bytes, `image/${format}`));
    const meta = await sharp(normalized).metadata();
    assert.equal(meta.format, 'png'); assert.ok(meta.width <= 512 && meta.height <= 512);
    assert.equal(meta.exif, undefined); assert.ok(normalized.length < MAX_LOGO_BYTES);
  }
});

test('missing, oversized, forged MIME, SVG, damaged and decompression-heavy files are rejected', async () => {
  const png = await image();
  const oversized = Buffer.alloc(MAX_LOGO_BYTES + 1);
  const huge = await image('png', 4096, 2048);
  for (const file of [undefined, upload(Buffer.alloc(0)), upload(oversized), upload(png, 'image/jpeg'),
    upload(Buffer.from('<svg><script>bad()</script></svg>')), upload(png.subarray(0, 12)), upload(huge), {...upload(png), size: 1}]) {
    await assert.rejects(normalizeLogo(file), error => error.getStatus() === 400);
  }
});

test('upload ignores original filename, scopes metadata and reads only the current workspace logo', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: other, logoKey: 'other-secret'}]});
  const result = await ctx.service.upload(actor, upload(await image()));
  assert.equal(result.logo.version, key); assert.equal(result.logo.mimeType, 'image/png');
  assert.equal(ctx.data.tutorPreferences[0].logoKey, 'other-secret');
  assert.equal(ctx.data.tutorPreferences[1].workspaceId, actor.workspaceId);
  assert.equal((await ctx.service.current(actor)).logo.version, key);
  assert.equal(ctx.data.workspaces[0].scheduleVersion, 1);
});

test('owner/deletion lock rejects late uploads and cleans the new private file', async () => {
  for (const changed of [{ownerId: 'another-teacher'}, {deletionRequestedAt: new Date()}]) {
    const ctx = setup(); Object.assign(ctx.data.workspaces[0], changed);
    await assert.rejects(ctx.service.upload(actor, upload(await image())), error => error.getStatus() === 403);
    assert.equal(ctx.data.tutorPreferences.length, 0); assert.equal(ctx.storage.files.size, 0);
    assert.deepEqual(ctx.storage.removed, [{workspaceId: actor.workspaceId, id: key}]);
  }
});

test('file storage failure never replaces existing metadata', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: actor.workspaceId, logoKey: 'previous'}]});
  ctx.storage.write = async () => {throw new Error('disk full');};
  await assert.rejects(ctx.service.upload(actor, upload(await image())), error => error.getStatus() === 503);
  assert.equal(ctx.data.tutorPreferences[0].logoKey, 'previous');
});

test('database attachment failure removes the new file and preserves existing logo', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: actor.workspaceId, logoKey: 'previous'}]});
  ctx.db.connection.transaction = async () => {throw new Error('database unavailable');};
  await assert.rejects(ctx.service.upload(actor, upload(await image())), /database unavailable/);
  assert.equal(ctx.data.tutorPreferences[0].logoKey, 'previous'); assert.equal(ctx.storage.files.size, 0);
});

test('replacement deletes only the prior scoped file; removal is idempotent', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: actor.workspaceId, logoKey: 'previous', displayName: 'Tutor'}, {workspaceId: other, logoKey: 'other-file'}]});
  await ctx.service.upload(actor, upload(await image()));
  assert.deepEqual(ctx.storage.removed, [{workspaceId: actor.workspaceId, id: 'previous'}]);
  await ctx.service.remove(actor); await ctx.service.remove(actor);
  assert.equal(ctx.data.tutorPreferences[0].logoKey, undefined);
  assert.equal(ctx.data.tutorPreferences[0].displayName, 'Tutor');
  assert.equal(ctx.data.tutorPreferences[1].logoKey, 'other-file');
  assert.deepEqual(await ctx.service.current(actor), {logo: null});
});

test('missing stored logo is an explicit error, never a fabricated empty preview', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: actor.workspaceId, logoKey: key}]});
  await assert.rejects(ctx.service.current(actor), error => error.getStatus() === 503);
});

test('preferences do not expose a private file key and text edits preserve the current logo', async () => {
  const ctx = setup({tutorPreferences: [{workspaceId: actor.workspaceId, logoKey: key, displayName: 'Tutor'}]});
  const tools = new TutorToolsService({db: ctx.db}, ctx.service);
  assert.equal((await tools.preferences(actor)).logoKey, undefined);
  assert.equal((await tools.preferences(actor)).logoVersion, key);
  await tools.savePreferences(actor, {displayName: 'Nama baru', tagline: '', footer: '', accentColor: '#155D49'});
  assert.equal(ctx.data.tutorPreferences[0].logoKey, key);
  const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
  await assert.rejects(pipe.transform({displayName: 'Tutor', tagline: '', footer: '', accentColor: '#155D49', logoKey: '../other'}, {type: 'body', metatype: dto.BrandingDto}));
});

test('private storage is tenant-isolated, rejects traversal and erases only its own generated files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nalara-logo-test-'));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, {recursive: true, force: true}));
  const storage = new LogoStorage({get: () => root});
  const bytes = await image();
  const ownKey = await storage.write(actor.workspaceId, bytes);
  const otherKey = await storage.write(other, bytes);
  assert.deepEqual(await storage.read(actor.workspaceId, ownKey), bytes);
  await assert.rejects(storage.read(actor.workspaceId, '../other'));
  await assert.rejects(storage.write('../outside', bytes));
  assert.equal(await storage.purgeWorkspace(actor.workspaceId), true);
  assert.deepEqual(await storage.read(other, otherKey), bytes);
  assert.equal(await storage.purgeWorkspace(actor.workspaceId), true);
});

test('private reads/purge fail closed on a symlink instead of following it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nalara-logo-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const storage = new LogoStorage({get: () => root});
  const ownKey = await storage.write(actor.workspaceId, await image());
  await storage.remove(actor.workspaceId, ownKey);
  const external = join(root, 'not-a-logo.txt'); await writeFile(external, 'private test content');
  await symlink(external, join(root, 'branding', actor.workspaceId, `${ownKey}.png`));
  await assert.rejects(storage.read(actor.workspaceId, ownKey));
  await assert.rejects(storage.purgeWorkspace(actor.workspaceId), /Unexpected entry/);
});

test('all logo endpoints stay authenticated, no-store and gated by existing branding entitlement', () => {
  const {TutorToolsController} = source('modules/tutor-tools/tutor-tools.module.ts', {
    '../../common/api': {Actor: () => () => {}, IdPipe: class {}, Public: () => () => {}}, '../../common/query.dto': {},
    '../invitations/invitations.module': {InvitationsModule: class {}}, '../invitations/portal.guard': {PortalAuthGuard: class {}},
    '../notifications/notifications.module': {NotificationsModule: class {}},
    '../subscriptions/subscriptions.guard': {RequireFeature: feature => SetMetadata('subscriptionFeature', feature)},
    './tutor-tools.dto': dto, './tutor-tools.service': {TutorToolsService}, './assignments.service': {AssignmentsService: class {}},
    './branding-logo.service': logoModule, '../../storage/logo-storage.service': storageModule,
  });
  assert.equal(Reflect.getMetadata('public', TutorToolsController), undefined);
  for (const name of ['logo', 'uploadLogo', 'removeLogo']) {
    const handler = TutorToolsController.prototype[name];
    assert.equal(Reflect.getMetadata('path', handler), 'branding/logo');
    assert.equal(Reflect.getMetadata('subscriptionFeature', handler), 'branding');
    assert.equal(Reflect.getMetadata('public', handler), undefined);
    assert.ok(Reflect.getMetadata('__headers__', handler).some(header => header.name === 'Cache-Control' && header.value === 'no-store'));
  }
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', TutorToolsController.prototype.uploadLogo), 10);
});

test('PDF renderer embeds logo/fonts and fits ordinary report into one A4 page', async () => {
  const data = fixture(); data.logo = await image();
  const bytes = await pdf.renderReportPdf(data);
  const raw = bytes.toString('latin1');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(raw, /\/Subtype \/Image/); assert.match(raw, /\/FontFile2/);
  assert.equal((raw.match(/\/Type \/Page\b/g) ?? []).length, 1);
});

test('long internal draft paginates without a logo and preserves the export envelope', async () => {
  const ctx = setup(); const data = fixture();
  data.report = {...data.report, _id: key, sessionId: 'session', studentId: 'student', status: 'draft', visibility: 'teacher', summary: 'Catatan panjang. '.repeat(600)};
  data.lesson.subjectId = 'subject'; data.lesson.scheduleId = 'schedule';
  const records = {reports: data.report, sessions: data.lesson, students: data.student, subjects: data.subject, schedules: {timezone: 'Asia/Makassar'}};
  const calls = [];
  const tools = new TutorToolsService({db: ctx.db, async get(name, id, who) {assert.equal(who, actor); calls.push({name, id}); return records[name];}}, ctx.service);
  tools.preferences = async () => data.branding;
  const result = await tools.pdf(actor, key);
  assert.equal(result.filename, `nalara-laporan-${key}.pdf`); assert.equal(result.mimeType, 'application/pdf');
  assert.ok((Buffer.from(result.contentBase64, 'base64').toString('latin1').match(/\/Type \/Page\b/g) ?? []).length > 1);
  assert.deepEqual(calls.map(call => call.name).sort(), ['reports', 'schedules', 'sessions', 'students', 'subjects']);
});
