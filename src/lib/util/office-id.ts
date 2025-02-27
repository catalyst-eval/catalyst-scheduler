// src/lib/util/office-id.ts

/**
 * Standardizes an office ID to the correct format
 */
export function standardizeOfficeId(id: string | undefined): string {
    if (!id) return 'B-1';
    
    // Clean the input and convert to uppercase
    const cleaned = id.trim().toUpperCase();
    
    // Parse the floor and unit
    const parts = cleaned.split('-');
    let floor = parts[0];
    let unit = parts.length > 1 ? parts[1] : '';
    
    // If no explicit separation, try to parse
    if (parts.length === 1 && cleaned.length >= 2) {
      floor = cleaned[0];
      unit = cleaned.slice(1);
    }
    
    // Ensure floor is valid
    if (!['A', 'B', 'C'].includes(floor)) {
      return 'B-1';
    }
    
    // For B and C floors, convert letter units to numbers
    if ((floor === 'B' || floor === 'C') && /[A-Z]/.test(unit)) {
      const numericUnit = unit.charCodeAt(0) - 64; // A=1, B=2, etc.
      return `${floor}-${numericUnit}`;
    }
    
    // For A floor, ensure unit is lowercase letter
    if (floor === 'A') {
      if (/[1-9]/.test(unit)) {
        // Convert number to letter
        unit = String.fromCharCode(96 + parseInt(unit)); // 1=a, 2=b, etc.
      }
      return `${floor}-${unit.toLowerCase()}`;
    }
    
    // For B and C floors with numeric units
    if (/^\d+$/.test(unit)) {
      return `${floor}-${unit}`;
    }
    
    // Default case
    return 'B-1';
  }
  
  /**
   * Validates if a string matches office ID format
   */
  export function isValidOfficeId(id: string): boolean {
    const [floor, unit] = id.split('-');
    
    // Check floor
    if (!['A', 'B', 'C'].includes(floor.toUpperCase())) {
      return false;
    }
    
    // Check unit format
    if (floor === 'A') {
      return /^[a-z]$/.test(unit);
    } else {
      return /^\d+$/.test(unit);
    }
  }
  
  /**
   * Formats office ID for display
   */
  export function formatOfficeId(id: string): string {
    const { floor, unit } = parseOfficeId(id);
    const displayUnit = /^\d+$/.test(unit) ? unit : unit.toUpperCase();
    return `Floor ${floor}, Unit ${displayUnit}`;
  }
  
  /**
   * Parses an office ID into its components
   */
  export function parseOfficeId(id: string): { floor: string, unit: string } {
    const [floor, unit] = id.split('-');
    return { floor, unit };
  }