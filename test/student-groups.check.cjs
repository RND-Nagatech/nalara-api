// Source-only contracts; no server, database connection or generated dist.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
require('reflect-metadata');
const {ValidationPipe} = require('@nestjs/common');
const {source} = require('./helpers/source.cjs');
const {StudentGroupsService} = source('modules/student-groups/student-groups.service.ts', {
  '../../database/database.module': {Database: class {}},
});
const dto = source('modules/student-groups/student-groups.dto.ts');
const actor = {_id: 'teacher-a', workspaceId: 'workspace-a', role: 'teacher'};
const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

function setup() {
  const data = {studentGroups: [], students: [
    {_id: ids[0], workspaceId: actor.workspaceId, name: 'Alya', grade: 'Kelas 4', status: 'active', notes: 'private', avatarId: 'student_girl_01'},
    {_id: ids[1], workspaceId: actor.workspaceId, name: 'Robby', status: 'active'},
    {_id: ids[2], workspaceId: actor.workspaceId, name: 'Arsip', status: 'archived'},
    {_id: ids[3], workspaceId: 'workspace-b', name: 'Other', status: 'active'},
  ], schedules: [{_id: 'old-schedule', studentIds: [ids[0]]}]};
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if (value.$in) return value.$in.includes(row[key]);
      if (value.$regex !== undefined) return new RegExp(value.$regex, value.$options).test(row[key]);
    }
    return row[key] === value;
  });
  const db = {collection(name) {
    const rows = data[name];
    const query = resolve => {
      let sort, skip = 0, limit = Infinity;
      const result = {
        select: () => result,
        sort: value => {sort = value; return result;},
        skip: value => {skip = value; return result;},
        limit: value => {limit = value; return result;},
        lean: async () => {
          let value = resolve();
          if (Array.isArray(value)) {
            if (sort) value = [...value].sort((a, b) => {
              for (const [key, direction] of Object.entries(sort)) {
                if (a[key] < b[key]) return -direction;
                if (a[key] > b[key]) return direction;
              }
              return 0;
            });
            value = value.slice(skip, skip + limit);
          }
          return structuredClone(value);
        },
      };
      return result;
    };
    return {
      find: filter => query(() => rows.filter(row => matches(row, filter))),
      findOne: filter => query(() => rows.find(row => matches(row, filter)) ?? null),
      countDocuments: async filter => rows.filter(row => matches(row, filter)).length,
      create: async fields => {
        const row = {_id: randomUUID(), version: 0, createdAt: new Date(), ...structuredClone(fields)};
        rows.push(row); return structuredClone(row);
      },
      findOneAndUpdate: (filter, changes) => query(() => {
        const row = rows.find(row => matches(row, filter));
        if (!row) return null;
        Object.assign(row, structuredClone(changes.$set)); row.version += changes.$inc.version;
        return row;
      }),
      deleteOne: async filter => {
        const index = rows.findIndex(row => matches(row, filter));
        if (index < 0) return {deletedCount: 0};
        rows.splice(index, 1); return {deletedCount: 1};
      },
    };
  }};
  return {data, service: new StudentGroupsService(db)};
}

const pipe = new ValidationPipe({transform: true, whitelist: true, forbidNonWhitelisted: true});
const validate = (metatype, value) => pipe.transform(value, {type: 'body', metatype});

test('DTO rejects empty/duplicate/over-limit/invalid members, ownership injection and stale-version payloads', async () => {
  const valid = {name: '  Kelas 4  ', studentIds: [ids[0]]};
  assert.equal((await validate(dto.StudentGroupDto, valid)).name, 'Kelas 4');
  for (const change of [{name: ' '}, {studentIds: []}, {studentIds: [ids[0], ids[0]]},
    {studentIds: [null]}, {studentIds: ['not-a-uuid']}, {studentIds: Array.from({length: 101}, randomUUID)},
    {workspaceId: 'workspace-b'}, {role: 'teacher'}]) {
    await assert.rejects(validate(dto.StudentGroupDto, {...valid, ...change}));
  }
  for (const version of [undefined, -1, 0.5, null]) {
    await assert.rejects(validate(dto.UpdateStudentGroupDto, {...valid, version}));
    await assert.rejects(validate(dto.StudentGroupVersionDto, {version}));
  }
});

