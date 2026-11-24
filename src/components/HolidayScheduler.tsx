import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { apiFetch } from '../lib/api';

export interface HolidayRecord {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  createdAtIST: string;
}

export interface SessionSummaryForHoliday {
  id: string;
  sessionCode: string;
  sessionDate: string;
  status: string;
}

interface HolidaySchedulerProps {
  sessions: SessionSummaryForHoliday[];
  onNotify: (msg: string) => void;
  onError: (err: string) => void;
  onChanged: () => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateStr(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function parseYearMonth(dateStr: string): { year: number; month: number } {
  const parts = dateStr.split('-').map(Number);
  if (parts.length === 3 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return { year: parts[0], month: parts[1] - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function countInclusiveDays(startDate: string, endDate: string): number {
  const [y1, m1, d1] = startDate.split('-').map(Number);
  const [y2, m2, d2] = endDate.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  if (t2 < t1) return 0;
  return Math.round((t2 - t1) / 86400000) + 1;
}

export const HolidayScheduler: React.FC<HolidaySchedulerProps> = ({
  sessions,
  onNotify,
  onError,
  onChanged,
}) => {
  const [holidaysList, setHolidaysList] = useState<HolidayRecord[]>([]);
  const [todayIST, setTodayIST] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [viewYear, setViewYear] = useState<number>(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(() => new Date().getMonth());

  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');

  const loadHolidays = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ todayIST: string; items: HolidayRecord[] }>('/api/admin/holidays');
      setHolidaysList(res.items);
      if (res.todayIST) {
        setTodayIST(res.todayIST);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load holidays.');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

  const effectiveStart = startDate;
  const effectiveEnd = endDate || startDate;

  const calendarCells = useMemo(() => {
    const firstDayOfMonth = new Date(Date.UTC(viewYear, viewMonth, 1));
    const startWeekday = firstDayOfMonth.getUTCDay();
    const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
    const prevMonthDays = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();

    const cells: Array<{
      dateStr: string;
      dayNum: number;
      inCurrentMonth: boolean;
      weekday: number;
    }> = [];

    // Leading days from previous month
    for (let i = startWeekday - 1; i >= 0; i--) {
      const dayNum = prevMonthDays - i;
      const dt = new Date(Date.UTC(viewYear, viewMonth - 1, dayNum));
      cells.push({
        dateStr: toDateStr(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()),
        dayNum,
        inCurrentMonth: false,
        weekday: cells.length % 7,
      });
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        dateStr: toDateStr(viewYear, viewMonth, d),
        dayNum: d,
        inCurrentMonth: true,
        weekday: cells.length % 7,
      });
    }

    // Trailing days to complete 42 cells (6 rows)
    const remaining = 42 - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const dt = new Date(Date.UTC(viewYear, viewMonth + 1, d));
      cells.push({
        dateStr: toDateStr(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()),
        dayNum: d,
        inCurrentMonth: false,
        weekday: cells.length % 7,
      });
    }

    return cells;
  }, [viewYear, viewMonth]);

  const holidayMapForCell = useCallback(
    (dateStr: string): HolidayRecord | undefined => {
      return holidaysList.find((h) => dateStr >= h.startDate && dateStr <= h.endDate);
    },
    [holidaysList]
  );

  const activeSessionCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      if (s.status === 'active' || s.status === 'scheduled') {
        map.set(s.sessionDate, (map.get(s.sessionDate) ?? 0) + 1);
      }
    }
    return map;
  }, [sessions]);

  const sessionsToCancelCount = useMemo(() => {
    if (!effectiveStart) return 0;
    return sessions.filter(
      (s) =>
        (s.status === 'active' || s.status === 'scheduled') &&
        s.sessionDate >= effectiveStart &&
        s.sessionDate <= effectiveEnd
    ).length;
  }, [sessions, effectiveStart, effectiveEnd]);

