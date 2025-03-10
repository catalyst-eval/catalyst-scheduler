// src/types/api.ts

import { ScheduleConflict } from './scheduling';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface ValidationResponse {
  isValid: boolean;
  conflicts: AppointmentConflict[];
}

export interface AppointmentConflict {
  type: 'double-booking' | 'capacity' | 'accessibility';
  description: string;
  severity: 'high' | 'medium' | 'low';
  appointmentIds?: string[];
  officeId?: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
  timestamp: string;
  details?: any;
}

export interface WebhookEndpointResponse {
  success: boolean;
  message: string;
  timestamp: string;
}

export interface ScheduleResponse {
  date: string;
  appointments: Array<{
    appointmentId: string;
    clientName: string;
    clinicianName: string;
    officeId: string;
    startTime: string;
    endTime: string;
  }>;
  conflicts: Array<{
    type: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}