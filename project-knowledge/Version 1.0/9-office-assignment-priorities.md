# Office Assignment Priorities Guide

## Overview

This document outlines the priority rules used by the Catalyst Scheduler for assigning offices to appointments. The system uses a priority-based approach where higher priority rules (higher numbers) take precedence over lower priority rules. This ensures that the most important requirements are satisfied first.

## Age-Based Assignment Logic

Client age is determined by calculating the age at the time of the appointment. The system categorizes clients into these age groups:

- **≤10 Years Old**: Young children
- **11-15 Years Old**: Older children/young teens
- **16-17 Years Old**: Older teens (treated like adults for office assignment)
- **18+ Years Old**: Adults

Clients who are 16 years or older follow the adult office assignment logic, which means they are primarily assigned to their clinician's primary office unless other higher priority rules apply.

## Priority Rules (Highest to Lowest)

### Priority 100: Client-Specific Requirements
- **Description**: Client has a specifically required office noted in their profile
- **Sources**: 
  - Explicit `requiredOffice` field in client accessibility info
  - Office tag in appointment notes or tags (e.g., "B-4")
  - Text in accessibility notes indicating assigned office
- **Purpose**: Ensures clients with specific office requirements always get their assigned office
- **Example**: "Client must always use B-4 due to specific accommodation needs"

### Priority 90: Accessibility Requirements
- **Description**: Client has mobility needs that require specific accessible offices
- **Sources**:
  - `hasMobilityNeeds` flag in client accessibility info
  - "mobility" tag in appointment tags
- **Office Order**: B-4, B-5 (most accessible offices)
- **Purpose**: Ensures clients with mobility needs are assigned to accessible offices
- **Example**: "Client uses a wheelchair and requires ground floor access"

### Priority 85: Telehealth Primary Assignment
- **Description**: Telehealth appointments are assigned to clinician's primary office
- **Applies**: Only to telehealth appointments
- **Office**: Clinician's primary office (first in their preferred offices list)
- **Purpose**: Ensures clinicians conduct telehealth sessions from their primary office
- **Note**: Availability is not checked since multiple telehealth sessions can use the same physical office

### Priority 80: Young Children Assignment (≤10 years)
- **Description**: Young children are assigned to child-friendly offices
- **Age Group**: Children 10 years and younger
- **Office Order**: 
  1. B-5 (Primary)
  2. C-1 (Secondary, Priority 73)
  3. B-2 (Tertiary, Priority 72)
- **Purpose**: Ensures young children are placed in appropriate therapeutic environments
- **Example**: "8-year-old client assigned to B-5 which has child-friendly features"

### Priority 78: Yoga Swing Assignment
- **Description**: Clients requiring a yoga swing are assigned to offices with this feature
- **Sources**: 
  - `hasSensoryNeeds` flag in client accessibility
  - "yoga-swing" mentioned in accessibility notes
- **Office Order** (Age-dependent):
  - Ages ≤10: B-5 → C-1 → B-2
  - Ages 11-15: C-1 → B-5 → B-2
  - Ages 16+ (including adults): B-2 → C-1 → B-5
- **Purpose**: Ensures clients who need a yoga swing are placed in appropriate offices
- **Example**: "Client with sensory integration needs requires access to a yoga swing"

### Priority 75: Older Children/Teens Assignment (11-15 years)
- **Description**: Older children and younger teens assigned to appropriate offices
- **Age Group**: Children 11-15 years old (specifically excludes 16-17 year olds)
- **Office Order**:
  1. C-1 (Primary)
  2. B-5 (Secondary, Priority 74)
  3. B-2 (Tertiary, Priority 72)
- **Purpose**: Ensures older children are placed in age-appropriate therapeutic environments
- **Example**: "13-year-old client assigned to C-1 which is suitable for older children/teens"

### Priority 65: Clinician's Primary Office
- **Description**: Clients are assigned to their clinician's primary office
- **Office**: First office in clinician's preferred offices list
- **Applies**: To all appointments, but especially important for clients 16+ years old
- **Purpose**: Ensures clinicians can use their primary workspace for most appointments
- **Example**: "Adult client assigned to B-4 because it's their clinician's primary office"

### Priority 62: Clinician's Other Preferred Offices
- **Description**: Clients are assigned to their clinician's other preferred offices
- **Offices**: Second and subsequent offices in clinician's preferred offices list
- **Purpose**: When primary office is unavailable, try clinician's other preferred spaces
- **Example**: "Client assigned to C-2 because clinician's primary office B-4 was unavailable"

### Priority 55: Adult Client Assignment (18+ years)
- **Description**: Adult clients are assigned to adult-appropriate offices
- **Age Group**: Adults (18+) and older teens (16-17)
- **Office Order**:
  1. Primary: B-4, C-2, C-3
  2. Secondary: B-5, C-1
- **Purpose**: Ensures adult clients are placed in appropriate therapeutic environments
- **Example**: "Adult client assigned to B-4 which is suitable for adult therapy"

### Priority 50: In-Person Session Default Assignment
- **Description**: Last resort for any in-person session without an office
- **Office Order**: B-4, B-5, C-1, C-2, C-3
- **Purpose**: Ensures all in-person appointments have an office assignment
- **Example**: "In-person session assigned to first available office when no other rules apply"

### Priority 40: Telehealth to Preferred Office
- **Description**: Telehealth appointments use clinician's other preferred offices
- **Applies**: Only to telehealth appointments
- **Offices**: Second and subsequent offices in clinician's preferred offices list
- **Purpose**: When primary office is unavailable for telehealth, use other preferred offices
- **Example**: "Telehealth session assigned to C-3 when clinician's primary office was unavailable"

## Summary of Age-Based Office Assignment Logic

1. **Ages ≤10 (Young Children)**:
   - Primary: B-5 (Priority 80)
   - Secondary: C-1 (Priority 73)
   - Tertiary: B-2 (Priority 72)

2. **Ages 11-15 (Older Children/Young Teens)**:
   - Primary: C-1 (Priority 75)
   - Secondary: B-5 (Priority 74)
   - Tertiary: B-2 (Priority 72)

3. **Ages 16-17 (Older Teens)**:
   - Primary: Clinician's primary office (Priority 65)
   - Secondary: Clinician's other preferred offices (Priority 62)
   - Tertiary: Adult office assignments (Priority 55)
   
4. **Ages 18+ (Adults)**:
   - Primary: Clinician's primary office (Priority 65)
   - Secondary: Clinician's other preferred offices (Priority 62)
   - Tertiary: B-4, C-2, C-3, then B-5, C-1 (Priority 55)

## Office Assignment Process

1. The scheduler proceeds through the priority rules from highest (100) to lowest (10)
2. At each priority level, the system checks if the rule applies to the appointment
3. If the rule applies, the system attempts to assign an office following that rule
4. If an office is successfully assigned, the process stops
5. If no office is assigned, the system continues to the next lower priority rule
6. For in-person appointments, office availability is always checked before assignment
7. For telehealth appointments, availability is not checked since multiple telehealth sessions can use the same physical office

This systematic approach ensures that all appointments receive appropriate office assignments based on client needs, clinician preferences, and office availability.