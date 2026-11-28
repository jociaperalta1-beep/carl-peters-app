/**
 * Phase 0 Security Test Spec — CARL PETERS Asistencia & Nómina PY 2026
 * Verifies the "Dirty Dozen" adversarial payloads against firestore.rules.
 * Run with Firebase Emulator Suite (`@firebase/rules-unit-testing`) when available.
 */
export interface DirtyDozenCase {
  id: number;
  name: string;
  collection: string;
  docId: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read on employee PII',
    collection: 'employees',
    docId: 'emp1',
    operation: 'get',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified admin email spoof',
    collection: 'settings',
    docId: 'company',
    operation: 'update',
    auth: { uid: 'spoof', email: 'jociaperalta1@gmail.com', email_verified: false },
    payload: { companyLogo: '', wd: 8, sat: 4 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-user PII get on another employee',
    collection: 'employees',
    docId: 'emp_victim',
    operation: 'get',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Unauthorized blanket list on employees',
    collection: 'employees',
    docId: '*',
    operation: 'list',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Identity spoofing ownerUid on create',
    collection: 'employees',
    docId: 'emp_spoof',
    operation: 'create',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    payload: {
      name: 'Fake',
      ci: '123456',
      sector: 'Obra',
      pin: '1234',
      ownerUid: 'victim_uid',
      email: 'attacker@example.com',
      active: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Privilege escalation into admins collection',
    collection: 'admins',
    docId: 'attacker',
    operation: 'create',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    payload: { email: 'attacker@example.com' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Shadow field injection (isAdmin: true)',
    collection: 'employees',
    docId: 'emp_shadow',
    operation: 'create',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: {
      name: 'Worker',
      ci: '999999',
      sector: 'Ganado',
      pin: '1234',
      ownerUid: 'worker1',
      email: 'worker1@example.com',
      active: true,
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Orphan attendance mark for non-existent employee',
    collection: 'marks',
    docId: 'ghost_2026-11-26',
    operation: 'create',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: {
      employeeId: 'ghost',
      ownerUid: 'worker1',
      date: '2026-11-26',
      e1: '07:00:00',
      s2: '',
      e3: '',
      s4: '',
      lat: 0,
      lng: 0,
      hasGps: false,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Path ID poisoning with invalid characters',
    collection: 'employees',
    docId: 'bad$id!with/slashes',
    operation: 'create',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: { name: 'Bad' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Client-forged createdAt timestamp',
    collection: 'marks',
    docId: 'emp1_2026-11-26',
    operation: 'create',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: {
      employeeId: 'emp1',
      ownerUid: 'worker1',
      date: '2026-11-26',
      e1: '07:00:00',
      s2: '',
      e3: '',
      s4: '',
      lat: 0,
      lng: 0,
      hasGps: false,
      createdAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Value poisoning invalid time and out-of-range latitude',
    collection: 'marks',
    docId: 'emp1_2026-11-26',
    operation: 'update',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: { e1: 'INVALID', lat: 999 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unbounded GPS history array DoS (>300 points)',
    collection: 'gpsHistory',
    docId: 'emp1_2026-11-26',
    operation: 'update',
    auth: { uid: 'worker1', email: 'worker1@example.com', email_verified: true },
    payload: {
      points: Array.from({ length: 301 }, () => ({ lat: -25.26, lng: -57.57, t: '08:00:00' })),
    },
    expected: 'PERMISSION_DENIED',
  },
];
