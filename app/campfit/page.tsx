'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from 'recharts';
import type { CampfitPlanRecord } from '@/lib/campfitReservations';
import { parseISO, isAfter, isBefore, isEqual, startOfMonth, endOfMonth } from 'date-fns';

type PeriodUnit = 'day' | 'week' | 'month';

interface TimeSeriesPoint {
  bucket: string;
  newCount: number;
  endCount: number;
  changeCount: number;
  net: number;
}

interface MdStats {
  md: string;
  newCount: number;
  endCount: number;
  net: number;
  activeCount: number;
}

interface PlanStats {
  plan: string;
  newCount: number;
  endCount: number;
  net: number;
  activeCount: number;
  changeCount: number;
}

interface MonthKPI {
  newCount: number;
  endCount: number;
  net: number;
  topMd: { md: string; count: number } | null;
}

const COLORS = ['#4f46e5', '#22c55e', '#f97316', '#06b6d4', '#a855f7', '#e11d48', '#0f766e'];

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  try {
    return parseISO(value);
  } catch {
    return null;
  }
}

function inRange(date: Date | null, start: Date | null, end: Date | null): boolean {
  if (!date) return false;
  if (start && isBefore(date, start)) return false;
  if (end && isAfter(date, end)) return false;
  return true;
}

function getBucket(date: Date, unit: PeriodUnit): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  if (unit === 'day') return `${y}-${m}-${d}`;
  if (unit === 'month') return `${y}-${m}`;

  const day = date.getDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - diffToMonday);
  const my = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const md = String(monday.getDate()).padStart(2, '0');
  return `${my}-${mm}-${md}`;
}

