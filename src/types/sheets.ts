// src/types/sheets.ts

export type SheetRow = string[];

export interface SheetResponse {
  values: SheetRow[];
}

export interface SheetOffice {
    officeId: string;
    name: string;
    unit: string;
    inService: boolean;
    floor: 'upstairs' | 'downstairs';
    isAccessible: boolean;
    size: 'small' | 'medium' | 'large';
    ageGroups: string[];
    specialFeatures: string[];
    primaryClinician?: string;
    alternativeClinicians: string[];
    isFlexSpace: boolean;
    notes?: string;
  }
  
  export interface SheetClinician {
    clinicianId: string;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'clinician' | 'intern';
    ageRangeMin: number;
    ageRangeMax: number;
    specialties: string[];
    caseloadLimit: number;
    currentCaseload: number;
    preferredOffices: string[];
    allowsRelationship: boolean;
    certifications: string[];
    intakeQPractitionerId: string;
  }
  
  export interface AssignmentRule {
    priority: number;
    ruleName: string;
    ruleType: string;
    condition: string;
    officeIds: string[];
    overrideLevel: 'hard' | 'soft' | 'none';
    active: boolean;
    notes?: string;
  }
  
  export interface ClientPreference {
    clientId: string;
    name: string;
    email: string;
    mobilityNeeds: string[];
    sensoryPreferences: string[];
    physicalNeeds: string[];
    roomConsistency: number;
    supportNeeds: string[];
    specialFeatures: string[];
    additionalNotes?: string;
    lastUpdated: string;
    preferredClinician?: string;
    assignedOffice?: string;
  }
  
  export interface ScheduleConfig {
    settingName: string;
    value: string;
    description: string;
    lastUpdated: string;
    updatedBy: string;
  }
  
  export interface IntegrationSetting {
    serviceName: string;
    settingType: string;
    value: string;
    description: string;
    lastUpdated: string;
  }
  
  export interface AuditLogEntry {
    timestamp: string;
    eventType: string;
    description: string;
    user: string;
    previousValue?: string;
    newValue?: string;
    systemNotes?: string;
  }