test('groups persist actual members and never expose internal student notes', async () => {
  const {service, data} = setup();
  const group = await service.create(actor, {name: 'Kelas 4', studentIds: ids.slice(0, 2)});
  assert.equal(group.name, 'Kelas 4'); assert.equal(group.version, 0);
  assert.deepEqual(group.studentIds, ids.slice(0, 2));
  assert.equal(group.students[0].avatarId, 'student_girl_01');
  assert.equal(group.students[0].notes, undefined);
  assert.equal(group.workspaceId, actor.workspaceId);
  assert.equal(data.studentGroups.length, 1);
});

test('foreign, missing or archived students cannot become members on create or edit', async () => {
  const {service, data} = setup();
  const group = await service.create(actor, {name: 'Valid', studentIds: [ids[0]]});
  for (const id of [ids[2], ids[3], randomUUID()]) {
    await assert.rejects(service.create(actor, {name: 'Invalid', studentIds: [id]}), /siswa aktif/);
    await assert.rejects(service.update(actor, group._id, {name: 'Invalid', studentIds: [id], version: 0}), /siswa aktif/);
  }
  assert.equal(data.studentGroups.length, 1); assert.equal(data.studentGroups[0].name, 'Valid');
});

test('a student can belong to multiple independent groups; edits use a conditional version', async () => {
  const {service, data} = setup();
  const students = structuredClone(data.students);
  const one = await service.create(actor, {name: 'Satu', studentIds: [ids[0]]});
  const two = await service.create(actor, {name: 'Dua', studentIds: [ids[0], ids[1]]});
  const updated = await service.update(actor, one._id, {name: 'Baru', studentIds: [ids[1]], version: 0});
  assert.equal(updated.version, 1);
  await assert.rejects(service.update(actor, one._id, {name: 'Stale', studentIds: [ids[0]], version: 0}), /sudah berubah/);
  assert.deepEqual((await service.get(actor, two._id)).studentIds, [ids[0], ids[1]]);
  assert.deepEqual(data.students, students);
});

test('list search is escaped, tenant scoped and paginated; member changes are resolved on next read', async () => {
  const {service, data} = setup();
  await service.create(actor, {name: 'Kelas [4]', studentIds: [ids[0]]});
  await service.create(actor, {name: 'Kelas 5', studentIds: [ids[1]]});
  await service.create({...actor, workspaceId: 'workspace-b'}, {name: 'Kelas [4]', studentIds: [ids[3]]});
  const found = await service.list(actor, {page: 1, limit: 1, search: '[4]'});
  assert.equal(found.total, 1); assert.equal(found.items[0].name, 'Kelas [4]');
  const next = await service.list(actor, {page: 2, limit: 1});
  assert.equal(next.total, 2); assert.equal(next.items.length, 1);
  data.students[0].status = 'archived';
  assert.equal((await service.get(actor, found.items[0]._id)).students[0].status, 'archived');
});

test('read/update/delete cannot cross tenants; stale delete leaves schedules and members untouched', async () => {
  const {service, data} = setup();
  const group = await service.create(actor, {name: 'Grup', studentIds: [ids[0]]});
  const other = {...actor, workspaceId: 'workspace-b'};
  await assert.rejects(service.get(other, group._id), /tidak ditemukan/);
  await assert.rejects(service.update(other, group._id, {name: 'Wrong', studentIds: [ids[3]], version: 0}), /tidak ditemukan/);
  await assert.rejects(service.remove(other, group._id, 0), /tidak ditemukan/);
  await assert.rejects(service.remove(actor, group._id, 1), /sudah berubah/);
  const students = structuredClone(data.students), schedules = structuredClone(data.schedules);
  assert.deepEqual(await service.remove(actor, group._id, 0), {deleted: true});
  assert.deepEqual(data.studentGroups, []);
  assert.deepEqual(data.students, students); assert.deepEqual(data.schedules, schedules);
});

test('group routes use the existing teacher guard and never opt into public/portal access', () => {
  const {StudentGroupsController} = source('modules/student-groups/student-groups.module.ts', {
    '../../common/api': {Actor: () => () => {}, IdPipe: class {}},
    '../../common/query.dto': source('common/query.dto.ts'),
    './student-groups.dto': dto,
    './student-groups.service': {StudentGroupsService},
  });
  assert.equal(Reflect.getMetadata('path', StudentGroupsController), 'student-groups');
  assert.equal(Reflect.getMetadata('public', StudentGroupsController), undefined);
  for (const method of ['list', 'get', 'create', 'update', 'remove']) {
    assert.equal(Reflect.getMetadata('public', StudentGroupsController.prototype[method]), undefined);
  }
});
