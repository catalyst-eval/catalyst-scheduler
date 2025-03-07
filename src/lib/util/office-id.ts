// src/lib/util/office-id.ts

/**
 * Standardizes an office ID to the correct format
 * Correctly handles B and C buildings with their floor information
 */
export function standardizeOfficeId(id: string | undefined): string {
  if (!id) return 'TBD';
  
  // Handle telehealth virtual office explicitly
  if (id.toLowerCase() === 'a-v' || id.toLowerCase() === 'av') {
    return 'A-v';
  }
  
  // Handle TBD explicitly
  if (id === 'TBD') {
    return 'TBD';
  }
  
  // Clean the input and convert to uppercase for consistent processing
  const cleaned = id.trim().toUpperCase();
  
  // Parse the building and unit
  const parts = cleaned.split('-');
  let building = parts[0];
  let unit = parts.length > 1 ? parts[1] : '';
  
  // If no explicit separation, try to parse
  if (parts.length === 1 && cleaned.length >= 2) {
    building = cleaned[0];
    unit = cleaned.slice(1);
  }
  
  // Ensure building is valid (A, B, C buildings)
  if (!['A', 'B', 'C'].includes(building)) {
    return 'TBD';
  }
  
  // For B and C buildings, ensure numeric units
  if ((building === 'B' || building === 'C') && /[A-Z]/.test(unit)) {
    // Convert letter to number if needed (A=1, B=2, etc.)
    const numericUnit = unit.charCodeAt(0) - 64; // A=1, B=2, etc.
    return `${building}-${numericUnit}`;
  }
  
  // For A building (virtual offices), ensure lowercase letter
  if (building === 'A') {
    // Special case for A-v (virtual)
    if (unit.toLowerCase() === 'v') {
      return 'A-v';
    }
    
    // Convert numeric to letter if needed
    if (/^\d+$/.test(unit)) {
      unit = String.fromCharCode(96 + parseInt(unit)); // 1=a, 2=b, etc.
    }
    
    return `${building}-${unit.toLowerCase()}`;
  }
  
  // For B and C buildings with numeric units
  if (/^\d+$/.test(unit)) {
    return `${building}-${unit}`;
  }
  
  // Default case - return TBD for unrecognized formats
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
  
  const [building, unit] = id.split('-');
  
  // Check building
  if (!['A', 'B', 'C'].includes(building.toUpperCase())) {
    return false;
  }
  
  // Check unit format
  if (building === 'A') {
    return /^[a-z]$/.test(unit);
  } else {
    return /^\d+$/.test(unit);
  }
}

/**
 * Determines if an office is on the ground floor
 * B-4 and B-5 are the only ground floor offices
 */
export function isGroundFloorOffice(id: string): boolean {
  return id === 'B-4' || id === 'B-5';
}

/**
 * Determines if an office is accessible based on ID
 * B-4, B-5, and C-3 are accessible
 */
export function isAccessibleOffice(id: string): boolean {
  return id === 'B-4' || id === 'B-5' || id === 'C-3';
}

/**
 * Formats office ID for display
 */
export function formatOfficeId(id: string): string {
  // Special case for TBD
  if (id === 'TBD') return 'To Be Determined';
  
  // Special case for virtual office
  if (id === 'A-v') return 'Virtual Office';
  
  const { building, unit } = parseOfficeId(id);
  const floor = isGroundFloorOffice(id) ? 'Ground' : 'Upper';
  const displayUnit = /^\d+$/.test(unit) ? unit : unit.toUpperCase();
  
  return `Building ${building}, ${floor} Floor, Unit ${displayUnit}`;
}

/**
 * Parses an office ID into its components
 */
export function parseOfficeId(id: string): { building: string, unit: string } {
  const [building, unit] = id.split('-');
  return { building, unit };
}