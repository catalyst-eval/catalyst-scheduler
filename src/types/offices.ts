// src/types/offices.ts

import { standardizeOfficeId } from './scheduling';

export interface OfficeLocation {
  floor: string;
  unit: string;
}

export interface OfficeDetails {
  id: string; // Use string type instead of StandardOfficeId which doesn't exist
  name: string;
  isAccessible: boolean;
  features: string[];
  capacity: number;
  availableHours: {
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
}