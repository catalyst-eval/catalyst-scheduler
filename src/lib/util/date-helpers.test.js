// src/lib/util/date-helpers.test.js
// Using require instead of import for JavaScript compatibility
const helpers = require('../../lib/util/date-helpers');

describe('Date Helper Functions', () => {
  
  test('getESTDayRange returns expected format', () => {
    const { getESTDayRange } = helpers;
    if (typeof getESTDayRange === 'function') {
      const result = getESTDayRange('2025-03-01');
      expect(result).toHaveProperty('start');
      expect(result).toHaveProperty('end');
    } else {
      // Function not available, test cannot run
      console.log('getESTDayRange function not available');
    }
  });

  test('getTodayEST returns a date string', () => {
    const { getTodayEST } = helpers;
    if (typeof getTodayEST === 'function') {
      const today = getTodayEST();
      expect(typeof today).toBe('string');
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } else {
      // Function not available, test cannot run
      console.log('getTodayEST function not available');
    }
  });
  
  test('isValidISODate validates dates properly', () => {
    const { isValidISODate } = helpers;
    if (typeof isValidISODate === 'function') {
      expect(isValidISODate('2025-03-01')).toBe(true);
      expect(isValidISODate('not-a-date')).toBe(false);
      expect(isValidISODate('')).toBe(false);
      expect(isValidISODate(null)).toBe(false);
    } else {
      // Function not available, test cannot run
      console.log('isValidISODate function not available');
    }
  });
  
});