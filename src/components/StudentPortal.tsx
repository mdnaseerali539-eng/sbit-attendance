import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  Camera,
  CheckCircle2,
  Clock,
  KeyRound,
  LogOut,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AuthMeResponse } from '../types';
import { CameraVerificationModal } from './CameraVerificationModal';

interface StudentPortalProps {
  me: AuthMeResponse;
  initialBannerMsg?: string | null;
  onLogout: () => void;
}

interface StudentDashboardData {
  student: AuthMeResponse['profile'];
  enrollment: NonNullable<AuthMeResponse['enrollment']>;
  biometricStatus: AuthMeResponse['biometricStatus'];
  summary: {
    attendancePercentage: number;
    workingDays: number;
    presentDays: number;
    absentDays: number;
    totalSessions: number;
    presentSessions: number;
  };
  subjectWise: Array<{
    subjectId: string;
    subjectCode: string;
    subjectName: string;
    present: number;
    total: number;
    percentage: number;
  }>;
  calendar: Array<{
    date: string;
    status: 'present' | 'absent' | 'partial';
    sessions: number;
    present: number;
  }>;
  activeSessions: Array<{
    id: string;
    sessionCode: string;
    subjectCode: string;
    subjectName: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    periodSlot: string;
    alreadyMarked: boolean;
  }>;
  recentRecords: Array<{
    id: string;
    sessionCode: string;
    subjectCode: string;
    subjectName: string;
    attendanceDate: string;
    markedAtIST: string;
    status: string;
    verificationMethod: string;
  }>;
  collegeSettings: AuthMeResponse['collegeSettings'];
}

