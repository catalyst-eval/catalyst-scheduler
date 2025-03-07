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
    const options = { timeZone: 'America/New_York' };
    const estDateStr = inputDate.toLocaleString('en-US', options);
    
    // Parse the formatted date string back to a Date object
    const [datePart, timePart] = estDateStr.split(', ');
    const [month, day, year] = datePart.split('/').map(num => parseInt(num));
    let [hour, minute, second] = [0, 0, 0];
    
    if (timePart) {
      const timeParts = timePart.match(/(\d+):(\d+):?(\d+)?\s*(AM|PM)/i);
      if (timeParts) {
        hour = parseInt(timeParts[1]);
        minute = parseInt(timeParts[2]);
        second = timeParts[3] ? parseInt(timeParts[3]) : 0;
        
        // Adjust for PM
        if (timeParts[4].toUpperCase() === 'PM' && hour < 12) {
          hour += 12;
        }
        // Adjust for AM 12
        else if (timeParts[4].toUpperCase() === 'AM' && hour === 12) {
          hour = 0;
        }
      }
    }
    
    // Create a new date in local time with the EST components
    // Month is 0-indexed in JavaScript Date
    return new Date(year, month - 1, day, hour, minute, second);
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
    
    // Format in eastern time
    const options = { 
      timeZone: 'America/New_York',
      hour: 'numeric' as const, 
      minute: '2-digit' as const,
      hour12: true 
    };
    
    return date.toLocaleTimeString('en-US', options);
  } catch (error) {
    console.error('Error formatting EST time:', error);
    return 'Invalid Time';
  }
}

/**
 * Normalize a date string to ensure consistent format and timezone
 */
export function normalizeDateString(dateString: string): string {
  try {
    // Parse the date and convert to EST
    const estDate = toEST(dateString);
    
    // Format as YYYY-MM-DD
    const year = estDate.getFullYear();
    const month = String(estDate.getMonth() + 1).padStart(2, '0');
    const day = String(estDate.getDate()).padStart(2, '0');
    
    const normalizedDate = `${year}-${month}-${day}`;
    console.log(`Normalized date: ${dateString} -> ${normalizedDate}`);
    
    return normalizedDate;
  } catch (error) {
    console.error(`Error normalizing date ${dateString}:`, error);
    // Return original on error
    return dateString;
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
    
    // Get the date in Eastern Time
    const options = { timeZone: 'America/New_York' };
    const estDateStr = inputDate.toLocaleString('en-US', options);
    const [datePart] = estDateStr.split(', ');
    const [month, day, year] = datePart.split('/').map(num => parseInt(num));
    
    // Create start of day (midnight EST)
    const startOfDay = new Date(Date.UTC(year, month - 1, day, 5, 0, 0)); // 00:00 EST is 05:00 UTC
    
    // Create end of day (23:59:59.999 EST)
    const endOfDay = new Date(Date.UTC(year, month - 1, day, 29, 59, 59, 999)); // 23:59:59.999 EST is 04:59:59.999 UTC next day

    return {
      start: startOfDay.toISOString(),
      end: endOfDay.toISOString()
    };
  } catch (error) {
    console.error('Error in getESTDayRange:', error);
    
    // Fallback to current day
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
  const estDate = toEST(new Date());
  return estDate.toISOString().split('T')[0];
}

/**
 * Compare two dates ignoring time
 */
export function isSameESTDay(date1: string | Date, date2: string | Date): boolean {
  try {
    // Extract just the date portions in EST timezone
    const d1 = toEST(date1);
    const d2 = toEST(date2);
    
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  } catch (error) {
    console.error('Error in isSameESTDay:', error);
    return false;
  }
}

/**
 * Check if two time ranges overlap
 * Returns true if there is any overlap
 */
export function doTimeRangesOverlap(
  start1: string | Date, 
  end1: string | Date,
  start2: string | Date,
  end2: string | Date
): boolean {
  try {
    // Convert to timestamps for easy comparison
    const s1 = new Date(start1).getTime();
    const e1 = new Date(end1).getTime();
    const s2 = new Date(start2).getTime();
    const e2 = new Date(end2).getTime();
    
    // Check for any overlap scenario
    // Must be a TRUE overlap, not just touching at endpoints
    return (
      (s1 >= s2 && s1 < e2) || // start1 is within range2
      (e1 > s2 && e1 <= e2) || // end1 is within range2
      (s1 <= s2 && e1 >= e2)   // range1 completely contains range2
    );
  } catch (error) {
    console.error('Error comparing time ranges:', error);
    return false; // Assume no overlap on error
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
    // Parse the date and convert to EST
    const estDate = toEST(date);
    
    // Format for display
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
 * Get the minutes difference between two times
 */
export function getMinutesBetween(start: string | Date, end: string | Date): number {
  try {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    return Math.round((endTime - startTime) / (1000 * 60));
  } catch (error) {
    console.error('Error calculating minutes between times:', error);
    return 0;
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