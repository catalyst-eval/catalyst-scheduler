// src/types/offices.ts

import { StandardOfficeId } from './scheduling';

export interface OfficeLocation {
  floor: string;
  unit: string;
}

export interface OfficeDetails {
  id: StandardOfficeId;
  name: string;
  isAccessible: boolean;
  features: string[];
  capacity: number;
  availableHours: {
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
}