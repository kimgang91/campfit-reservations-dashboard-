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
import {
  parseISO,
  isAfter,
  isBefore,
  isEqual,
  startOfMonth,
  endOfMonth,
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  eachWeekOfInterval,
  eachMonthOfInterval,
} from 'date-fns';

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

const COLORS = [
  '#4f46e5',
  '#22c55e',
  '#f97316',
  '#06b6d4',
  '#a855f7',
  '#e11d48',
  '#0f766e',
  '#14b8a6',
  '#f59e0b',
  '#ec4899',
];

// 로컬 스냅샷/히스토리 저장용 키
const SNAPSHOT_KEY = 'campfit_prev_snapshot_v1';
const HISTORY_KEY = 'campfit_history_v1';

type HistoryStatus = 'active' | 'churned';

interface HistoryEntry {
  status: HistoryStatus;
  everSeen: boolean;
  updatedAt: number;
}

function calculateChurn(currentNames: string[]): { lost: string[]; rejoined: string[] } {
  if (typeof window === 'undefined') return { lost: [], rejoined: [] };

  const now = Date.now();

  let prevNames: string[] = [];
  let history: Record<string, HistoryEntry> = {};

  try {
    const prevRaw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (prevRaw) prevNames = JSON.parse(prevRaw);
  } catch {
    prevNames = [];
  }

  try {
    const histRaw = window.localStorage.getItem(HISTORY_KEY);
    if (histRaw) history = JSON.parse(histRaw);
  } catch {
    history = {};
  }

  const prevSet = new Set(prevNames);
  const currSet = new Set(currentNames);

  const lost: string[] = [];
  const rejoined: string[] = [];

  // 이전에는 있었는데, 지금은 없는 캠핑장 = 이탈
  prevSet.forEach((name) => {
    if (!currSet.has(name)) {
      lost.push(name);
      const prev = history[name] || { status: 'active' as HistoryStatus, everSeen: true, updatedAt: now };
      history[name] = { status: 'churned', everSeen: true, updatedAt: now };
      if (!prev.everSeen) {
        history[name].everSeen = true;
      }
    }
  });

  // 새로 등장한 캠핑장: 신규 또는 재입점
  currSet.forEach((name) => {
    const prev = history[name];
    if (!prev) {
      // 처음 등장한 캠핑장 = 신규
      history[name] = { status: 'active', everSeen: true, updatedAt: now };
    } else if (prev.status === 'churned' && !prevSet.has(name)) {
      // 이전에 이탈 상태였다가 다시 나타난 경우 = 재입점
      rejoined.push(name);
      history[name] = { status: 'active', everSeen: true, updatedAt: now };
    } else {
      // 계속 운영 중
      history[name] = { status: 'active', everSeen: prev.everSeen, updatedAt: now };
    }
  });

  // 스냅샷/히스토리 저장
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(currentNames));
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 저장 실패는 분석 기능에만 영향, 무시
  }

  return { lost, rejoined };
}

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

function isEnded(row: CampfitPlanRecord): boolean {
  // 플랜종료일(J)은 사용하지 않고, 플랜상태(H)와 운영상태(C)로 판단
  const planStatus = row.planStatus?.toLowerCase() || '';
  const operateStatus = row.operateStatus?.toLowerCase() || '';
  
  return (
    planStatus.includes('종료') ||
    planStatus.includes('취소') ||
    operateStatus.includes('중단') ||
    operateStatus.includes('종료')
  );
}

function getBucket(date: Date, unit: PeriodUnit): string {
  if (unit === 'day') return format(date, 'yyyy-MM-dd');
  if (unit === 'month') return format(date, 'yyyy-MM');
  
  // 주별: 해당 주의 월요일 기준
  const weekStart = startOfWeek(date, { weekStartsOn: 1 });
  return format(weekStart, 'yyyy-MM-dd');
}

