// src/types/webhooks.ts

export type WebhookEventType = 
  | 'Form Submitted'
  | 'Intake Submitted'
  | 'AppointmentCreated'
  | 'AppointmentUpdated'
  | 'AppointmentRescheduled'
  | 'AppointmentCancelled'
  | 'AppointmentConfirmed'  // Add this line
  | 'Appointment Created'  
  | 'Appointment Updated'
  | 'Appointment Rescheduled'
  | 'Appointment Cancelled'
  | 'Appointment Confirmed'  // Add this line
  | 'AppointmentCanceled'
  | 'Appointment Canceled'
  | 'AppointmentDeleted'
  | 'Appointment Deleted';

export interface IntakeQAppointment {
  Id: string;
  ClientName: string;
  ClientEmail: string;
  ClientPhone: string;
  ClientDateOfBirth: string;
  ClientId: number;
  Status: string;
  StartDate: number;
  EndDate: number;
  Duration: number;
  ServiceName: string;
  ServiceId: string;
  LocationName: string;
  LocationId: string;
  Price: number;
  PractitionerName: string;
  PractitionerEmail: string;
  PractitionerId: string;
  IntakeId: string | null;
  DateCreated: number;
  CreatedBy: string;
  BookedByClient: boolean;
  ExternalClientId?: string;
  StartDateIso: string;
  EndDateIso: string;
  StartDateLocal: string;
  EndDateLocal: string;
  StartDateLocalFormatted: string;
  CancellationReason?: string;
  RecurrencePattern?: {
    frequency: 'weekly' | 'biweekly' | 'monthly';
    occurrences: number;
    endDate?: string;
  };
  [key: string]: any;
}

export interface IntakeQWebhookPayload {
  IntakeId?: string;
  Type?: WebhookEventType;  // Keep Type for backward compatibility
  EventType?: WebhookEventType; // New field name
  ClientId: number;
  ClientName?: string;
  ClientEmail?: string;
  ExternalClientId?: string;
  PracticeId?: string;
  ExternalPracticeId?: string | null;
  formId?: string;
  responses?: Record<string, any>;
  Appointment?: IntakeQAppointment;
  ActionPerformedByClient?: boolean;
}

export interface WebhookResponse {
  success: boolean;
  error?: string;
  details?: any;
  retryable?: boolean;
}

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}