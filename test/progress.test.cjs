const {aggregateProgress} = require('../dist/modules/learning-plans/progress.rules');
const {validateRange,nextWeekly} = require('../dist/modules/schedules/schedules.service');
test('empty and excluded targets have no aggregate',()=>{
  expect(aggregateProgress([])).toEqual({targetCount:0,progress:null});
  expect(aggregateProgress([{status:'archived',progress:90},{status:'cancelled',progress:20}]).progress).toBeNull();
});
test('equal weight and completed=100',()=>expect(aggregateProgress([{status:'active',progress:20},{status:'active',progress:60},{status:'completed',progress:10},{status:'archived',progress:99}])).toEqual({targetCount:3,progress:60}));
test('invalid duration is rejected',()=>expect(()=>validateRange(new Date('2026-10-13T09:00Z'),new Date('2026-10-13T08:00Z'))).toThrow());
test('weekly recurrence preserves wall time across DST',()=>expect(nextWeekly(new Date('2026-10-25T08:00Z'),'America/New_York',1).toISOString()).toBe('2026-11-01T09:00:00.000Z'));
