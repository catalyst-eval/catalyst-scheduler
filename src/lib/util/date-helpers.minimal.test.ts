// src/lib/util/date-helpers.minimal.test.ts
// Import individual functions to avoid TypeScript transpilation errors
import { getESTDayRange, isValidISODate } from './date-helpers';

describe('Minimal Date Helper Tests', () => {
  
  test('getESTDayRange returns object with start and end', () => {
    const result = getESTDayRange('2025-03-01');
    expect(result).toBeDefined();
    expect(typeof result.start).toBe('string');
    expect(typeof result.end).toBe('string');
  });

  test('isValidISODate validates strings correctly', () => {
    expect(isValidISODate('2025-03-01')).toBeTruthy();
    expect(isValidISODate('invalid-date')).toBeFalsy();
  });
  
});