export default function CampfitDashboardPage() {
  const [data, setData] = useState<CampfitPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllData, setShowAllData] = useState(false);
  const [lostCampgrounds, setLostCampgrounds] = useState<string[]>([]);
  const [rejoinedCampgrounds, setRejoinedCampgrounds] = useState<string[]>([]);

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

        // 이탈/재입점 캠핑장 계산 (이전 스냅샷 대비)
        const names = rows.map((r) => r.campgroundName).filter(Boolean);
        const churn = calculateChurn(names);
        setLostCampgrounds(churn.lost);
        setRejoinedCampgrounds(churn.rejoined);
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

  // 필터링: 플랜종료일(J)은 사용하지 않고, 현재 등록된 데이터 기준으로 분석
  const filtered = useMemo(() => {
    return data.filter((row) => {
      if (mdFilter && row.md !== mdFilter) return false;
      if (planFilter && row.mainPlanName !== planFilter) return false;
      if (bundleFilter && row.bundleSubType !== bundleFilter) return false;
      if (easyFilter && row.easyCamping !== easyFilter) return false;

      // 기간 필터: 플랜등록일(I) 기준
      const s = parseDate(row.planStartDate);
      if (startDate || endDate) {
        if (!s) return false;
        return inRange(s, startDate, endDate);
      }

      return true;
    });
  }, [data, mdFilter, planFilter, bundleFilter, easyFilter, startDate, endDate]);

  // 플랜 변경 이벤트: 같은 캠핑장명(B)에 대해 세부플랜명(D)이 변경된 경우
  const planChangeEvents = useMemo(() => {
    const byCampground = new Map<string, CampfitPlanRecord[]>();
    filtered.forEach((row) => {
      const key = row.campgroundName;
      if (!byCampground.has(key)) byCampground.set(key, []);
      byCampground.get(key)!.push(row);
    });

    const events: { date: Date; md?: string; mainPlanName?: string; fromPlan?: string; toPlan?: string }[] = [];

    byCampground.forEach((rows) => {
      // 같은 캠핑장에 여러 플랜이 있으면, 시작일 순으로 정렬
      const sorted = [...rows].sort((a, b) => {
        const sa = parseDate(a.planStartDate)?.getTime() ?? 0;
        const sb = parseDate(b.planStartDate)?.getTime() ?? 0;
        return sa - sb;
      });
      
      // 이전 플랜과 현재 플랜의 세부플랜명(D)이 다르면 플랜 변경으로 판단
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevPlan = prev.detailPlanName || '';
        const currPlan = curr.detailPlanName || '';
        
        if (prevPlan && currPlan && prevPlan !== currPlan) {
          const d = parseDate(curr.planStartDate);
          if (d) {
            events.push({
              date: d,
              md: curr.md,
              mainPlanName: curr.mainPlanName,
              fromPlan: prevPlan,
              toPlan: currPlan,
            });
          }
        }
      }
    });

    return events;
  }, [filtered]);

  // 기간별 시계열 데이터 생성
  const timeSeries = useMemo<TimeSeriesPoint[]>(() => {
    const bucketMap = new Map<string, TimeSeriesPoint>();

    // 신규: 플랜등록일(I) 기준
    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      if (!s) return;
      if (startDate && isBefore(s, startDate)) return;
      if (endDate && isAfter(s, endDate)) return;

      const bucketKey = getBucket(s, periodUnit);
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          bucket: bucketKey,
          newCount: 0,
          endCount: 0,
          changeCount: 0,
          net: 0,
        });
      }
      bucketMap.get(bucketKey)!.newCount += 1;
    });

    // 종료: 플랜종료일(J) 대신 플랜상태(H)와 운영상태(C)로 판단
    filtered.forEach((row) => {
      if (!isEnded(row)) return;
      const s = parseDate(row.planStartDate);
      if (!s) return;
      // 종료된 경우, 시작일 기준으로 집계 (또는 현재 시점 기준으로 마지막으로 확인된 시점)
      const refDate = s;
      if (startDate && isBefore(refDate, startDate)) return;
      if (endDate && isAfter(refDate, endDate)) return;

      const bucketKey = getBucket(refDate, periodUnit);
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          bucket: bucketKey,
          newCount: 0,
          endCount: 0,
          changeCount: 0,
          net: 0,
        });
      }
      bucketMap.get(bucketKey)!.endCount += 1;
    });

    // 플랜 변경 이벤트
    planChangeEvents.forEach((ev) => {
      if (startDate && isBefore(ev.date, startDate)) return;
      if (endDate && isAfter(ev.date, endDate)) return;

      const bucketKey = getBucket(ev.date, periodUnit);
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, {
          bucket: bucketKey,
          newCount: 0,
          endCount: 0,
          changeCount: 0,
          net: 0,
        });
      }
      bucketMap.get(bucketKey)!.changeCount += 1;
    });

    const result = Array.from(bucketMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
    result.forEach((p) => {
      p.net = p.newCount - p.endCount;
    });
    return result;
  }, [filtered, planChangeEvents, periodUnit, startDate, endDate]);

  const referenceDate = useMemo(() => {
    if (endDate) return endDate;
    return new Date();
  }, [endDate]);

  // 총 운영 캠핑장 수: 종료되지 않은 캠핑장명(B) 기준 unique count
  const totalActiveCampgrounds = useMemo(() => {
    const activeNames = new Set<string>();
    filtered.forEach((row) => {
      if (isEnded(row)) return;
      const s = parseDate(row.planStartDate);
      if (!s) return;
      if (isBefore(s, referenceDate) || isEqual(s, referenceDate)) {
        activeNames.add(row.campgroundName);
      }
    });
    return activeNames.size;
  }, [filtered, referenceDate]);

  // 이번 달 KPI
  const thisMonthKPI = useMemo<MonthKPI>(() => {
    const start = startOfMonth(referenceDate);
    const end = endOfMonth(referenceDate);
    let newCount = 0;
    let endCount = 0;

    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      if (s && inRange(s, start, end)) {
        if (isEnded(row)) {
          endCount += 1;
        } else {
          newCount += 1;
        }
      }
    });

    const net = newCount - endCount;

    const mdMap = new Map<string, number>();
    filtered.forEach((row) => {
      const s = parseDate(row.planStartDate);
      if (!s || !inRange(s, start, end) || !row.md || isEnded(row)) return;
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

  // MD별 성과 분석
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
      if (!s) return;

      // 기간 내 신규/종료 판단
      if (inRange(s, startDate, endDate)) {
        if (isEnded(row)) {
          stat.endCount += 1;
        } else {
          stat.newCount += 1;
        }
      }

      // 현재 운영중인 플랜 수
      if (!isEnded(row) && (isBefore(s, endRef) || isEqual(s, endRef))) {
        stat.activeCount += 1;
      }
    });

    const arr = Array.from(map.values());
    arr.forEach((s) => {
      s.net = s.newCount - s.endCount;
    });
    return arr.sort((a, b) => b.newCount - a.newCount);
  }, [filtered, startDate, endDate, referenceDate]);

  // 플랜별 변화 분석
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
      if (!s) return;

      // 기간 내 신규/종료 판단
      if (inRange(s, startDate, endDate)) {
        if (isEnded(row)) {
          stat.endCount += 1;
        } else {
          stat.newCount += 1;
        }
      }

      // 현재 운영중인 플랜 수
      if (!isEnded(row) && (isBefore(s, endRef) || isEqual(s, endRef))) {
        stat.activeCount += 1;
      }
    });

    // 플랜 변경 이벤트 집계
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
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-600 border-t-transparent mx-auto mb-4" />
          <div className="text-2xl font-bold text-gray-800">캠핏 예약팀 데이터를 불러오는 중...</div>
          <div className="text-sm text-gray-500 mt-2">잠시만 기다려주세요</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 via-rose-50 to-orange-50 p-4">
        <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl border-2 border-red-200 p-8 space-y-6">
          <h1 className="text-3xl font-bold text-red-700 flex items-center gap-3">
            <span className="text-4xl">⚠️</span> 데이터 로드 오류
          </h1>
          <p className="text-base text-gray-700 whitespace-pre-wrap break-words bg-red-50 p-4 rounded-lg">
            {error}
          </p>
          <p className="text-sm text-gray-600">
            Google Sheets 공유 설정이 &quot;링크가 있는 모든 사용자(보기 가능)&quot;인지 확인해 주세요.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white text-base font-semibold hover:from-red-700 hover:to-rose-700 transition-all shadow-lg hover:shadow-xl"
          >
            🔄 다시 시도
          </button>
        </div>
      </div>
    );
  }

  const displayData = showAllData ? data : filtered;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 p-4 md:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6 md:space-y-8">
        {/* 헤더 */}
        <header className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6 md:p-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-extrabold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent mb-2">
                캠핏 예약팀 입점/플랜 현황 대시보드
              </h1>
              <p className="text-sm md:text-base text-gray-600">
                현재 스프레드시트 기준으로 운영 캠핑장, 대표 플랜, MD 성과를 요약해서 보여줍니다.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAllData(!showAllData)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                  showAllData
                    ? 'bg-indigo-600 text-white shadow-lg'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {showAllData ? '📊 필터링된 데이터 보기' : '📋 전체 데이터 보기'}
              </button>
              <div className="text-xs md:text-sm text-gray-500 bg-gray-50 px-3 py-2 rounded-lg">
                총 <span className="font-bold text-indigo-600">{data.length.toLocaleString()}</span>건
              </div>
            </div>
          </div>
        </header>

        {/* 필터 */}
        <section className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6 md:p-8">
          <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="text-2xl">🔍</span> 필터
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block mb-2 text-sm font-semibold text-gray-700">담당 MD</label>
              <select
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 text-sm"
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
              <label className="block mb-2 text-sm font-semibold text-gray-700">대표 플랜</label>
              <select
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 text-sm"
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
              <label className="block mb-2 text-sm font-semibold text-gray-700">결합형 소분류</label>
              <select
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 text-sm"
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
              <label className="block mb-2 text-sm font-semibold text-gray-700">이지캠핑</label>
              <select
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-blue-500 focus:ring-2 focus:ring-blue-200 text-sm"
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

        {/* KPI 카드 */}
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-4 md:gap-6">
          <div className="bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600 text-white rounded-3xl shadow-2xl p-6 transform hover:scale-105 transition-all">
            <div className="text-sm font-medium text-blue-100 mb-2">총 운영 캠핑장 수</div>
            <div className="text-3xl md:text-4xl font-extrabold">{totalActiveCampgrounds.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-600 text-white rounded-3xl shadow-2xl p-6 transform hover:scale-105 transition-all">
            <div className="text-sm font-medium text-emerald-100 mb-2">이번 달 신규 입점</div>
            <div className="text-3xl md:text-4xl font-extrabold">{thisMonthKPI.newCount.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-rose-500 via-rose-600 to-pink-600 text-white rounded-3xl shadow-2xl p-6 transform hover:scale-105 transition-all">
            <div className="text-sm font-medium text-rose-100 mb-2">이번 달 종료</div>
            <div className="text-3xl md:text-4xl font-extrabold">{thisMonthKPI.endCount.toLocaleString()}</div>
          </div>
          <div className="bg-gradient-to-br from-indigo-500 via-indigo-600 to-purple-600 text-white rounded-3xl shadow-2xl p-6 transform hover:scale-105 transition-all">
            <div className="text-sm font-medium text-indigo-100 mb-2">이번 달 순증감</div>
            <div className="text-3xl md:text-4xl font-extrabold">
              {thisMonthKPI.net >= 0 ? '+' : ''}
              {thisMonthKPI.net.toLocaleString()}
            </div>
          </div>
          <div className="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 text-white rounded-3xl shadow-2xl p-6 transform hover:scale-105 transition-all">
            <div className="text-sm font-medium text-amber-100 mb-2">MD별 1위</div>
            {thisMonthKPI.topMd ? (
              <>
                <div className="text-base md:text-lg font-bold truncate mb-1">{thisMonthKPI.topMd.md}</div>
                <div className="text-sm text-amber-100">신규 {thisMonthKPI.topMd.count.toLocaleString()}건</div>
              </>
            ) : (
              <div className="text-sm text-amber-100 mt-2">데이터 없음</div>
            )}
          </div>
        </section>

        {/* 차트 섹션 */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-8">
          <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6 lg:col-span-2">
            <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="text-2xl">📈</span> 기간별 신규/종료/순증감
            </h2>
            <div className="h-72 md:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: '12px',
                      padding: '12px',
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="newCount"
                    name="신규"
                    stroke="#22c55e"
                    strokeWidth={3}
                    dot={{ r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="endCount"
                    name="종료"
                    stroke="#ef4444"
                    strokeWidth={3}
                    dot={{ r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name="순증감"
                    stroke="#4f46e5"
                    strokeWidth={3}
                    dot={{ r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6">
            <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="text-2xl">🥧</span> 현재 운영 플랜 비중
            </h2>
            <div className="h-72 md:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={planStats.filter((p) => p.activeCount > 0)}
                    dataKey="activeCount"
                    nameKey="plan"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    labelLine={false}
                    label={({ plan, percent }) => `${String(plan).slice(0, 8)}: ${(percent * 100).toFixed(0)}%`}
                  >
                    {planStats
                      .filter((p) => p.activeCount > 0)
                      .map((entry, index) => (
                        <Cell key={entry.plan} fill={COLORS[index % COLORS.length]} />
                      ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: '12px',
                      padding: '12px',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8">
          <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6">
            <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="text-2xl">👤</span> MD별 신규 입점 / 순증감
            </h2>
            <div className="h-72 md:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mdStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="md" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={80} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: '12px',
                      padding: '12px',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="newCount" name="신규" fill="#22c55e" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="net" name="순증감" fill="#4f46e5" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6">
            <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              <span className="text-2xl">🧩</span> 플랜별 변화
            </h2>
            <div className="h-72 md:h-80 overflow-x-auto">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={planStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="plan" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={80} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: '12px',
                      padding: '12px',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="newCount" name="신규" fill="#22c55e" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="endCount" name="종료" fill="#ef4444" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="changeCount" name="플랜 전환" fill="#f97316" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        {/* 이탈/재입점 캠핑장 요약 */}
        <section className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6 md:p-8">
          <h2 className="text-lg md:text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="text-2xl">🚦</span> 이탈 / 재입점 캠핑장 (이전 스냅샷 대비)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-red-700">이탈 캠핑장</h3>
                <span className="px-2 py-1 rounded-full bg-red-50 text-red-700 text-xs font-semibold">
                  {lostCampgrounds.length}개
                </span>
              </div>
              {lostCampgrounds.length === 0 ? (
                <p className="text-xs text-gray-500">이전 스냅샷 대비 이탈한 캠핑장이 없습니다.</p>
              ) : (
                <ul className="max-h-40 overflow-auto text-xs text-gray-700 space-y-1 border rounded-lg p-2">
                  {lostCampgrounds.map((name) => (
                    <li key={`lost-${name}`}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-emerald-700">재입점 캠핑장</h3>
                <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold">
                  {rejoinedCampgrounds.length}개
                </span>
              </div>
              {rejoinedCampgrounds.length === 0 ? (
                <p className="text-xs text-gray-500">이전 스냅샷에서 이탈했다가 다시 입점한 캠핑장이 없습니다.</p>
              ) : (
                <ul className="max-h-40 overflow-auto text-xs text-gray-700 space-y-1 border rounded-lg p-2">
                  {rejoinedCampgrounds.map((name) => (
                    <li key={`rejoined-${name}`}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="mt-3 text-[11px] text-gray-400">
            브라우저 기준으로 직전 조회 결과와 비교해 이탈/재입점을 계산합니다. (기록은 로컬 저장소에만 보관됩니다)
          </p>
        </section>

        {/* 데이터 테이블 (전체/필터링된 데이터) */}
        <section className="bg-white/80 backdrop-blur-sm rounded-3xl shadow-xl border border-gray-200/50 p-6 md:p-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg md:text-xl font-bold text-gray-800 flex items-center gap-2">
              <span className="text-2xl">📋</span> 캠핑장 / 플랜 리스트 ({displayData.length.toLocaleString()}건)
            </h2>
            <div className="text-xs text-gray-500">
              {showAllData ? '전체 데이터' : '필터링된 데이터'}
            </div>
          </div>
          <div className="max-h-[600px] overflow-auto rounded-xl border-2 border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 text-white sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">행</th>
                  <th className="px-4 py-3 text-left font-semibold">캠핑장명</th>
                  <th className="px-4 py-3 text-left font-semibold">세부플랜명</th>
                  <th className="px-4 py-3 text-left font-semibold hidden md:table-cell">대표플랜명</th>
                  <th className="px-4 py-3 text-left font-semibold hidden lg:table-cell">결합형 소분류</th>
                  <th className="px-4 py-3 text-left font-semibold hidden lg:table-cell">이지캠핑</th>
                  <th className="px-4 py-3 text-left font-semibold hidden lg:table-cell">담당 MD</th>
                  <th className="px-4 py-3 text-left font-semibold">플랜등록일</th>
                  <th className="px-4 py-3 text-left font-semibold hidden md:table-cell">운영상태</th>
                  <th className="px-4 py-3 text-left font-semibold hidden md:table-cell">플랜상태</th>
                </tr>
              </thead>
              <tbody>
                {displayData.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                      데이터가 없습니다.
                    </td>
                  </tr>
                ) : (
                  displayData.map((row) => {
                    const isEndedRow = isEnded(row);
                    return (
                      <tr
                        key={row.rowNumber}
                        className={`border-b transition-colors ${
                          isEndedRow
                            ? 'bg-red-50/50 hover:bg-red-100/50'
                            : 'hover:bg-blue-50/50'
                        }`}
                      >
                        <td className="px-4 py-3 text-gray-500">{row.rowNumber}</td>
                        <td className="px-4 py-3 font-bold text-gray-900">{row.campgroundName}</td>
                        <td className="px-4 py-3 text-gray-800">{row.detailPlanName || '-'}</td>
                        <td className="px-4 py-3 text-gray-800 hidden md:table-cell">
                          {row.mainPlanName || '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 hidden lg:table-cell">
                          {row.bundleSubType || '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 hidden lg:table-cell">
                          {row.easyCamping || '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-800 hidden lg:table-cell">{row.md || '-'}</td>
                        <td className="px-4 py-3 text-gray-700 font-medium">
                          {row.planStartDate || '-'}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-semibold ${
                              row.operateStatus?.includes('운영') || row.operateStatus?.includes('정상')
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {row.operateStatus || '-'}
                          </span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-semibold ${
                              isEndedRow
                                ? 'bg-red-100 text-red-700'
                                : 'bg-green-100 text-green-700'
                            }`}
                          >
                            {row.planStatus || '-'}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
