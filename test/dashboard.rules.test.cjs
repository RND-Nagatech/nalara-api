const {dashboardDayWindow,dashboardPreviewLimit} = require('../dist/modules/dashboard/dashboard.rules');

describe('Teacher dashboard calendar rules', () => {
  test.each([
    ['Asia/Jakarta','2026-10-13T17:00:00.000Z','2026-10-13T17:00:00.000Z','2026-10-14T17:00:00.000Z','2026-10-14'],
    ['Asia/Jakarta','2026-10-14T16:59:59.999Z','2026-10-13T17:00:00.000Z','2026-10-14T17:00:00.000Z','2026-10-14'],
    ['Asia/Jakarta','2026-12-31T18:00:00.000Z','2026-12-31T17:00:00.000Z','2027-01-01T17:00:00.000Z','2027-01-01'],
    ['UTC','2026-10-14T05:00:00.000Z','2026-10-14T00:00:00.000Z','2026-10-15T00:00:00.000Z','2026-10-14'],
    ['America/New_York','2026-03-08T16:00:00.000Z','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z','2026-03-08'],
    ['America/New_York','2026-11-01T17:00:00.000Z','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z','2026-11-01'],
  ])('%s: %s has independent local-midnight boundaries', (zone,now,from,to,localDate) => {
    const result=dashboardDayWindow(new Date(now),zone);
    expect(result.from.toISOString()).toBe(from);
    expect(result.to.toISOString()).toBe(to);
    expect(result.localDate).toBe(localDate);
  });
  test('only the preview is limited to three', () => {
    expect(dashboardPreviewLimit).toBe(3);
  });
});
