// src/types/scheduling.ts

/**
 * Standardizes an office ID to the correct format
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
 * Appointment record with updated field names for the new standard
 */
export interface AppointmentRecord {
  appointmentId: string;
  clientId: string;
  clientName: string;
  clientDateOfBirth: string;
  clinicianId: string;
  clinicianName: string;
  
  // Updated field names per standardization
  currentOfficeId?: string;      // Previously officeId - historical/current assignment
  assignedOfficeId?: string;     // Previously suggestedOfficeId - algorithmic assignment
  assignmentReason?: string;     // New field for tracking why office was assigned
  
  // For backward compatibility during transition
  officeId?: string;             // Keep this temporarily for backward compatibility
  suggestedOfficeId?: string;    // Keep this temporarily for backward compatibility
  
  sessionType: 'in-person' | 'telehealth' | 'group' | 'family';
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  lastUpdated: string;
  source: 'intakeq' | 'manual';
  requirements?: {
    accessibility?: boolean;
    specialFeatures?: string[];
  };
  notes?: string;
}

/**
 * Legacy format handler
 * Converts between old and new field names to ensure compatibility
 */
export function normalizeAppointmentRecord(record: any): AppointmentRecord {
  // Handle the case where we might have either old or new field names
  const normalized: AppointmentRecord = {
    appointmentId: record.appointmentId,
    clientId: record.clientId,
    clientName: record.clientName,
    clientDateOfBirth: record.clientDateOfBirth || '', // Add this line
    clinicianId: record.clinicianId,
    clinicianName: record.clinicianName,
    sessionType: record.sessionType || 'in-person',
    startTime: record.startTime,
    endTime: record.endTime,
    status: record.status || 'scheduled',
    lastUpdated: record.lastUpdated || new Date().toISOString(),
    source: record.source || 'manual',
    notes: record.notes,
    requirements: record.requirements
  };

  // Handle office ID fields - support both old and new formats
  if (record.currentOfficeId) {
    normalized.currentOfficeId = record.currentOfficeId;
  } else if (record.officeId) {
    normalized.currentOfficeId = record.officeId;
  }

  if (record.assignedOfficeId) {
    normalized.assignedOfficeId = record.assignedOfficeId;
  } else if (record.suggestedOfficeId) {
    normalized.assignedOfficeId = record.suggestedOfficeId;
  }

  // Always set officeId as well for backward compatibility
  normalized.officeId = normalized.currentOfficeId || normalized.assignedOfficeId;
  normalized.suggestedOfficeId = normalized.assignedOfficeId;

  // Include assignment reason if available
  if (record.assignmentReason) {
    normalized.assignmentReason = record.assignmentReason;
  }

  return normalized;
}

/**
 * Client accessibility information
 */
export interface ClientAccessibilityInfo {
  clientId: string;
  clientName: string;
  lastUpdated: string;
  hasMobilityNeeds: boolean;
  mobilityDetails: string;
  hasSensoryNeeds: boolean;
  sensoryDetails: string;
  hasPhysicalNeeds: boolean;
  physicalDetails: string;
  roomConsistency: number;
  hasSupportNeeds: boolean;
  supportDetails: string;
  additionalNotes: string;
  requiredOffice?: string;  // New field for permanent office assignment
  formType: string;
  formId: string;
}

/**
 * Office assignment interface
 */
export interface OfficeAssignment {
  officeId: string;
  reason: string;
  priority: number;
  isPrimary: boolean;
}

/**
 * Office change record
 */
export interface OfficeChange {
  appointmentId: string;
  clientId: string;
  clientName: string;
  clinicianId: string;
  clinicianName: string;
  previousOfficeId: string;
  newOfficeId: string;
  reason: string;
  startTime: string;
}

/**
 * Daily schedule item interface
 */
export interface DailyScheduleItem {
  appointmentId: string;
  clientName: string;
  clinicianName: string;
  officeId: string;
  startTime: string;
  endTime: string;
  sessionType: string;
  hasSpecialRequirements: boolean;
  requiresOfficeChange?: boolean;
  previousOffice?: string;
  assignmentReason?: string;
}

/**
 * Office configuration interface
 */
export interface OfficeConfiguration {
  officeId: string;
  name: string;
  inService: boolean;
  isAccessible: boolean;
  size: 'small' | 'medium' | 'large';
  floor: 'upstairs' | 'downstairs';
  specialFeatures: string[];
  primaryClinician?: string;
  alternativeClinicians: string[];
  defaultUse?: string;
  notes?: string;
}

/**
 * Priority levels for office assignment rules
 */
export enum RulePriority {
  CLIENT_SPECIFIC_REQUIREMENT = 100,
  ACCESSIBILITY_REQUIREMENT = 90,
  YOUNG_CHILDREN = 80,
  OLDER_CHILDREN_TEENS = 75,
  CLINICIAN_PRIMARY_OFFICE = 65,
  CLINICIAN_PREFERRED_OFFICE = 62,
  ADULTS = 55,
  IN_PERSON_PRIORITY = 50,
  TELEHEALTH_PREFERRED = 40,
  SPECIAL_FEATURES_MATCH = 35,
  ALTERNATIVE_CLINICIAN = 30,
  AVAILABLE_OFFICE = 20,
  BREAK_ROOM_LAST_RESORT = 15,
  DEFAULT_TELEHEALTH = 10
}

/**
 * Schedule conflict types
 */
export interface ScheduleConflict {
  type: 'double-booking' | 'capacity' | 'accessibility' | 'requirements';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
  timeBlock?: string;
  clinicianIds?: string[];
  resolutionSuggestion?: string;
}