  function handleDayClick(clickedDate: string) {
    if (!startDate || (startDate && endDate)) {
      setStartDate(clickedDate);
      setEndDate('');
      return;
    }
    if (clickedDate < startDate) {
      setEndDate(startDate);
      setStartDate(clickedDate);
    } else {
      setEndDate(clickedDate);
    }
  }

  function handlePrevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function handleNextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function handleJumpToday() {
    const { year, month } = parseYearMonth(todayIST);
    setViewYear(year);
    setViewMonth(month);
  }

  function applyQuickRange(offsetStart: number, offsetEnd: number, defaultTitle: string) {
    const s = addDays(todayIST, offsetStart);
    const e = addDays(todayIST, offsetEnd);
    setStartDate(s);
    setEndDate(e);
    const { year, month } = parseYearMonth(s);
    setViewYear(year);
    setViewMonth(month);
    if (!title.trim()) {
      setTitle(defaultTitle);
    }
  }

  async function handleSaveHoliday(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveStart) {
      onError('Please click on the calendar to select at least a start date.');
      return;
    }
    if (effectiveStart > effectiveEnd) {
      onError('Start date cannot be after end date.');
      return;
    }
    if (title.trim().length < 2) {
      onError('Please enter a holiday title (at least 2 characters).');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/admin/holidays', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          startDate: effectiveStart,
          endDate: effectiveEnd,
          reason: reason.trim() || undefined,
        }),
      });
      onNotify(res.message);
      setStartDate('');
      setEndDate('');
      setTitle('');
      setReason('');
      await loadHolidays();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save holiday.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteHoliday(id: string) {
    setDeletingId(id);
    try {
      const res = await apiFetch<{ message: string }>(`/api/admin/holidays/${id}`, {
        method: 'DELETE',
      });
      onNotify(res.message);
      await loadHolidays();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to remove holiday.');
    } finally {
      setDeletingId(null);
    }
  }

  const previewRangeStart =
    startDate && !endDate && hoverDate
      ? hoverDate < startDate
        ? hoverDate
        : startDate
      : effectiveStart;
  const previewRangeEnd =
    startDate && !endDate && hoverDate
      ? hoverDate < startDate
        ? startDate
        : hoverDate
      : effectiveEnd;

  const selectedDayCount = effectiveStart ? countInclusiveDays(effectiveStart, effectiveEnd) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Holiday Scheduler</h1>
          <p className="text-xs text-slate-500">
            Click start and end dates on the calendar to mark holidays or vacations · Automatically cancels scheduled/active sessions and blocks new session creation on those dates
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600 font-mono-tabular">
          <span>Today (IST): {todayIST}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-stretch">
        {/* Left 2 Columns: Interactive Monthly Calendar */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-slate-700 shrink-0" />
              <h2 className="text-base font-bold text-slate-900 tabular-nums">
                {MONTH_NAMES[viewMonth]} {viewYear}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-900 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </button>
              <button
                type="button"
                onClick={handleJumpToday}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-900 whitespace-nowrap shrink-0"
              >
                Today
              </button>
              <button
                type="button"
                onClick={handleNextMonth}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-900 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-4">
            <span>
              Selection step:{' '}
              <strong className="text-slate-800">
                {!startDate
                  ? 'Click a start date on the calendar'
                  : !endDate
                    ? 'Click an end date (or click the same date for 1 day)'
                    : 'Range selected — click any date to start a new selection'}
              </strong>
            </span>
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="grid grid-cols-7 bg-slate-50 border-b border-slate-200 text-center text-xs font-semibold text-slate-600">
              {WEEKDAYS.map((day) => (
                <div key={day} className="py-2.5 border-r last:border-r-0 border-slate-200">
                  {day}
                </div>
              ))}
            </div>

            <div
              className="grid grid-cols-7"
              onMouseLeave={() => setHoverDate(null)}
            >
              {calendarCells.map((cell) => {
                const holiday = holidayMapForCell(cell.dateStr);
                const sessionCount = activeSessionCountByDate.get(cell.dateStr) ?? 0;
                const isSunday = cell.weekday === 0;
                const isToday = cell.dateStr === todayIST;

                const isStart = Boolean(effectiveStart && cell.dateStr === effectiveStart);
                const isEnd = Boolean(effectiveEnd && cell.dateStr === effectiveEnd);
                const isInSelectedRange = Boolean(
                  previewRangeStart &&
                    previewRangeEnd &&
                    cell.dateStr >= previewRangeStart &&
                    cell.dateStr <= previewRangeEnd
                );

                let cellStyle = 'bg-white text-slate-900 hover:bg-slate-50';
                if (!cell.inCurrentMonth) {
                  cellStyle = 'bg-slate-50/70 text-slate-400 hover:bg-slate-100/80';
                }
                if (holiday && !isInSelectedRange) {
                  cellStyle = 'bg-amber-50 text-amber-950 hover:bg-amber-100/80';
                }
                if (isInSelectedRange && !isStart && !isEnd) {
                  cellStyle = 'bg-slate-200/80 text-slate-900';
                }
                if (isStart || isEnd) {
                  cellStyle = 'bg-slate-900 text-white hover:bg-slate-800';
                }

                return (
                  <button
                    key={cell.dateStr}
                    type="button"
                    onClick={() => handleDayClick(cell.dateStr)}
                    onMouseEnter={() => {
                      if (startDate && !endDate) setHoverDate(cell.dateStr);
                    }}
                    aria-label={`${cell.dateStr}${holiday ? `, Holiday: ${holiday.title}` : ''}`}
                    className={`min-h-[76px] p-2 border-b border-r border-slate-200 text-left flex flex-col justify-between transition-colors focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:z-10 ${cellStyle}`}
                  >
                    <div className="flex items-center justify-between gap-1 w-full">
                      <span
                        className={`text-xs font-mono-tabular font-semibold ${
                          isToday && !isStart && !isEnd ? 'underline decoration-2 underline-offset-4' : ''
                        }`}
                      >
                        {cell.dayNum}
                      </span>
                      {(isStart || isEnd) && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide">
                          {isStart && isEnd ? 'Day' : isStart ? 'Start' : 'End'}
                        </span>
                      )}
                      {!isStart && !isEnd && isSunday && (
                        <span className="text-[10px] text-slate-400 font-medium">Sun</span>
                      )}
                    </div>

                    <div className="space-y-0.5 w-full min-w-0">
                      {holiday && (
                        <div
                          className={`text-[10px] font-semibold truncate ${
                            isStart || isEnd ? 'text-amber-200' : 'text-amber-800'
                          }`}
                          title={`Holiday: ${holiday.title}`}
                        >
                          Holiday: {holiday.title}
                        </div>
                      )}
                      {sessionCount > 0 && (
                        <div
                          className={`text-[10px] font-mono-tabular truncate ${
                            isStart || isEnd ? 'text-slate-300' : 'text-slate-500'
                          }`}
                        >
                          {sessionCount} active/sched
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 text-xs text-slate-600 pt-1">
            <span>Selected Range: Dark Slate</span>
            <span>·</span>
            <span>Marked Holiday: Amber Highlight + Holiday Title</span>
            <span>·</span>
            <span>Today: Underlined Date</span>
          </div>
        </div>

        {/* Right Column: Holiday Form & Impact Preview */}
        <form
          onSubmit={handleSaveHoliday}
          className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4 text-xs"
        >
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Mark Date Range as Holiday</h2>
              <p className="text-slate-500 mt-0.5">
                All scheduled or active sessions within the selected dates will be cancelled immediately.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyQuickRange(1, 1, 'Tomorrow Holiday')}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Tomorrow
              </button>
              <button
                type="button"
                onClick={() => applyQuickRange(0, 2, 'Short Vacation')}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Next 3 Days
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate('');
                  setEndDate('');
                }}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Clear Dates
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-600 mb-1">Start Date</label>
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setStartDate(val);
                    if (endDate && val > endDate) {
                      setEndDate(val);
                    }
                    if (val) {
                      const { year, month } = parseYearMonth(val);
                      setViewYear(year);
                      setViewMonth(month);
                    }
                  }}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">End Date</label>
                <input
                  type="date"
                  value={endDate || startDate}
                  min={startDate || undefined}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (startDate && val < startDate) {
                      setEndDate(startDate);
                    } else {
                      setEndDate(val);
                    }
                  }}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 font-mono-tabular bg-white"
                />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
              <div className="flex items-center justify-between text-slate-700">
                <span>Selected Tenure</span>
                <span className="font-mono-tabular font-semibold">
                  {selectedDayCount > 0
                    ? `${effectiveStart} to ${effectiveEnd} (${selectedDayCount} day${selectedDayCount === 1 ? '' : 's'})`
                    : 'No dates selected'}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-700">
                <span>Sessions to Auto-Cancel</span>
                <span
                  className={`font-mono-tabular font-semibold ${
                    sessionsToCancelCount > 0 ? 'text-amber-700' : 'text-slate-700'
                  }`}
                >
                  {sessionsToCancelCount} session{sessionsToCancelCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-600 mb-1">
                Holiday / Vacation Title
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Winter Vacation or Public Holiday"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-600 mb-1">
                Optional Note / Circular Reference
              </label>
              <textarea
                rows={2}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Declared per Academic Calendar circular..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !effectiveStart}
            className="min-h-[42px] w-full px-4 py-2 font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {submitting ? 'Saving Holiday...' : 'Mark as Holiday'}
          </button>
        </form>
      </div>

      {/* Scheduled Holidays Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">
            Scheduled Holidays &amp; Vacation Tenures ({holidaysList.length})
          </h3>
          <span className="text-xs text-slate-500">
            Session creation is blocked across all listed date ranges
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">Date Range (IST)</th>
                <th className="px-4 py-3 font-semibold text-right">Days</th>
                <th className="px-4 py-3 font-semibold">Holiday Title</th>
                <th className="px-4 py-3 font-semibold">Note</th>
                <th className="px-4 py-3 font-semibold">Schedule Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Loading scheduled holidays...
                  </td>
                </tr>
              ) : holidaysList.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No holidays scheduled yet. Click start and end dates on the calendar above to mark a holiday.
                  </td>
                </tr>
              ) : (
                holidaysList.map((h) => {
                  const days = countInclusiveDays(h.startDate, h.endDate);
                  const stateLabel =
                    h.endDate < todayIST
                      ? 'Past'
                      : h.startDate <= todayIST && h.endDate >= todayIST
                        ? 'Active Today'
                        : 'Upcoming';
                  return (
                    <tr key={h.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-mono-tabular font-semibold text-slate-900 whitespace-nowrap">
                        {h.startDate === h.endDate ? h.startDate : `${h.startDate} to ${h.endDate}`}
                      </td>
                      <td className="px-4 py-3 text-right font-mono-tabular">{days}</td>
                      <td className="px-4 py-3 font-medium text-slate-900">{h.title}</td>
                      <td className="px-4 py-3 text-slate-600">{h.reason || '-'}</td>
                      <td
                        className={`px-4 py-3 font-semibold uppercase ${
                          stateLabel === 'Active Today'
                            ? 'text-amber-700'
                            : stateLabel === 'Upcoming'
                              ? 'text-emerald-700'
                              : 'text-slate-400'
                        }`}
                      >
                        {stateLabel}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={deletingId === h.id}
                          onClick={() => handleDeleteHoliday(h.id)}
                          className="inline-flex items-center gap-1 text-red-700 font-medium hover:underline disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deletingId === h.id ? 'Removing...' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
