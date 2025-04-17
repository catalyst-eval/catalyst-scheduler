/**
 * Appointment model for the Firestore database version
 * 
 * This model represents appointments in the system and maps to the
 * Firestore 'appointments' collection.
 */

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
export type SessionType = 'in-person' | 'telehealth' | 'group' | 'family';

export interface ClientRequirements {
  accessibility: boolean;
  specialFeatures: string[];
}

export interface Appointment {
  id: string;
  
  // Client information
  clientId: string;
  clientName: string;
  clientDateOfBirth?: string;
  
  // Clinician information
  clinicianId: string;
  clinicianName: string;
  
  // Appointment details
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  sessionType: SessionType;
  
  // Office assignment
  officeId: string;
  assignmentReason?: string;
  assignmentPriority?: number; // Higher numbers = higher priority
  
  // Special requirements
  requirements: ClientRequirements;
  
  // Metadata
  source: 'intakeq' | 'manual' | 'migration';
  lastUpdated: string;
  createdAt: string;
  notes?: string;
  tags?: string[];
  
  // For recurring appointments
  seriesId?: string;
  recurrenceRule?: string;
  
  // For cancellations
  cancellationReason?: string;
  cancelledAt?: string;
  cancelledBy?: string;
}

// Helper function to create a new appointment object with default values
export function createAppointment(data: Partial<Appointment>): Appointment {
  const now = new Date().toISOString();
  
  return {
    id: data.id || '',
    clientId: data.clientId || '',
    clientName: data.clientName || '',
    clientDateOfBirth: data.clientDateOfBirth,
    clinicianId: data.clinicianId || '',
    clinicianName: data.clinicianName || '',
    startTime: data.startTime || now,
    endTime: data.endTime || now,
    status: data.status || 'scheduled',
    sessionType: data.sessionType || 'in-person',
    officeId: data.officeId || 'TBD',
    requirements: data.requirements || {
      accessibility: false,
      specialFeatures: []
    },
    source: data.source || 'manual',
    lastUpdated: now,
    createdAt: data.createdAt || now,
    notes: data.notes,
    tags: data.tags,
    seriesId: data.seriesId,
    recurrenceRule: data.recurrenceRule,
    assignmentReason: data.assignmentReason,
    assignmentPriority: data.assignmentPriority,
    cancellationReason: data.cancellationReason,
    cancelledAt: data.cancelledAt,
    cancelledBy: data.cancelledBy
  };
}

// Helper to convert from Version 1 format to Version 2 format
export function convertV1AppointmentToV2(v1Appointment: any): Appointment {
  return createAppointment({
    id: v1Appointment.appointmentId,
    clientId: v1Appointment.clientId,
    clientName: v1Appointment.clientName,
    clientDateOfBirth: v1Appointment.clientDateOfBirth,
    clinicianId: v1Appointment.clinicianId,
    clinicianName: v1Appointment.clinicianName,
    startTime: v1Appointment.startTime,
    endTime: v1Appointment.endTime,
    status: v1Appointment.status as AppointmentStatus,
    sessionType: v1Appointment.sessionType as SessionType,
    officeId: v1Appointment.assignedOfficeId || v1Appointment.officeId || 'TBD',
    source: 'migration',
    notes: v1Appointment.notes,
    requirements: {
      accessibility: v1Appointment.requirements?.accessibility || false,
      specialFeatures: v1Appointment.requirements?.specialFeatures || []
    },
    assignmentReason: v1Appointment.assignmentReason,
    createdAt: v1Appointment.createdAt || v1Appointment.lastUpdated
  });
}