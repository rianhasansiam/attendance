// JSON display contracts only. Never add verification evidence or credentials.
export type AttendanceRecord = {
  id?: string;
  attendanceDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  status: string;
  lateMinutes: number;
  lateReason: string | null;
  workedMinutes: number;
  overtimeMinutes: number | null;
};

export type DeviceMetadata = {
  id: string;
  name: string;
  approved: boolean;
  revokedAt: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
};

export type EmployeeDay = {
  employee: {
    id: string;
    employeeCode: string;
    user: { name: string | null; email: string; image: string | null };
    department: { id: string; name: string } | null;
    office: {
      id: string;
      name: string;
      address: string;
      timezone: string;
      policy: { requireGeofence: boolean; requireOfficeNetwork: boolean };
    };
  };
  shift: {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    timezone: string;
  } | null;
  today: AttendanceRecord | null;
  recent: AttendanceRecord[];
  devices: DeviceMetadata[];
  network: { verified: boolean | null };
  serverTime: string;
};

export type AttendanceHistoryArgs = {
  page: number;
  from?: string;
  to?: string;
};
export type AttendanceHistory = {
  records: AttendanceRecord[];
  total: number;
  page: number;
  pageSize: number;
};
export type DeviceList = {
  items: DeviceMetadata[];
  total: number;
  page: number;
  pageSize: number;
};
