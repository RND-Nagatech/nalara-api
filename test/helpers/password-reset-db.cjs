// Deterministic Mongo contract fake. Serial transactions model commit/rollback;
// they do not prove real Mongo write-conflict behavior or TTL scheduling.
const {randomUUID} = require('node:crypto');
const {matches} = require('./memory-db.cjs');
const clone = value => value == null ? value : structuredClone(value);

function passwordResetDb(initial = {}) {
  const data = clone({passwordResetChallenges: [], passwordResetTokens: [], users: [], authSessions: [], ...initial});
  const calls = [];
  let queued = Promise.resolve();
  const db = {data, calls, failure: undefined, failCommit: false};
  const guard = (name, operation, filter, session) => {
    calls.push({name, operation, filter: clone(filter), session});
    if (db.failure?.name === name && db.failure.operation === operation) throw db.failure.error;
  };
  const changes = (row, update) => {
    Object.assign(row, clone(update.$set ?? {}));
    for (const key of Object.keys(update.$unset ?? {})) delete row[key];
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
  };
  const query = (name, operation, filter, resolve) => {
    let session;
    const result = {
      session(value) {session = value; return result;}, select() {return result;},
      async lean() {guard(name, operation, filter, session); return clone(await resolve());},
    };
    return result;
  };
  db.collection = name => {
    const rows = data[name] ??= [];
    return {
      findOne: filter => query(name, 'findOne', filter, () => rows.find(row => matches(row, filter)) ?? null),
      findById: id => query(name, 'findById', {_id: id}, () => rows.find(row => row._id === id) ?? null),
      findOneAndUpdate: (filter, update, options = {}) => query(name, 'findOneAndUpdate', filter, () => {
        let row = rows.find(item => matches(item, filter));
        if (!row && options.upsert) {
          if (rows.some(item => item._id === filter._id)) throw Object.assign(new Error('duplicate'), {code: 11000});
          row = {_id: filter._id ?? randomUUID(), ...clone(update.$setOnInsert ?? {})};
          rows.push(row);
        }
        if (!row) return null;
        changes(row, update);
        return row;
      }),
      findOneAndDelete: filter => query(name, 'findOneAndDelete', filter, () => {
        const index = rows.findIndex(row => matches(row, filter));
        return index < 0 ? null : rows.splice(index, 1)[0];
      }),
      async create(values, options = {}) {
        guard(name, 'create', {}, options.session);
        const entries = (Array.isArray(values) ? values : [values]).map(value => ({_id: randomUUID(), ...clone(value)}));
        if (entries.some(entry => rows.some(row => row._id === entry._id))) throw Object.assign(new Error('duplicate'), {code: 11000});
        rows.push(...entries);
        return entries;
      },
      async updateOne(filter, update, options = {}) {
        guard(name, 'updateOne', filter, options.session);
        const row = rows.find(item => matches(item, filter));
        if (row) changes(row, update);
        return {matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0};
      },
      async deleteMany(filter, options = {}) {
        guard(name, 'deleteMany', filter, options.session);
        for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], filter)) rows.splice(index, 1);
      },
    };
  };
  db.connection = {transaction: callback => {
    const pending = queued.then(async () => {
      const snapshot = clone(data);
      try {
        const result = await callback({id: randomUUID()});
        if (db.failCommit) throw new Error('private database commit failed');
        return result;
      } catch (error) {
        for (const key of Object.keys(data)) data[key].splice(0, data[key].length, ...(snapshot[key] ?? []));
        throw error;
      }
    });
    queued = pending.catch(() => undefined);
    return pending;
  }};
  return db;
}

module.exports = {passwordResetDb};
