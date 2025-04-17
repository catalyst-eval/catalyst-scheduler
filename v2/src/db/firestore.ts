/**
 * Firestore Database Service
 * 
 * This file provides the interface to interact with Firestore.
 */

import admin from 'firebase-admin';
import { Appointment } from '../models/appointment';

// Initialize Firestore (this should happen once in your application)
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'catalyst-scheduler-v2',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'catalyst-scheduler-v2.appspot.com'
    // Other config will be loaded from environment variables or service account
  });
}

const db = admin.firestore();

// Collection references
const appointmentsCollection = db.collection('appointments');
const cliniciansCollection = db.collection('clinicians');
const officesCollection = db.collection('offices');
const webhooksCollection = db.collection('webhooks');
const clientsCollection = db.collection('clients');
const configCollection = db.collection('config');
const logsCollection = db.collection('logs');

// Appointments
export async function getAppointment(id: string): Promise<Appointment | null> {
  const doc = await appointmentsCollection.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as Appointment;
}

export async function createAppointment(appointment: Appointment): Promise<string> {
  const docRef = appointment.id 
    ? appointmentsCollection.doc(appointment.id)
    : appointmentsCollection.doc();
    
  // Set ID if it was auto-generated
  if (!appointment.id) {
    appointment.id = docRef.id;
  }
  
  await docRef.set(appointment);
  return docRef.id;
}

export async function updateAppointment(id: string, data: Partial<Appointment>): Promise<void> {
  const docRef = appointmentsCollection.doc(id);
  await docRef.update({
    ...data,
    lastUpdated: new Date().toISOString()
  });
}

export async function deleteAppointment(id: string): Promise<void> {
  await appointmentsCollection.doc(id).delete();
}

export async function updateAppointmentStatus(
  id: string, 
  status: 'scheduled' | 'completed' | 'cancelled', 
  options?: { reason?: string; notes?: string }
): Promise<void> {
  const updateData: any = {
    status,
    lastUpdated: new Date().toISOString()
  };
  
  if (status === 'cancelled') {
    updateData.cancelledAt = new Date().toISOString();
    if (options?.reason) {
      updateData.cancellationReason = options.reason;
    }
  }
  
  if (options?.notes) {
    const appointment = await getAppointment(id);
    updateData.notes = appointment?.notes 
      ? `${appointment.notes}\n${options.notes}`
      : options.notes;
  }
  
  await appointmentsCollection.doc(id).update(updateData);
}

// Query helpers
export async function getAppointmentsByDate(date: Date): Promise<Appointment[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const snapshot = await appointmentsCollection
    .where('startTime', '>=', startOfDay.toISOString())
    .where('startTime', '<=', endOfDay.toISOString())
    .get();
    
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Appointment);
}

export async function getAppointmentsByClinicianAndDate(
  clinicianId: string,
  date: Date
): Promise<Appointment[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const snapshot = await appointmentsCollection
    .where('clinicianId', '==', clinicianId)
    .where('startTime', '>=', startOfDay.toISOString())
    .where('startTime', '<=', endOfDay.toISOString())
    .get();
    
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }) as Appointment);
}

// Transaction example for atomic operations
export async function reassignOffice(
  appointmentId: string, 
  newOfficeId: string, 
  reason: string
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const appointmentRef = appointmentsCollection.doc(appointmentId);
    const appointmentDoc = await transaction.get(appointmentRef);
    
    if (!appointmentDoc.exists) {
      throw new Error(`Appointment ${appointmentId} not found`);
    }
    
    const appointmentData = appointmentDoc.data() as Appointment;
    
    // Update appointment with new office
    transaction.update(appointmentRef, {
      officeId: newOfficeId,
      assignmentReason: reason,
      lastUpdated: new Date().toISOString()
    });
    
    // Could also update related records atomically here
    // For example, update office availability in the same transaction
  });
}

// Export for use in other modules
export default {
  db,
  appointmentsCollection,
  cliniciansCollection,
  officesCollection,
  webhooksCollection,
  clientsCollection,
  configCollection,
  logsCollection,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  updateAppointmentStatus,
  getAppointmentsByDate,
  getAppointmentsByClinicianAndDate,
  reassignOffice
};