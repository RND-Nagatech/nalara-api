// Small deterministic Mongo contract fake, not a replacement for database E2E.
const {randomUUID} = require('node:crypto');
const clone = value => value == null ? value : structuredClone(value);
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(row, part));
    if (key === '$and') return expected.every(part => matches(row, part));
    const value = row[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, other]) => {
        if (op === '$exists') return (value !== undefined) === other;
        if (op === '$in') return other.includes(value);
        if (op === '$nin') return !other.includes(value);
        if (op === '$ne') return value !== other;
        if (op === '$lt') return value < other;
        if (op === '$lte') return value <= other;
        if (op === '$gt') return value > other;
        if (op === '$gte') return value >= other;
        if (op === '$regex') return new RegExp(other).test(value);
        throw new Error(`Unsupported fake operator ${op}`);
      });
    }
    return value === expected;
  });
}
function update(row, changes, inserted = false) {
  Object.assign(row, clone(changes.$set ?? {}), inserted ? clone(changes.$setOnInsert ?? {}) : {});
  for (const key of Object.keys(changes.$unset ?? {})) delete row[key];
  for (const [key, value] of Object.entries(changes.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
  for (const [key, value] of Object.entries(changes.$addToSet ?? {})) row[key] = [...new Set([...(row[key] ?? []), ...(value.$each ?? [value])])];
}
function memoryDb(data) {
  const query = resolve => {
    let sorting, maximum;
    const result = {
      select() {return result;}, session() {return result;},
      sort(value) {sorting = value; return result;}, limit(value) {maximum = value; return result;},
      async lean() {
        let rows = await resolve();
        if (Array.isArray(rows)) {
          if (sorting) rows = [...rows].sort((a, b) => {for (const [key, direction] of Object.entries(sorting)) {if (a[key] < b[key]) return -direction; if (a[key] > b[key]) return direction;} return 0;});
          if (maximum) rows = rows.slice(0, maximum);
        }
        return clone(rows);
      },
    };
    return result;
  };
  return {data, connection: {transaction: async fn => fn({})}, collection(name) {
    const rows = data[name] ??= [];
    return {
      find: filter => query(() => rows.filter(row => matches(row, filter))),
      findOne: filter => query(() => rows.find(row => matches(row, filter)) ?? null),
      exists: async filter => rows.some(row => matches(row, filter)),
      findOneAndUpdate: (filter, changes, options = {}) => query(() => {
        let row = rows.find(item => matches(item, filter));
        let inserted = false;
        if (!row && options.upsert) {row = {_id: randomUUID(), ...clone(filter)}; rows.push(row); inserted = true;}
        if (!row) return null;
        update(row, changes, inserted); return row;
      }),
      async updateOne(filter, changes) {const row = rows.find(item => matches(item, filter)); if (row) update(row, changes); return {matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0};},
      async updateMany(filter, changes) {const found = rows.filter(row => matches(row, filter)); for (const row of found) update(row, changes); return {modifiedCount: found.length};},
      async deleteMany(filter) {for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], filter)) rows.splice(index, 1);},
      async create(value) {const add = item => {const row = {_id: randomUUID(), ...clone(item)}; rows.push(row); return {toObject: () => clone(row)};}; return Array.isArray(value) ? value.map(add) : add(value);},
    };
  }};
}
module.exports = {memoryDb, matches};