export default function CampfitDashboardPage() {
  const [data, setData] = useState<CampfitPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [periodUnit, setPeriodUnit] = useState<PeriodUnit>('month');
  const [startDateStr, setStartDateStr] = useState<string | undefined>();
  const [endDateStr, setEndDateStr] = useState<string | undefined>();

  const [mdFilter, setMdFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [bundleFilter, setBundleFilter] = useState('');
  const [easyFilter, setEasyFilter] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const ts = Date.now();
        const res = await fetch(`/api/campfit-reservations?t=${ts}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API 오류 (${res.status}): ${text.slice(0, 200)}`);
        }

        const json = await res.json();
        if (json.error) {
          throw new Error(json.error);
        }

        const rows: CampfitPlanRecord[] = Array.isArray(json.data) ? json.data : [];
        setData(rows);

        if (rows.length > 0 && !startDateStr && !endDateStr) {
          const dates: Date[] = [];
          rows.forEach((r) => {
            const s = parseDate(r.planStartDate);
            const e = parseDate(r.planEndDate);
            if (s) dates.push(s);
            if (e) dates.push(e);
          });
          if (dates.length) {
            const max = dates.reduce((acc, cur) => (isAfter(cur, acc) ? cur : acc), dates[0]);
            const rangeEnd = endOfMonth(max);
            const rangeStart = startOfMonth(new Date(rangeEnd));
            rangeStart.setMonth(rangeStart.getMonth() - 2);
            const fmt = (d: Date) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
                d.getDate(),
              ).padStart(2, '0')}`;
            setStartDateStr(fmt(rangeStart));
            setEndDateStr(fmt(rangeEnd));
          }
        }
      } catch (e: any) {
        console.error(e);
        setError(e?.message || '데이터를 불러오는 중 오류가 발생했습니다.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [startDateStr, endDateStr]);

  const startDate = useMemo(() => (startDateStr ? parseDate(startDateStr) : null), [startDateStr]);
  const endDate = useMemo(() => (endDateStr ? parseDate(endDateStr) : null), [endDateStr]);

  const filtered = useMemo(() => {
    return data.filter((row) => {
      if (mdFilter && row.md !== mdFilter) return false;
      if (planFilter && row.mainPlanName !== planFilter) return false;
      if (bundleFilter && row.bundleSubType !== bundleFilter) return false;
      if (easyFilter && row.easyCamping !== easyFilter) return false;

      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);
      const hasEventInRange =
        (s && inRange(s, startDate, endDate)) || (e && inRange(e, startDate, endDate));
      if (startDate || endDate) {
        return hasEventInRange;
      }

      return true;
    });
  }, [data, mdFilter, planFilter, bundleFilter, easyFilter, startDate, endDate]);

  const planChangeEvents = useMemo(() => {
    const byCampground = new Map<string, CampfitPlanRecord[]>();
    filtered.forEach((row) => {
      const key = row.campgroundName;
      if (!byCampground.has(key)) byCampground.set(key, []);
      byCampground.get(key)!.push(row);
    });

    const events: { date: Date; md?: string; mainPlanName?: string }[] = [];

    byCampground.forEach((rows) => {
      const sorted = [...rows].sort((a, b) => {
        const sa = parseDate(a.planStartDate)?.getTime() ?? 0;
        const sb = parseDate(b.planStartDate)?.getTime() ?? 0;
        return sa - sb;
      });
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        if (prev.detailPlanName && curr.detailPlanName && prev.detailPlanName !== curr.detailPlanName) {
          const d = parseDate(curr.planStartDate);
          if (d) {
            events.push({ date: d, md: curr.md, mainPlanName: curr.mainPlanName });
          }
        }
      }
    });

    return events;
  }, [filtered]);

  const timeSeries = useMemo<TimeSeriesPoint[]>(() => {
    const bucketMap = new Map<string, TimeSeriesPoint>();

    const addEvent = (date: Date | null, key: 'newCount' | 'endCount' | 'changeCount') => {
      if (!date) return;
      if (startDate && isBefore(date, startDate)) return;
      if (endDate && isAfter(date, endDate)) return;

      const bucketKey = getBucket(date, periodUnit);
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          bucket: bucketKey,
          newCount: 0,
          endCount: 0,
          changeCount: 0,
          net: 0,
        });
      }
      const point = bucketMap.get(bucketKey)!;
      point[key] += 1;
    };

    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);
      if (s) addEvent(s, 'newCount');
      if (e) addEvent(e, 'endCount');
    });

    planChangeEvents.forEach((ev) => {
      addEvent(ev.date, 'changeCount');
    });

    const result = Array.from(bucketMap.values()).sort((a, b) =>
      a.bucket.localeCompare(b.bucket),
    );
    result.forEach((p) => {
      p.net = p.newCount - p.endCount;
    });
    return result;
  }, [filtered, planChangeEvents, periodUnit, startDate, endDate]);

  const referenceDate = useMemo(() => {
    if (endDate) return endDate;
    return new Date();
  }, [endDate]);

  const totalActiveCampgrounds = useMemo(() => {
    const activeNames = new Set<string>();
    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);
      const isActive =
        s &&
        (isBefore(s, referenceDate) || isEqual(s, referenceDate)) &&
        (!e || isAfter(e, referenceDate));
      if (isActive) activeNames.add(row.campgroundName);
    });
    return activeNames.size;
  }, [filtered, referenceDate]);

  const thisMonthKPI = useMemo<MonthKPI>(() => {
    const start = startOfMonth(referenceDate);
    const end = endOfMonth(referenceDate);
    let newCount = 0;
    let endCount = 0;

    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);
      if (s && inRange(s, start, end)) newCount += 1;
      if (e && inRange(e, start, end)) endCount += 1;
    });

    const net = newCount - endCount;

    const mdMap = new Map<string, number>();
    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      if (!s || !inRange(s, start, end) || !row.md) return;
      mdMap.set(row.md, (mdMap.get(row.md) ?? 0) + 1);
    });
    let topMd: { md: string; count: number } | null = null;
    mdMap.forEach((count, md) => {
      if (!topMd || count > topMd.count) {
        topMd = { md, count };
      }
    });

    return { newCount, endCount, net, topMd };
  }, [filtered, referenceDate]);

  const mdStats = useMemo<MdStats[]>(() => {
    const map = new Map<string, MdStats>();
    const endRef = referenceDate;

    filtered.forEach((row) => {
      const md = row.md || '미지정';
      if (!map.has(md)) {
        map.set(md, { md, newCount: 0, endCount: 0, net: 0, activeCount: 0 });
      }
      const stat = map.get(md)!;

      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);

      if (s && inRange(s, startDate, endDate)) stat.newCount += 1;
      if (e && inRange(e, startDate, endDate)) stat.endCount += 1;

      const isActive =
        s &&
        (isBefore(s, endRef) || isEqual(s, endRef)) &&
        (!e || isAfter(e, endRef));
      if (isActive) stat.activeCount += 1;
    });

    const arr = Array.from(map.values());
    arr.forEach((s) => {
      s.net = s.newCount - s.endCount;
    });
    return arr.sort((a, b) => b.newCount - a.newCount);
  }, [filtered, startDate, endDate, referenceDate]);

  const planStats = useMemo<PlanStats[]>(() => {
    const map = new Map<string, PlanStats>();
    const endRef = referenceDate;

    filtered.forEach((row) => {
      const plan = row.mainPlanName || '미지정';
      if (!map.has(plan)) {
        map.set(plan, {
          plan,
          newCount: 0,
          endCount: 0,
          net: 0,
          activeCount: 0,
          changeCount: 0,
        });
      }
      const stat = map.get(plan)!;

      const s = parseDate(row.planStartDate);
      const e = parseDate(row.planEndDate);

      if (s && inRange(s, startDate, endDate)) stat.newCount += 1;
      if (e && inRange(e, startDate, endDate)) stat.endCount += 1;

      const isActive =
        s &&
        (isBefore(s, endRef) || isEqual(s, endRef)) &&
        (!e || isAfter(e, endRef));
      if (isActive) stat.activeCount += 1;
    });

    planChangeEvents.forEach((ev) => {
      if (!inRange(ev.date, startDate, endDate)) return;
      const plan = ev.mainPlanName || '미지정';
      if (!map.has(plan)) {
        map.set(plan, {
          plan,
          newCount: 0,
          endCount: 0,
          net: 0,
          activeCount: 0,
          changeCount: 0,
        });
      }
      map.get(plan)!.changeCount += 1;
    });

    const arr = Array.from(map.values());
    arr.forEach((s) => {
      s.net = s.newCount - s.endCount;
    });
    return arr.sort((a, b) => b.activeCount - a.activeCount);
  }, [filtered, startDate, endDate, referenceDate, planChangeEvents]);

  const mdOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => {
      if (r.md) set.add(r.md);
    });
    return Array.from(set).sort();
  }, [data]);

  const planOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => {
      if (r.mainPlanName) set.add(r.mainPlanName);
    });
    return Array.from(set).sort();
  }, [data]);

  const bundleOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => {
      if (r.bundleSubType) set.add(r.bundleSubType);
    });
    return Array.from(set).sort();
  }, [data]);

  const easyOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => {
      if (r.easyCamping) set.add(r.easyCamping);
    });
    return Array.from(set).sort();
  }, [data]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600 mx-auto mb-4" />
          <div className="text-xl font-semibold text-gray-700">캠핏 예약팀 데이터를 불러오는 중...</div>
          <div className="text-sm text-gray-500 mt-2">잠시만 기다려주세요</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 via-rose-50 to-orange-50 p-4">
        <div className="max-w-xl w-full bg-white rounded-2xl shadow-xl border border-red-100 p-6 space-y-4">
          <h1 className="text-2xl font-bold text-red-700 flex items-center gap-2">
            <span>⚠️</span> 데이터 로드 오류
          </h1>
          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{error}</p>
          <p className="text-xs text-gray-500">
            Google Sheets 공유 설정이 &quot;링크가 있는 모든 사용자(보기 가능)&quot;인지 확인해 주세요.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6 md:space-y-8">
        <header className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6">
          <h1 className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-2">
            캠핏 예약팀 입점/플랜 현황 대시보드
          </h1>
          <p className="text-sm md:text-base text-gray-600">
            입점 현황, 플랜 변화, MD 성과를 일/주/월 단위로 분석하는 대시보드입니다.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 items-center">
            <div className="flex gap-2 text-xs md:text-sm">
              <button
                onClick={() => setPeriodUnit('day')}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium ${
                  periodUnit === 'day'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300'
                }`}
              >
                일별
              </button>
              <button
                onClick={() => setPeriodUnit('week')}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium ${
                  periodUnit === 'week'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300'
                }`}
              >
                주별
              </button>
              <button
                onClick={() => setPeriodUnit('month')}
                className={`px-3 py-1.5 rounded-full border text-xs font-medium ${
                  periodUnit === 'month'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300'
                }`}
              >
                월별
              </button>
            </div>
            <div className="flex flex-wrap gap-2 items-center text-xs md:text-sm">
              <span className="text-gray-600 font-medium">기간</span>
              <input
                type="date"
                value={startDateStr || ''}
                onChange={(e) => setStartDateStr(e.target.value || undefined)}
                className="px-2 py-1 rounded-lg border border-gray-300 text-xs"
              />
              <span className="text-gray-500">~</span>
              <input
                type="date"
                value={endDateStr || ''}
                onChange={(e) => setEndDateStr(e.target.value || undefined)}
                className="px-2 py-1 rounded-lg border border-gray-300 text-xs"
              />
            </div>
            <div className="ml-auto text-xs text-gray-500">
              총 레코드: <span className="font-semibold">{data.length.toLocaleString()}</span>건
            </div>
          </div>
        </header>

        <section className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 space-y-4">
          <h2 className="text-base md:text-lg font-bold text-gray-800 flex items-center gap-2">
            <span>🔍</span> 필터
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 text-xs md:text-sm">
            <div>
              <label className="block mb-1 text-gray-700 font-medium">담당 MD</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                value={mdFilter}
                onChange={(e) => setMdFilter(e.target.value)}
              >
                <option value="">전체</option>
                {mdOptions.map((md) => (
                  <option key={md} value={md}>
                    {md}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1 text-gray-700 font-medium">대표 플랜</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value)}
              >
                <option value="">전체</option>
                {planOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1 text-gray-700 font-medium">결합형 소분류</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                value={bundleFilter}
                onChange={(e) => setBundleFilter(e.target.value)}
              >
                <option value="">전체</option>
                {bundleOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1 text-gray-700 font-medium">이지캠핑</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                value={easyFilter}
                onChange={(e) => setEasyFilter(e.target.value)}
              >
                <option value="">전체</option>
                {easyOptions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3 md:gap-4">
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-2xl shadow-lg p-4">
            <div className="text-xs font-medium text-blue-100 mb-1">총 운영 캠핑장 수</div>
            <div className="text-2xl md:text-3xl font-bold">{totalActiveCampgrounds.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 text-white rounded-2xl shadow-lg p-4">
            <div className="text-xs font-medium text-emerald-100 mb-1">이번 달 신규 입점</div>
            <div className="text-2xl md:text-3xl font-bold">
              {thisMonthKPI.newCount.toLocaleString()}
            </div>
          </div>
          <div className="bg-gradient-to-br from-rose-500 to-rose-600 text-white rounded-2xl shadow-lg p-4">
            <div className="text-xs font-medium text-rose-100 mb-1">이번 달 종료</div>
            <div className="text-2xl md:text-3xl font-bold">
              {thisMonthKPI.endCount.toLocaleString()}
            </div>
          </div>
          <div className="bg-gradient-to-br from-indigo-500 to-indigo-600 text-white rounded-2xl shadow-lg p-4">
            <div className="text-xs font-medium text-indigo-100 mb-1">이번 달 순증감</div>
            <div className="text-2xl md:text-3xl font-bold">
              {thisMonthKPI.net >= 0 ? '+' : ''}
              {thisMonthKPI.net.toLocaleString()}
            </div>
          </div>
          <div className="bg-gradient-to-br from-amber-500 to-amber-600 text-white rounded-2xl shadow-lg p-4">
            <div className="text-xs font-medium text-amber-100 mb-1">MD별 1위</div>
            {thisMonthKPI.topMd ? (
              <>
                <div className="text-sm md:text-base font-semibold truncate">
                  {thisMonthKPI.topMd?.md}
                </div>
                <div className="text-xs md:text-sm text-amber-100 mt-1">
                  신규 {thisMonthKPI.topMd?.count.toLocaleString()}건
                </div>
              </>
            ) : (
              <div className="text-sm text-amber-100 mt-1">데이터 없음</div>
            )}
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 lg:col-span-2">
            <h2 className="text-sm md:text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span>📈</span> 기간별 신규/종료/순증감
            </h2>
            <div className="h-60 md:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="newCount"
                    name="신규"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="endCount"
                    name="종료"
                    stroke="#ef4444"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="순증감"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4">
            <h2 className="text-sm md:text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span>🥧</span> 현재 운영 플랜 비중 (대표플랜 기준)
            </h2>
            <div className="h-60 md:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={planStats.filter((p) => p.activeCount > 0)}
                    dataKey="activeCount"
                    nameKey="plan"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    labelLine={false}
                    label={({ plan, percent }) =>
                      `${String(plan).slice(0, 6)}: ${(percent * 100).toFixed(0)}%`
                    }
                  >
                    {planStats
                      .filter((p) => p.activeCount > 0)
                      .map((entry, index) => (
                        <Cell key={entry.plan} fill={COLORS[index % COLORS.length]} />
                      ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4">
            <h2 className="text-sm md:text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span>👤</span> MD별 신규 입점 / 순증감
            </h2>
            <div className="h-60 md:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mdStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="md" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="newCount" name="신규" fill="#22c55e" />
                  <Bar dataKey="net" name="순증감" fill="#4f46e5" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4">
            <h2 className="text-sm md:text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span>🧩</span> 플랜별 변화 (대표플랜 기준)
            </h2>
            <div className="h-60 md:h-72 overflow-x-auto">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={planStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="plan" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="newCount" name="신규" fill="#22c55e" />
                  <Bar dataKey="endCount" name="종료" fill="#ef4444" />
                  <Bar dataKey="changeCount" name="플랜 전환" fill="#f97316" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6">
          <h2 className="text-sm md:text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
            <span>📋</span> 캠핑장 / 플랜 리스트 ({filtered.length.toLocaleString()}건)
          </h2>
          <div className="max-h-96 overflow-auto text-xs md:text-sm">
            <table className="min-w-full">
              <thead className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white sticky top-0">
                <tr>
                  <th className="px-2 py-2 text-left">행</th>
                  <th className="px-2 py-2 text-left">캠핑장명</th>
                  <th className="px-2 py-2 text-left">세부플랜명</th>
                  <th className="px-2 py-2 text-left hidden md:table-cell">대표플랜명</th>
                  <th className="px-2 py-2 text-left hidden lg:table-cell">담당 MD</th>
                  <th className="px-2 py-2 text-left">시작일</th>
                  <th className="px-2 py-2 text-left">종료일</th>
                  <th className="px-2 py-2 text-left hidden lg:table-cell">플랜상태</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.rowNumber} className="border-b hover:bg-blue-50">
                    <td className="px-2 py-1 text-gray-500">{row.rowNumber}</td>
                    <td className="px-2 py-1 font-semibold text-gray-900">{row.campgroundName}</td>
                    <td className="px-2 py-1 text-gray-800">{row.detailPlanName || '-'}</td>
                    <td className="px-2 py-1 text-gray-800 hidden md:table-cell">
                      {row.mainPlanName || '-'}
                    </td>
                    <td className="px-2 py-1 text-gray-800 hidden lg:table-cell">{row.md || '-'}</td>
                    <td className="px-2 py-1 text-gray-700">{row.planStartDate || '-'}</td>
                    <td className="px-2 py-1 text-gray-700">{row.planEndDate || '-'}</td>
                    <td className="px-2 py-1 text-gray-700 hidden lg:table-cell">
                      {row.planStatus || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

