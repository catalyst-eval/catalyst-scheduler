// src/types/scheduling.ts

// Define StandardOfficeId type
export type StandardOfficeId = string;

// Define AppointmentRecord interface
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

// Define SchedulingConflict interface
export interface SchedulingConflict {
  type: 'double-booking' | 'capacity' | 'accessibility' | 'requirements';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
  timeBlock?: string;
}

// Import the standardizeOfficeId function from the original location
import { standardizeOfficeId as standardizeId } from '../lib/util/office-id';

// Re-export it for use in other files
export const standardizeOfficeId = standardizeId;