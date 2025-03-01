// src/lib/util/date-helpers.ts

/**
 * Convert a date to Eastern Time
 */
export function toEST(date: string | Date): Date {
    const d = typeof date === 'string' ? new Date(date) : date;
    
    // Use the Intl.DateTimeFormat for more reliable timezone conversion
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });
    
    const parts = formatter.formatToParts(d);
    const dateObj: Record<string, number> = {};
    
    parts.forEach(part => {
      if (part.type !== 'literal') {
        dateObj[part.type] = parseInt(part.value, 10);
      }
    });
    
    // Create a new date with the components in Eastern Time
    return new Date(
      dateObj.year,
      dateObj.month - 1, // JavaScript months are 0-indexed
      dateObj.day,
      dateObj.hour,
      dateObj.minute,
      dateObj.second
    );
  }
  
  /**
   * Format a date for display in Eastern Time
   */
  export function formatESTTime(isoTime: string): string {
    try {
      const date = toEST(isoTime);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch (error) {
      console.error('Error formatting EST time:', error);
      return 'Invalid Time';
    }
  }
  
  /**
   * Get start and end of day in EST for a given date string
   */
  export function getESTDayRange(dateString: string): { start: string; end: string } {
    try {
      // Parse the input date
      const inputDate = new Date(dateString);
      if (isNaN(inputDate.getTime())) {
        throw new Error(`Invalid date format: ${dateString}`);
      }
      
      // Convert to Eastern Time
      const estDate = toEST(inputDate);
      
      // Create start of day in EST
      const startOfDay = new Date(estDate);
      startOfDay.setHours(0, 0, 0, 0);
      
      // Create end of day in EST
      const endOfDay = new Date(estDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      // Convert back to ISO strings
      return {
        start: startOfDay.toISOString(),
        end: endOfDay.toISOString()
      };
    } catch (error) {
      console.error('Error in getESTDayRange:', error);
      // Fallback to current day if there's an error
      const today = new Date();
      const startOfToday = new Date(today);
      startOfToday.setHours(0, 0, 0, 0);
      
      const endOfToday = new Date(today);
      endOfToday.setHours(23, 59, 59, 999);
      
      return {
        start: startOfToday.toISOString(),
        end: endOfToday.toISOString()
      };
    }
  }
  
  /**
   * Get today's date in EST as YYYY-MM-DD
   */
  export function getTodayEST(): string {
    const now = new Date();
    const estDate = toEST(now);
    
    const year = estDate.getFullYear();
    const month = String(estDate.getMonth() + 1).padStart(2, '0');
    const day = String(estDate.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }
  
  /**
   * Compare two dates ignoring time
   */
  export function isSameESTDay(date1: string | Date, date2: string | Date): boolean {
    try {
      const d1 = toEST(date1);
      const d2 = toEST(date2);
      
      return d1.getFullYear() === d2.getFullYear() &&
              d1.getMonth() === d2.getMonth() &&
              d1.getDate() === d2.getDate();
    } catch (error) {
      console.error('Error in isSameESTDay:', error);
      return false;
    }
  }
  
  /**
   * Format a date range for display
   */
  export function formatDateRange(startTime: string, endTime: string): string {
    try {
      return `${formatESTTime(startTime)} - ${formatESTTime(endTime)}`;
    } catch (error) {
      console.error('Error formatting date range:', error);
      return 'Invalid Time Range';
    }
  }
  
  /**
   * Get a user-friendly date string in EST
   */
  export function getDisplayDate(date: string): string {
    try {
      const estDate = toEST(date);
      return estDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (error) {
      console.error('Error in getDisplayDate:', error);
      return 'Invalid Date';
    }
  }
  
  /**
   * Validate if a string is a valid ISO date
   */
  export function isValidISODate(dateString: string | null | undefined): boolean {
    if (!dateString) return false;
    
    try {
      const date = new Date(dateString);
      return !isNaN(date.getTime());
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Parse a date string to ensure it's a valid date
   * Returns a default date if parsing fails
   */
  export function safeParseDateString(dateString: string, defaultDate = new Date()): Date {
    try {
      const date = new Date(dateString);
      return isNaN(date.getTime()) ? defaultDate : date;
    } catch (error) {
      return defaultDate;
    }
  }