export const StudentPortal: React.FC<StudentPortalProps> = ({
  me,
  initialBannerMsg = null,
  onLogout,
}) => {
  const [tab, setTab] = useState<'overview' | 'calendar' | 'biometrics'>('overview');
  const [data, setData] = useState<StudentDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(initialBannerMsg);

  useEffect(() => {
    if (initialBannerMsg) setBannerMsg(initialBannerMsg);
  }, [initialBannerMsg]);

  const [cameraModal, setCameraModal] = useState<{
    mode: 'enroll' | 'verify';
    sessionId?: string;
    sessionLabel?: string;
  } | null>(null);

  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const [newPassword, setNewPassword] = useState('');
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<StudentDashboardData>('/api/student/dashboard');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load student dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  async function handleDeleteBiometrics() {
    setError(null);
    setBannerMsg(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/student/biometrics', {
        method: 'DELETE',
      });
      setBannerMsg(res.message);
      loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove biometric template.');
    }
  }

  async function handleAssistedFallback(
    sessionId: string,
    reason: string,
    requestType: 'location_bypass' | 'liveness_assisted'
  ) {
    try {
      const res = await apiFetch<{ message: string }>('/api/student/attendance/override-request', {
        method: 'POST',
        body: JSON.stringify({ sessionId, reason, requestType }),
      });
      setCameraModal(null);
      setBannerMsg(res.message);
      loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit verification request.');
    }
  }

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdMsg(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ password: newPassword }),
      });
      setNewPassword('');
      setPwdMsg(res.message);
    } catch (err) {
      setPwdMsg(err instanceof Error ? err.message : 'Failed to save password.');
    }
  }

  const calendarDays = useMemo(() => {
    const [yrStr, moStr] = calendarMonth.split('-');
    const year = Number(yrStr);
    const month = Number(moStr) - 1;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const map = new Map((data?.calendar || []).map((c) => [c.date, c]));
    const cells: Array<{ day: number | null; dateStr?: string; status?: 'present' | 'absent' | 'partial' }> = [];
    for (let i = 0; i < firstDay; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${yrStr}-${moStr}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateStr: ds, status: map.get(ds)?.status });
    }
    return cells;
  }, [calendarMonth, data]);

  const collegeName =
    data?.collegeSettings?.collegeName ||
    me.collegeSettings?.collegeName ||
    'Swarna Bharathi Institute of Science and Technology';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar */}
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <img
            src={
              data?.collegeSettings?.logoUrl ||
              me.collegeSettings?.logoUrl ||
              '/src/assets/images/sbist_college_crest_1795533458624.jpg'
            }
            alt="College Logo"
            referrerPolicy="no-referrer"
            className="h-10 w-10 rounded-lg object-contain border border-slate-200 p-0.5 shrink-0"
          />
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-900 truncate">{collegeName}</div>
            <div className="text-xs text-slate-500 truncate">
              Student Portal · {me.profile.fullName} ({me.profile.rollNumber})
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap shrink-0"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </button>
      </header>

      {/* Navigation Tabs */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-8">
        <nav className="flex items-center gap-2 py-2 overflow-x-auto">
          {[
            { id: 'overview', label: 'Attendance & Sessions' },
            { id: 'calendar', label: 'Monthly Calendar & Subjects' },
            { id: 'biometrics', label: 'Face Enrollment & Security' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id as typeof tab)}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                tab === item.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-8 space-y-6">
        {bannerMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800 flex items-center justify-between gap-2">
            <span>{bannerMsg}</span>
            <button type="button" onClick={() => setBannerMsg(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
            Loading your academic profile and attendance records...
          </div>
        ) : data ? (
          <>
            {tab === 'overview' && (
              <div className="space-y-6">
                {/* Profile Strip */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h2 className="text-lg font-bold text-slate-900">{data.student.fullName}</h2>
                    <p className="text-xs text-slate-600">
                      Roll No: <span className="font-mono-tabular font-semibold">{data.enrollment.rollNumber}</span>
                      {' · '}
                      {data.enrollment.departmentCode}
                      {' · '}
                      {data.enrollment.yearLabel}
                      {' · '}
                      {data.enrollment.semesterLabel}
                      {' · '}
                      {data.enrollment.className}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {!data.biometricStatus.enrolled ? (
                      <button
                        type="button"
                        onClick={() => setCameraModal({ mode: 'enroll' })}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
                      >
                        <Camera className="h-4 w-4" />
                        Complete Face Enrollment First
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <ShieldCheck className="h-4 w-4" />
                        Face Template Enrolled ({data.biometricStatus.sampleCount} samples)
                      </span>
                    )}
                  </div>
                </div>

                {/* KPI Strip */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Overall Attendance</div>
                    <div className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                      {data.summary.attendancePercentage}%
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Working Days</div>
                    <div className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                      {data.summary.workingDays}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Present Days</div>
                    <div className="text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
                      {data.summary.presentDays}
                    </div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="text-xs text-slate-500">Absent Days</div>
                    <div className="text-2xl font-bold text-red-700 mt-1 tabular-nums">
                      {data.summary.absentDays}
                    </div>
                  </div>
                </div>

                {/* Active Attendance Sessions */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold text-slate-900">Mark Attendance</h3>
                      <p className="text-xs text-slate-500">
                        Active sessions open for {data.enrollment.className}
                      </p>
                    </div>
                  </div>

                  {data.activeSessions.length === 0 ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-center text-xs text-slate-600">
                      No active attendance session is available for your class.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {data.activeSessions.map((ses) => (
                        <div
                          key={ses.id}
                          className="rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-slate-900">
                              {ses.subjectCode} · {ses.subjectName}
                            </div>
                            <div className="text-xs text-slate-500 font-mono-tabular flex items-center gap-2">
                              <Clock className="h-3.5 w-3.5" />
                              {ses.sessionDate} · {ses.startTime} – {ses.endTime} IST
                            </div>
                          </div>
                          {ses.alreadyMarked ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                              <CheckCircle2 className="h-4 w-4" />
                              Marked Present
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (!data.biometricStatus.enrolled) {
                                  setCameraModal({ mode: 'enroll' });
                                  return;
                                }
                                setCameraModal({
                                  mode: 'verify',
                                  sessionId: ses.id,
                                  sessionLabel: `${ses.subjectCode} · ${ses.subjectName} (${ses.startTime}–${ses.endTime} IST)`,
                                });
                              }}
                              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap"
                            >
                              <Camera className="h-4 w-4" />
                              {data.biometricStatus.enrolled
                                ? 'Mark Attendance (Camera)'
                                : 'Enroll Face to Mark'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent Read-Only Attendance Log */}
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900">Attendance History (Read-Only)</h3>
                    <span className="text-xs text-slate-500">Indian Standard Time (IST)</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Subject</th>
                          <th className="px-4 py-3 font-semibold">Session</th>
                          <th className="px-4 py-3 font-semibold">Timestamp (IST)</th>
                          <th className="px-4 py-3 font-semibold">Verification</th>
                          <th className="px-4 py-3 font-semibold text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {data.recentRecords.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                              No attendance records yet.
                            </td>
                          </tr>
                        ) : (
                          data.recentRecords.map((r) => (
                            <tr key={r.id}>
                              <td className="px-4 py-2.5 font-medium text-slate-900">
                                {r.subjectCode} · {r.subjectName}
                              </td>
                              <td className="px-4 py-2.5 font-mono-tabular text-slate-600">
                                {r.sessionCode}
                              </td>
                              <td className="px-4 py-2.5 font-mono-tabular text-slate-600">
                                {r.markedAtIST}
                              </td>
                              <td className="px-4 py-2.5 text-slate-600">{r.verificationMethod}</td>
                              <td className="px-4 py-2.5 text-right font-semibold">
                                <span
                                  className={
                                    r.status === 'present'
                                      ? 'text-emerald-700'
                                      : r.status === 'excused'
                                        ? 'text-blue-700'
                                        : 'text-red-700'
                                  }
                                >
                                  {r.status.toUpperCase()}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {tab === 'calendar' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-slate-600" />
                      <h3 className="text-base font-bold text-slate-900">Monthly Attendance Calendar</h3>
                    </div>
                    <input
                      type="month"
                      value={calendarMonth}
                      onChange={(e) => setCalendarMonth(e.target.value)}
                      className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-semibold text-slate-500">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                      <div key={d} className="py-1">
                        {d}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7 gap-1.5">
                    {calendarDays.map((cell, idx) =>
                      cell.day === null ? (
                        <div key={`empty-${idx}`} className="h-14 rounded-lg bg-slate-50/50" />
                      ) : (
                        <div
                          key={cell.dateStr}
                          className={`h-14 rounded-lg border p-1.5 flex flex-col justify-between text-xs ${
                            cell.status === 'present'
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                              : cell.status === 'partial'
                                ? 'border-amber-200 bg-amber-50 text-amber-900'
                                : cell.status === 'absent'
                                  ? 'border-red-200 bg-red-50 text-red-900'
                                  : 'border-slate-200 bg-white text-slate-600'
                          }`}
                        >
                          <span className="font-mono-tabular font-semibold">{cell.day}</span>
                          <span className="text-[10px] font-medium capitalize">
                            {cell.status || '-'}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>

                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <h3 className="text-base font-bold text-slate-900">Subject-Wise Attendance</h3>
                  {data.subjectWise.length === 0 ? (
                    <p className="text-xs text-slate-500">No conducted subject sessions recorded yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {data.subjectWise.map((s) => (
                        <div key={s.subjectId} className="py-3 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold text-slate-900">
                              {s.subjectCode} · {s.subjectName}
                            </div>
                            <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                              Attended {s.present} of {s.total} sessions
                            </div>
                          </div>
                          <div
                            className={`text-sm font-bold tabular-nums ${
                              s.percentage >= 75 ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {s.percentage}%
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'biometrics' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <h3 className="text-base font-bold text-slate-900">Face Biometric Enrollment & Privacy</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Your facial descriptor template is computed locally in your browser from live camera
                    frames, encrypted on the server using AES-256-GCM, and never exposed back to client
                    devices. Raw photographs are never saved.
                  </p>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-1.5">
                    <div>
                      <span className="text-slate-500">Enrollment Status:</span>{' '}
                      <span className="font-semibold text-slate-900">
                        {data.biometricStatus.enrolled ? 'Enrolled & Active' : 'Not Enrolled'}
                      </span>
                    </div>
                    {data.biometricStatus.enrolled && (
                      <>
                        <div>
                          <span className="text-slate-500">Samples Averaged:</span>{' '}
                          <span className="font-mono-tabular font-semibold">
                            {data.biometricStatus.sampleCount}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Retention Policy:</span>{' '}
                          <span className="font-mono-tabular">
                            {data.biometricStatus.retentionPolicyVersion}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      onClick={() => setCameraModal({ mode: 'enroll' })}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                    >
                      <Camera className="h-4 w-4" />
                      {data.biometricStatus.enrolled ? 'Re-Enroll Face Template' : 'Start Face Enrollment'}
                    </button>
                    {data.biometricStatus.enrolled && (
                      <button
                        type="button"
                        onClick={handleDeleteBiometrics}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-red-700 border border-red-300 rounded-lg hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete My Biometric Data
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-slate-700" />
                    <h3 className="text-base font-bold text-slate-900">Portal Password Security</h3>
                  </div>
                  <p className="text-xs text-slate-600">
                    Set or update your portal password for direct email sign-in alongside Google Sign-In.
                  </p>
                  <form onSubmit={handleUpdatePassword} className="space-y-3">
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password (min 8 characters)"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                    />
                    {pwdMsg && <p className="text-xs text-emerald-700">{pwdMsg}</p>}
                    <button
                      type="submit"
                      className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800"
                    >
                      Save Portal Password
                    </button>
                  </form>
                </div>
              </div>
            )}
          </>
        ) : null}
      </main>

      {cameraModal && (
        <CameraVerificationModal
          mode={cameraModal.mode}
          sessionId={cameraModal.sessionId}
          sessionLabel={cameraModal.sessionLabel}
          locationRequired={data?.collegeSettings?.locationVerificationEnabled ?? true}
          livenessRequired={data?.collegeSettings?.livenessRequired ?? true}
          onClose={() => setCameraModal(null)}
          onSuccess={(msg) => {
            setCameraModal(null);
            setBannerMsg(msg);
            loadDashboard();
          }}
          onRequestAssistedFallback={handleAssistedFallback}
        />
      )}
    </div>
  );
};
