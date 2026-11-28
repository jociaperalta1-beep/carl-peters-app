import type { Timestamp } from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface CompanyRules {
  wd: number;
  sat: number;
}

export interface CompanySettingsDoc {
  companyLogo: string;
  wd: number;
  sat: number;
  sectors?: string[];
  updatedAt?: Timestamp;
}

export interface EmployeeDoc {
  id: string;
  name: string;
  ci: string;
  ciNormalized?: string;
  sector: string;
  pin: string;
  hireDate?: string;
  hourlyRate?: number;
  overtimePct?: number;
  hasIps?: boolean;
  ipsAmount?: number;
  lastClosedDate?: string;
  carryOverBalance?: number;
  pinResetEnabled?: boolean;
  ownerUid: string;
  email: string;
  active: boolean;
  createdAt?: Timestamp | string;
  updatedAt?: Timestamp | string;
}

export interface ExtraPunchPair {
  in: string;
  out: string;
  inTs?: number;
  outTs?: number;
}

export interface PunchTimestamps {
  e1?: number;
  s2?: number;
  e3?: number;
  s4?: number;
}

export interface AttendanceMarkDoc {
  id: string;
  employeeId: string;
  ownerUid: string;
  date: string;
  e1: string;
  s2: string;
  e3: string;
  s4: string;
  punchTs?: PunchTimestamps;
  extraPunches?: ExtraPunchPair[];
  lat: number;
  lng: number;
  hasGps: boolean;
  createdAt?: Timestamp | string;
  updatedAt?: Timestamp | string;
}

export interface GpsLiveDoc {
  employeeId: string;
  ownerUid: string;
  empName: string;
  sector: string;
  lat: number;
  lng: number;
  accuracy: number;
  date: string;
  time: string;
  updatedAt?: Timestamp | string;
}

export interface GpsPoint {
  lat: number;
  lng: number;
  t: string;
}

export interface GpsHistoryDoc {
  id: string;
  employeeId: string;
  ownerUid: string;
  date: string;
  points: GpsPoint[];
  updatedAt?: Timestamp | string;
}

export interface PayrollLiquidationDoc {
  id: string;
  type: 'salary' | 'legal';
  employeeId: string;
  ownerUid: string;
  empName: string;
  empCi: string;
  sector: string;
  periodStart: string;
  periodEnd: string;
  daysCount: number;
  normalSec: number;
  extraSec: number;
  hourlyRate: number;
  overtimePct: number;
  normalSubtotal: number;
  extraSubtotal: number;
  previousBalance: number;
  ipsDeduction: number;
  netTotal: number;
  ipsApplied: boolean;
  summary: string;
  createdAt?: Timestamp | string;
}

export interface ManualExpenseDoc {
  id: string;
  date: string;
  sector: string;
  concept: string;
  invoice: string;
  amount: number;
  createdByUid: string;
  createdAt?: Timestamp | string;
}

export interface AppState {
  companyLogo: string;
  rules: CompanyRules;
  sectors: string[];
  employees: EmployeeDoc[];
  marks: Record<string, AttendanceMarkDoc>;
  gpsLive: Record<string, GpsLiveDoc>;
  payrolls: PayrollLiquidationDoc[];
  expenses: ManualExpenseDoc[];
}

export type LayoutMode = 'admin' | 'both' | 'mobile';
export type AdminTab = 'portada' | 'hoy' | 'rrhh' | 'emp' | 'cal' | 'gps' | 'rank' | 'cfg';
export type RrhhSubTab = 'pago' | 'legal' | 'ext' | 'gastos';
export type RankingMode = 'emp' | 'sector';
export type RankingDateFilter = 'range' | 'month' | 'year';
export type GpsMode = 'live' | 'hist';
export type MapLayerMode = 'sat' | 'osm';
export type AuthTab = 'login' | 'reg';
export type MobSubTab = 'punch' | 'hours';

export interface RememberedMobUser {
  employeeId: string;
  name: string;
  ci: string;
  sector: string;
}
