// src/lib/util/date-helpers.ts

/**
 * Convert a date to Eastern Time
 */
export function toEST(date: string | Date): Date {
    const d = typeof date === 'string' ? new Date(date) : date;
    return new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  }
  
  /**
   * Format a date for display in Eastern Time
   */
  export function formatESTTime(isoTime: string): string {
    const date = toEST(isoTime);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York'
    });
  }
  
  /**
   * Get start and end of day in EST
   */
  export function getESTDayRange(date: string): { start: string; end: string } {
    const estDate = toEST(date);
    const startOfDay = new Date(estDate);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(estDate);
    endOfDay.setHours(23, 59, 59, 999);
  
    return {
      start: startOfDay.toISOString(),
      end: endOfDay.toISOString()
    };
  }
  
  /**
   * Compare two dates ignoring time
   */
  export function isSameESTDay(date1: string | Date, date2: string | Date): boolean {
    const d1 = toEST(date1);
    const d2 = toEST(date2);
    
    return d1.getFullYear() === d2.getFullYear() &&
            d1.getMonth() === d2.getMonth() &&
            d1.getDate() === d2.getDate();
  }
  
  /**
   * Format a date range for display
   */
  export function formatDateRange(startTime: string, endTime: string): string {
    return `${formatESTTime(startTime)} - ${formatESTTime(endTime)}`;
  }
  
  /**
   * Get a user-friendly date string in EST
   */
  export function getDisplayDate(date: string): string {
    const estDate = toEST(date);
    return estDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York'
    });
  }