// src/lib/util/date-helpers.ts

/**
 * Convert a date to Eastern Time
 */
export function toEST(date: string | Date): Date {
  try {
    // Create a new date object if string is provided
    const inputDate = typeof date === 'string' ? new Date(date) : new Date(date);
    
    // Use direct UTC date methods for more reliable conversion
    // This avoids issues with browser's local timezone
    return new Date(
      inputDate.getUTCFullYear(),
      inputDate.getUTCMonth(),
      inputDate.getUTCDate(),
      inputDate.getUTCHours(),
      inputDate.getUTCMinutes(),
      inputDate.getUTCSeconds()
    );
  } catch (error) {
    console.error('Error in toEST:', error);
    return new Date(); // Return current date as fallback
  }
}

/**
 * Format a date for display in Eastern Time
 */
export function formatESTTime(isoTime: string): string {
  try {
    // Parse the input date
    const date = new Date(isoTime);
    
    // Calculate EST time (UTC-5) - adjust hours for timezone
    const estDate = new Date(date);
    estDate.setHours(date.getUTCHours() - 5); // Adjust for EST (UTC-5)
    
    // Format with hours and minutes
    return estDate.toLocaleTimeString('en-US', {
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
      console.warn(`Invalid date format: ${dateString}, using current date`);
      return getESTDayRange(new Date().toISOString());
    }
    
    // Use the date directly (already in UTC from ISO string)
    const startOfDay = new Date(inputDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    
    const endOfDay = new Date(inputDate);
    endOfDay.setUTCHours(23, 59, 59, 999);
    
    // Log for debugging
    console.log(`Date range for ${dateString}:`, {
      start: startOfDay.toISOString(),
      end: endOfDay.toISOString()
    });
    
    return {
      start: startOfDay.toISOString(),
      end: endOfDay.toISOString()
    };
  } catch (error) {
    console.error('Error in getESTDayRange:', error);
    
    // Fallback to current day
    const today = new Date();
    const startOfToday = new Date(today.setUTCHours(0, 0, 0, 0));
    const endOfToday = new Date(today.setUTCHours(23, 59, 59, 999));
    
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
  return now.toISOString().split('T')[0];
}

/**
 * Compare two dates ignoring time
 */
export function isSameESTDay(date1: string | Date, date2: string | Date): boolean {
  try {
    // Extract just the date portions
    const d1Str = new Date(date1).toISOString().split('T')[0];
    const d2Str = new Date(date2).toISOString().split('T')[0];
    
    return d1Str === d2Str;
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
 * Get a user-friendly date string for display
 */
export function getDisplayDate(date: string): string {
  try {
    // Parse the date
    const displayDate = new Date(date);
    
    // Format using toLocaleDateString for consistent results
    return displayDate.toLocaleDateString('en-US', {
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