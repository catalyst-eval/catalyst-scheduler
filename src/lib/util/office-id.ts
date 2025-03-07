// Modified src/lib/util/office-id.ts

/**
 * Standardizes an office ID to the correct format
 * FIXED: No longer defaults to B-1 in error cases
 */
export function standardizeOfficeId(id: string | undefined): string {
  if (!id) return 'TBD'; // FIXED: Return TBD instead of B-1 when ID is undefined
  
  // Handle telehealth virtual office explicitly
  if (id.toLowerCase() === 'a-v' || id.toLowerCase() === 'av') {
    return 'A-v';
  }
  
  // Handle TBD explicitly
  if (id === 'TBD') {
    return 'TBD';
  }
  
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
    return 'TBD'; // FIXED: Return TBD instead of B-1 when floor is invalid
  }
  
  // For B and C floors, convert letter units to numbers
  if ((floor === 'B' || floor === 'C') && /[A-Z]/.test(unit)) {
    const numericUnit = unit.charCodeAt(0) - 64; // A=1, B=2, etc.
    return `${floor}-${numericUnit}`;
  }
  
  // For A floor, ensure unit is lowercase letter
  if (floor === 'A') {
    // Special case for A-v (virtual)
    if (unit.toLowerCase() === 'v') {
      return 'A-v';
    }
    
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
  
  // Default case - FIXED to return TBD for unrecognized formats
  return 'TBD';
}

/**
 * Validates if a string matches office ID format
 */
export function isValidOfficeId(id: string): boolean {
  // Special case for TBD
  if (id === 'TBD') return false;
  
  // Special case for virtual office
  if (id === 'A-v') return true;
  
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
  // Special case for TBD
  if (id === 'TBD') return 'To Be Determined';
  
  // Special case for virtual office
  if (id === 'A-v') return 'Virtual Office';
  
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