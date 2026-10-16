const {studentSummaryWindow}=require('../dist/modules/students/student-summary.rules');
const {progressFromTotals,aggregateProgress}=require('../dist/modules/learning-plans/progress.rules');
describe('Student summary calendar and canonical rounding',()=>{
  test('WIB week is Monday through next Monday, with seven actual daily samples',()=>{
    const now=new Date('2026-10-15T05:00:00Z');
    const value=studentSummaryWindow(now,'Asia/Jakarta');
    expect(value.weekStart.toISOString()).toBe('2026-10-11T17:00:00.000Z');
    expect(value.weekEnd.toISOString()).toBe('2026-10-18T17:00:00.000Z');
    expect(value.weekStartDate).toBe('2026-10-12');
    expect(value.weekEndDate).toBe('2026-10-18');
    expect(value.days).toHaveLength(7);
    expect(value.days[0].date).toBe('2026-10-09');
    expect(value.days[6]).toEqual({date:'2026-10-15',at:now});
  });
  test('DST and year boundaries use independent local midnights',()=>{
    const spring=studentSummaryWindow(new Date('2026-03-08T16:00:00Z'),'America/New_York');
    expect(spring.weekStart.toISOString()).toBe('2026-03-02T05:00:00.000Z');
    expect(spring.weekEnd.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    const year=studentSummaryWindow(new Date('2026-12-31T18:00:00Z'),'Asia/Jakarta');
    expect(year.weekStartDate).toBe('2026-12-28');
    expect(year.weekEndDate).toBe('2027-01-03');
  });
  test('canonical null, zero and half rounding do not drift from plans',()=>{
    expect(progressFromTotals(0,0)).toBeNull();
    expect(progressFromTotals(0,2)).toBe(0);
    expect(progressFromTotals(1,2)).toBe(1);
    expect(aggregateProgress([{status:'completed',progress:12},{status:'active',progress:20},{status:'archived',progress:90}])).toEqual({targetCount:2,progress:60});
  });
});
