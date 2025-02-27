// src/types/scheduling.ts

export type StandardOfficeId = string;
export type SessionType = 'in-person' | 'telehealth' | 'group' | 'family';
export type AlertSeverity = 'high' | 'medium' | 'low';

export interface AppointmentRecord {
  appointmentId: string;
  clientId: string;
  clientName: string;
  clinicianId: string;
  clinicianName: string;
  officeId: string;
  suggestedOfficeId?: string;
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

// Interface for scheduling requests
export interface SchedulingRequest {
  clientId: string;
  clinicianId: string;
  dateTime: string;
  duration: number;
  sessionType: SessionType;
  clientAge?: number;
  requirements?: {
    accessibility?: boolean;
    specialFeatures?: string[];
    roomPreference?: StandardOfficeId;
  };
}

// Interface for scheduling results
export interface SchedulingResult {
  success: boolean;
  officeId?: StandardOfficeId;
  conflicts?: SchedulingConflict[];
  error?: string;
  notes?: string;
  evaluationLog?: string[];
}

// Interface for scheduling conflicts
export interface SchedulingConflict {
  officeId: StandardOfficeId;
  existingBooking?: SchedulingRequest;
  resolution: {
    type: 'relocate' | 'cannot-relocate';
    reason: string;
    newOfficeId?: StandardOfficeId;
  };
}

// Utility function for standardizing office IDs
export function standardizeOfficeId(officeId: string): string {
  const cleaned = officeId.trim().toUpperCase();
  const match = cleaned.match(/^([A-Z])-?([A-Z])$/i);
  
  if (match) {
    return `${match[1]}-${match[2]}`;
  }
  
  return cleaned;
}

// Validate if an office ID is available at a specific time
export interface OfficeAvailabilityCheck {
  officeId: StandardOfficeId;
  dateTime: string;
  duration: number;
  appointmentId?: string; // For excluding current appointment in updates
}

// Result of an office availability check
export interface OfficeAvailabilityResult {
  available: boolean;
  conflicts: AppointmentRecord[];
  reason?: string;
}

// Interface for office data
export interface OfficeLocation {
  floor: string;
  unit: string;
}