'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  isBefore,
  isAfter,
  addDays,
  getISOWeek,
} from 'date-fns';

// ─── 색상 팔레트 ───
const COLORS = [
  '#4f46e5', '#22c55e', '#f97316', '#06b6d4', '#a855f7',
  '#e11d48', '#0f766e', '#14b8a6', '#f59e0b', '#ec4899',
  '#6366f1', '#84cc16', '#fb923c', '#2dd4bf', '#c084fc',
];

type TabKey = 'overview' | 'changes' | 'md';
type PeriodType = 'week' | 'month';

// ─── 이력 타입 ───
interface HistoryRecord {
  date: string;
  campground: string;
  type: string;
  md: string;
  note: string;
}

// ─── localStorage 폴백용 ───
const LS_SNAPSHOT_KEY = 'campfit_prev_snapshot_v3';
const LS_HISTORY_KEY = 'campfit_history_v3';

function localCalculateChurn(currentNames: string[]): { lost: string[]; rejoined: string[]; newlyFound: string[] } {
  if (typeof window === 'undefined') return { lost: [], rejoined: [], newlyFound: [] };

  let prevNames: string[] = [];
  let everChurned: string[] = [];

  try {
    const raw = window.localStorage.getItem(LS_SNAPSHOT_KEY);
    if (raw) prevNames = JSON.parse(raw);
  } catch { prevNames = []; }

  try {
    const raw = window.localStorage.getItem(LS_HISTORY_KEY);
    if (raw) everChurned = JSON.parse(raw);
  } catch { everChurned = []; }

  const prevSet = new Set(prevNames);
  const currSet = new Set(currentNames);
  const churnedSet = new Set(everChurned);

  const lost: string[] = [];
  const rejoined: string[] = [];
  const newlyFound: string[] = [];

  prevSet.forEach((name) => {
    if (!currSet.has(name)) {
      lost.push(name);
      churnedSet.add(name);
    }
  });

  currSet.forEach((name) => {
    if (!prevSet.has(name)) {
      if (churnedSet.has(name)) {
        rejoined.push(name);
      } else if (prevNames.length > 0) {
        newlyFound.push(name);
      }
    }
  });

  try {
    window.localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(currentNames));
    window.localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([...churnedSet]));
  } catch {}

  return { lost, rejoined, newlyFound };
}

// ─── 유틸리티 ───
function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  try { return parseISO(value); } catch { return null; }
}

function isEnded(row: CampfitPlanRecord): boolean {
  const ps = row.planStatus?.trim() || '';
  const os = row.operateStatus?.trim() || '';
  return ps.includes('종료') || ps.includes('취소') || os.includes('중단') || os.includes('종료');
}

function dateInRange(d: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return !isBefore(d, rangeStart) && !isAfter(d, rangeEnd);
}

function getWeekKey(d: Date): string {
  return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

function getMonthKey(d: Date): string {
  return format(d, 'yyyy-MM');
}

function getWeekLabel(mondayStr: string): string {
  const monday = parseISO(mondayStr);
  const sunday = addDays(monday, 6);
  const weekNum = getISOWeek(monday);
  const monthNum = monday.getMonth() + 1;
  return `${monthNum}월 ${weekNum}주차 (${format(monday, 'MM.dd')}~${format(sunday, 'MM.dd')})`;
}

function getMonthLabel(monthKey: string): string {
  const d = parseISO(monthKey + '-01');
  return format(d, 'yyyy년 M월');
}

function getPeriodRange(periodType: PeriodType, periodValue: string): { start: Date; end: Date } {
  if (periodType === 'week') {
    const monday = parseISO(periodValue);
    return { start: monday, end: endOfWeek(monday, { weekStartsOn: 1 }) };
  } else {
    const d = parseISO(periodValue + '-01');
    return { start: startOfMonth(d), end: endOfMonth(d) };
  }
}

// ─── 메인 컴포넌트 ───
export default function CampfitDashboardPage() {
  const [data, setData] = useState<CampfitPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // 이탈/재입점/신규발견 (서버 또는 localStorage 기반)
  const [lostCampgrounds, setLostCampgrounds] = useState<string[]>([]);
  const [rejoinedCampgrounds, setRejoinedCampgrounds] = useState<string[]>([]);
  const [newlyFoundCampgrounds, setNewlyFoundCampgrounds] = useState<string[]>([]);
  const [historyConfigured, setHistoryConfigured] = useState<boolean | null>(null);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);

  // 기간 선택
  const [changesPeriodType, setChangesPeriodType] = useState<PeriodType>('month');
  const [changesPeriodValue, setChangesPeriodValue] = useState<string>('');
  const [mdPeriodType, setMdPeriodType] = useState<PeriodType>('month');
  const [mdPeriodValue, setMdPeriodValue] = useState<string>('');

  const now = new Date();

  // ─── 데이터 로드 + 이력 비교 ───
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // 1) 시트 데이터
      const ts = Date.now();
      const res = await fetch(`/api/campfit-reservations?t=${ts}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      });
      if (!res.ok) throw new Error(`API 오류 (${res.status})`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);

      const rows: CampfitPlanRecord[] = Array.isArray(json.data) ? json.data : [];
      setData(rows);

      // 2) 고유 캠핑장명 + MD 매핑
      const uniqueNames = [...new Set(rows.map((r) => r.campgroundName).filter(Boolean))];
      const mdMap: Record<string, string> = {};
      rows.forEach((r) => {
        if (r.campgroundName && r.md && !mdMap[r.campgroundName]) {
          mdMap[r.campgroundName] = r.md;
        }
      });

      // 3) 서버 이력 연동 시도
      try {
        const histRes = await fetch('/api/campfit-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentNames: uniqueNames, mdMap }),
        });
        const histJson = await histRes.json();

        if (histJson.configured) {
          setHistoryConfigured(true);
          setLostCampgrounds(histJson.lost || []);
          setRejoinedCampgrounds(histJson.rejoined || []);
          setNewlyFoundCampgrounds(histJson.newlyFound || []);

          // 이력 전체도 가져오기
          const getRes = await fetch('/api/campfit-history');
          const getJson = await getRes.json();
          if (getJson.history) setHistoryRecords(getJson.history);
        } else {
          // 서비스 계정 미설정 → localStorage 폴백
          setHistoryConfigured(false);
          const local = localCalculateChurn(uniqueNames);
          setLostCampgrounds(local.lost);
          setRejoinedCampgrounds(local.rejoined);
          setNewlyFoundCampgrounds(local.newlyFound);
        }
      } catch {
        // API 오류 → localStorage 폴백
        setHistoryConfigured(false);
        const local = localCalculateChurn(uniqueNames);
        setLostCampgrounds(local.lost);
        setRejoinedCampgrounds(local.rejoined);
        setNewlyFoundCampgrounds(local.newlyFound);
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || '데이터를 불러오는 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ─── 기간 옵션 ───
  const allDates = useMemo(() => {
    const dates: Date[] = [];
    data.forEach((r) => { const d = parseDate(r.planStartDate); if (d) dates.push(d); });
    return dates;
  }, [data]);

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    allDates.forEach((d) => set.add(getMonthKey(d)));
    return [...set].sort().reverse();
  }, [allDates]);

  const availableWeeks = useMemo(() => {
    const set = new Set<string>();
    allDates.forEach((d) => set.add(getWeekKey(d)));
    return [...set].sort().reverse();
  }, [allDates]);

  useEffect(() => {
    if (data.length > 0) {
      const curMonth = getMonthKey(now);
      if (!changesPeriodValue) setChangesPeriodValue(availableMonths.includes(curMonth) ? curMonth : availableMonths[0] || curMonth);
      if (!mdPeriodValue) setMdPeriodValue(availableMonths.includes(curMonth) ? curMonth : availableMonths[0] || curMonth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ─── 전체 현황 집계 ───
  const totalRecords = data.length;
  const totalCampgrounds = useMemo(() => new Set(data.map((r) => r.campgroundName)).size, [data]);
  const { activeRecords, endedRecords } = useMemo(() => {
    let active = 0, ended = 0;
    data.forEach((r) => { if (isEnded(r)) ended++; else active++; });
    return { activeRecords: active, endedRecords: ended };
  }, [data]);

  const operateStatusStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => { const k = r.operateStatus?.trim() || '미기재'; map.set(k, (map.get(k) ?? 0) + 1); });
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  const planStatusStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => { const k = r.planStatus?.trim() || '미기재'; map.set(k, (map.get(k) ?? 0) + 1); });
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  const planDistribution = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => { const k = r.mainPlanName?.trim() || '미지정'; map.set(k, (map.get(k) ?? 0) + 1); });
    return [...map.entries()].map(([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  // ──────────────────────────────────────────────
  // ★ 핵심: 캠핑장별 최초 등록일 (신규 vs 플랜변경 구분 기준)
  // ──────────────────────────────────────────────
  const campgroundFirstDate = useMemo(() => {
    const map = new Map<string, Date>();
    data.forEach((r) => {
      const d = parseDate(r.planStartDate);
      if (!d) return;
      const existing = map.get(r.campgroundName);
      if (!existing || isBefore(d, existing)) {
        map.set(r.campgroundName, d);
      }
    });
    return map;
  }, [data]);

  // ─── 신규/이탈/변경 현황 ───
  const changesRange = useMemo(() => {
    if (!changesPeriodValue) return null;
    return getPeriodRange(changesPeriodType, changesPeriodValue);
  }, [changesPeriodType, changesPeriodValue]);

  const changesPeriodLabel = useMemo(() => {
    if (!changesPeriodValue) return '';
    return changesPeriodType === 'week' ? getWeekLabel(changesPeriodValue) : getMonthLabel(changesPeriodValue);
  }, [changesPeriodType, changesPeriodValue]);

  // ★ 진짜 신규 입점: 캠핑장의 "시트 내 최초 등록일"이 해당 기간인 캠핑장
  const periodTrueNew = useMemo(() => {
    if (!changesRange) return [];
    const newCampgrounds = new Set<string>();
    campgroundFirstDate.forEach((firstDate, name) => {
      if (dateInRange(firstDate, changesRange.start, changesRange.end)) {
        newCampgrounds.add(name);
      }
    });
    // 해당 캠핑장의 모든 레코드 반환 (기간 내)
    return data.filter((r) => {
      if (!newCampgrounds.has(r.campgroundName)) return false;
      const d = parseDate(r.planStartDate);
      return d ? dateInRange(d, changesRange.start, changesRange.end) : false;
    });
  }, [data, campgroundFirstDate, changesRange]);

  // 신규 입점 캠핑장 수 (고유)
  const periodTrueNewCampgrounds = useMemo(() => {
    return [...new Set(periodTrueNew.map((r) => r.campgroundName))];
  }, [periodTrueNew]);

  // ★ 플랜 변경: 기존 캠핑장(최초등록일이 기간 이전)이 해당 기간에 새 플랜을 등록
  const periodPlanChanges = useMemo(() => {
    if (!changesRange) return [];
    return data.filter((r) => {
      const d = parseDate(r.planStartDate);
      if (!d || !dateInRange(d, changesRange.start, changesRange.end)) return false;
      // 이 캠핑장의 최초 등록일이 이 기간 이전 = 기존 캠핑장
      const firstDate = campgroundFirstDate.get(r.campgroundName);
      if (!firstDate) return false;
      return isBefore(firstDate, changesRange.start);
    });
  }, [data, campgroundFirstDate, changesRange]);

  // 플랜변경 캠핑장 수 (고유)
  const periodPlanChangeCampgrounds = useMemo(() => {
    return [...new Set(periodPlanChanges.map((r) => r.campgroundName))];
  }, [periodPlanChanges]);

  // 추이 차트
  const newTrend = useMemo(() => {
    // 캠핑장별 최초등록일 기준으로 월/주별 집계
    const map = new Map<string, number>();
    campgroundFirstDate.forEach((firstDate) => {
      const key = changesPeriodType === 'week' ? getWeekKey(firstDate) : getMonthKey(firstDate);
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([period, count]) => ({
        period,
        label: changesPeriodType === 'week' ? format(parseISO(period), 'MM.dd') + '~' : period,
        count,
      }))
      .sort((a, b) => a.period.localeCompare(b.period))
      .slice(-12);
  }, [campgroundFirstDate, changesPeriodType]);

  // ─── MD별 현황 ───
  const mdRange = useMemo(() => {
    if (!mdPeriodValue) return null;
    return getPeriodRange(mdPeriodType, mdPeriodValue);
  }, [mdPeriodType, mdPeriodValue]);

  const mdPeriodLabel = useMemo(() => {
    if (!mdPeriodValue) return '';
    return mdPeriodType === 'week' ? getWeekLabel(mdPeriodValue) : getMonthLabel(mdPeriodValue);
  }, [mdPeriodType, mdPeriodValue]);

  const mdOverview = useMemo(() => {
    const map = new Map<string, {
      md: string; totalCount: number; activeCount: number; endedCount: number;
      periodTrueNew: number; periodPlanChange: number;
      campgrounds: Set<string>;
    }>();

    data.forEach((r) => {
      const md = r.md?.trim() || '미지정';
      if (!map.has(md)) {
        map.set(md, { md, totalCount: 0, activeCount: 0, endedCount: 0, periodTrueNew: 0, periodPlanChange: 0, campgrounds: new Set() });
      }
      const stat = map.get(md)!;
      stat.totalCount += 1;
      stat.campgrounds.add(r.campgroundName);
      if (isEnded(r)) stat.endedCount += 1;
      else stat.activeCount += 1;

      // 기간 내 신규 입점 판단 (최초등록일이 기간 내)
      if (mdRange) {
        const firstDate = campgroundFirstDate.get(r.campgroundName);
        const d = parseDate(r.planStartDate);
        if (d && firstDate && dateInRange(d, mdRange.start, mdRange.end)) {
          if (dateInRange(firstDate, mdRange.start, mdRange.end)) {
            stat.periodTrueNew += 1; // 진짜 신규
          } else if (isBefore(firstDate, mdRange.start)) {
            stat.periodPlanChange += 1; // 플랜 변경
          }
        }
      }
    });

    return [...map.values()]
      .map((s) => ({
        md: s.md,
        totalCount: s.totalCount,
        activeCount: s.activeCount,
        endedCount: s.endedCount,
        periodTrueNew: s.periodTrueNew,
        periodPlanChange: s.periodPlanChange,
        campgroundCount: s.campgrounds.size,
      }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [data, mdRange, campgroundFirstDate]);

  const mdNewChart = useMemo(() => {
    return mdOverview.filter((m) => m.periodTrueNew > 0).sort((a, b) => b.periodTrueNew - a.periodTrueNew).slice(0, 10);
  }, [mdOverview]);

  const topMd = useMemo(() => {
    if (mdOverview.length === 0) return null;
    return [...mdOverview].sort((a, b) => b.periodTrueNew - a.periodTrueNew)[0];
  }, [mdOverview]);

  // ─── 로딩/에러 ───
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-600 border-t-transparent mx-auto mb-4" />
          <div className="text-2xl font-bold text-gray-800">캠핏 예약팀 데이터를 불러오는 중...</div>
          <div className="text-sm text-gray-500 mt-2">Google Sheets에서 최신 데이터를 가져오고 있습니다</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 via-rose-50 to-orange-50 p-4">
        <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl border-2 border-red-200 p-8 space-y-6">
          <h1 className="text-3xl font-bold text-red-700 flex items-center gap-3">⚠️ 데이터 로드 오류</h1>
          <p className="text-base text-gray-700 whitespace-pre-wrap break-words bg-red-50 p-4 rounded-lg">{error}</p>
          <button onClick={() => window.location.reload()} className="px-6 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-semibold">
            🔄 다시 시도
          </button>
        </div>
      </div>
    );
  }

  // ─── 렌더링 ───
  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: '운영 현황', icon: '📊' },
    { key: 'changes', label: '신규 / 이탈 / 변경', icon: '📈' },
    { key: 'md', label: 'MD별 현황', icon: '👤' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* ─── 헤더 ─── */}
      <header className="bg-white/90 backdrop-blur-md border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent">
                캠핏 예약팀 대시보드
              </h1>
              <p className="text-xs md:text-sm text-gray-500 mt-1">
                Google Sheets 실시간 연동 · {format(now, 'yyyy.MM.dd HH:mm')}
                {historyConfigured === true && <span className="ml-2 text-emerald-600 font-semibold">✅ 이력관리 활성</span>}
                {historyConfigured === false && <span className="ml-2 text-amber-600 font-semibold">⚠️ 이력: 브라우저 저장</span>}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={fetchData} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-all shadow-lg flex items-center gap-2">
                🔄 새로고침
              </button>
              <div className="bg-indigo-50 text-indigo-700 px-3 py-2 rounded-lg text-sm font-bold">
                시트 전체 {totalRecords.toLocaleString()}건
              </div>
            </div>
          </div>
          <nav className="mt-4 flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                  activeTab === tab.key
                    ? 'bg-indigo-600 text-white shadow-lg'
                    : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-6">

        {/* ═══ 탭 1: 운영 현황 ═══ */}
        {activeTab === 'overview' && (
          <>
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard label="전체 등록 건수" value={totalRecords.toLocaleString()} sub="시트 전체 행 수" gradient="from-blue-500 to-indigo-600" />
              <KPICard label="등록 캠핑장 수" value={totalCampgrounds.toLocaleString()} sub="고유 캠핑장명 기준" gradient="from-emerald-500 to-teal-600" />
              <KPICard label="정상 운영" value={activeRecords.toLocaleString()} sub={`전체의 ${totalRecords ? ((activeRecords / totalRecords) * 100).toFixed(1) : 0}%`} gradient="from-cyan-500 to-blue-600" />
              <KPICard label="종료 / 취소" value={endedRecords.toLocaleString()} sub={`전체의 ${totalRecords ? ((endedRecords / totalRecords) * 100).toFixed(1) : 0}%`} gradient="from-rose-500 to-pink-600" />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">📋 대표플랜별 등록 현황</h2>
                <div className="max-h-[400px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-3 font-semibold text-gray-700">대표플랜</th>
                        <th className="text-right px-4 py-3 font-semibold text-gray-700">등록 수</th>
                        <th className="text-right px-4 py-3 font-semibold text-gray-700">비율</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planDistribution.map((item, i) => (
                        <tr key={item.plan} className="border-t border-gray-100 hover:bg-blue-50/50">
                          <td className="px-4 py-3 font-medium text-gray-800 flex items-center gap-2">
                            <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                            {item.plan}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">{item.count.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{totalRecords ? ((item.count / totalRecords) * 100).toFixed(1) : 0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🥧 대표플랜 비율</h2>
                <div className="h-[400px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={planDistribution} dataKey="count" nameKey="plan" cx="50%" cy="50%" innerRadius={60} outerRadius={120} paddingAngle={2}
                        label={({ plan, percent }) => `${String(plan).length > 8 ? String(plan).slice(0, 8) + '…' : plan} ${(percent * 100).toFixed(0)}%`}
                        labelLine>
                        {planDistribution.map((_, i) => (<Cell key={i} fill={COLORS[i % COLORS.length]} />))}
                      </Pie>
                      <Tooltip formatter={(value: number) => [value.toLocaleString() + '건', '등록 수']} contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <StatusTable title="🏢 운영상태별 분포" data={operateStatusStats} total={totalRecords} />
              <StatusTable title="📄 플랜상태별 분포" data={planStatusStats} total={totalRecords} />
            </section>

            <DataTable data={data} title="전체 캠핑장 / 플랜 리스트" />
          </>
        )}

        {/* ═══ 탭 2: 신규 / 이탈 / 변경 ═══ */}
        {activeTab === 'changes' && (
          <>
            <PeriodSelector
              periodType={changesPeriodType}
              periodValue={changesPeriodValue}
              availableMonths={availableMonths}
              availableWeeks={availableWeeks}
              onTypeChange={(t) => {
                setChangesPeriodType(t);
                if (t === 'week') setChangesPeriodValue(availableWeeks[0] || getWeekKey(now));
                else setChangesPeriodValue(availableMonths[0] || getMonthKey(now));
              }}
              onValueChange={setChangesPeriodValue}
              label={changesPeriodLabel}
            />

            {/* KPI: 신규 입점 / 플랜 변경 / 이탈 / 재입점 */}
            <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <KPICard
                label="신규 입점"
                value={`${periodTrueNewCampgrounds.length}`}
                sub={`${changesPeriodLabel} · 처음 등장한 캠핑장`}
                gradient="from-emerald-500 to-green-600"
              />
              <KPICard
                label="플랜 변경/추가"
                value={`${periodPlanChangeCampgrounds.length}`}
                sub={`${changesPeriodLabel} · 기존 캠핑장 새 플랜`}
                gradient="from-purple-500 to-violet-600"
              />
              <KPICard
                label="이탈 캠핑장"
                value={lostCampgrounds.length.toLocaleString()}
                sub="이전 대비 사라진 캠핑장"
                gradient="from-rose-500 to-red-600"
              />
              <KPICard
                label="재입점 캠핑장"
                value={rejoinedCampgrounds.length.toLocaleString()}
                sub="이전 이탈 후 복귀"
                gradient="from-amber-500 to-orange-600"
              />
              <KPICard
                label="시트 신규 발견"
                value={newlyFoundCampgrounds.length.toLocaleString()}
                sub="이전 스냅샷에 없던 신규"
                gradient="from-blue-500 to-indigo-600"
              />
            </section>

            {/* 추이 차트: 진짜 신규 입점 기준 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">
                📈 {changesPeriodType === 'week' ? '주별' : '월별'} 신규 캠핑장 입점 추이 (최초 등록 기준)
              </h2>
              <div className="h-72 md:h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={newTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} angle={changesPeriodType === 'week' ? -30 : 0} textAnchor={changesPeriodType === 'week' ? 'end' : 'middle'} height={changesPeriodType === 'week' ? 60 : 30} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value: number) => [value.toLocaleString() + '개소', '신규 캠핑장']} contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }} />
                    <Bar dataKey="count" name="신규 캠핑장" fill="#22c55e" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* 신규 입점 목록 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">
                🆕 {changesPeriodLabel} 신규 입점 — {periodTrueNewCampgrounds.length}개 캠핑장 ({periodTrueNew.length}건)
              </h2>
              <p className="text-xs text-gray-500 mb-3">시트에서 해당 기간에 처음 등장한 캠핑장만 표시합니다. 기존 캠핑장의 플랜 추가/변경은 아래 &quot;플랜 변경&quot; 섹션에 표시됩니다.</p>
              {periodTrueNew.length === 0 ? (
                <p className="text-gray-500 text-sm">해당 기간에 신규 입점 캠핑장이 없습니다.</p>
              ) : (
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-emerald-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-emerald-800">캠핑장명</th>
                        <th className="text-left px-4 py-2 font-semibold text-emerald-800">대표플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-emerald-800">세부플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-emerald-800">플랜등록일</th>
                        <th className="text-left px-4 py-2 font-semibold text-emerald-800">담당 MD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periodTrueNew.map((r) => (
                        <tr key={r.rowNumber} className="border-t border-gray-100 hover:bg-emerald-50/50">
                          <td className="px-4 py-2 font-medium">{r.campgroundName}</td>
                          <td className="px-4 py-2">{r.mainPlanName || '-'}</td>
                          <td className="px-4 py-2">{r.detailPlanName || '-'}</td>
                          <td className="px-4 py-2">{r.planStartDate || '-'}</td>
                          <td className="px-4 py-2">{r.md || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 플랜 변경/추가 목록 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">
                🔄 {changesPeriodLabel} 플랜 변경/추가 — {periodPlanChangeCampgrounds.length}개 캠핑장 ({periodPlanChanges.length}건)
              </h2>
              <p className="text-xs text-gray-500 mb-3">이미 시트에 등록되어 있던 캠핑장이 해당 기간에 새로운 플랜을 추가하거나 변경한 건입니다.</p>
              {periodPlanChanges.length === 0 ? (
                <p className="text-gray-500 text-sm">해당 기간에 플랜 변경/추가 건이 없습니다.</p>
              ) : (
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-purple-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">캠핑장명</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">대표플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">세부플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">플랜등록일</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">담당 MD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periodPlanChanges.map((r) => (
                        <tr key={r.rowNumber} className="border-t border-gray-100 hover:bg-purple-50/50">
                          <td className="px-4 py-2 font-medium">{r.campgroundName}</td>
                          <td className="px-4 py-2">{r.mainPlanName || '-'}</td>
                          <td className="px-4 py-2">{r.detailPlanName || '-'}</td>
                          <td className="px-4 py-2">{r.planStartDate || '-'}</td>
                          <td className="px-4 py-2">{r.md || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 이탈 / 재입점 */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <ChurnList
                title="🔴 이탈 캠핑장"
                items={lostCampgrounds}
                color="red"
                emptyMessage="이전 스냅샷 대비 이탈한 캠핑장이 없습니다."
              />
              <ChurnList
                title="🟢 재입점 캠핑장"
                items={rejoinedCampgrounds}
                color="emerald"
                emptyMessage="이전에 이탈했다가 다시 입점한 캠핑장이 없습니다."
              />
            </section>

            {/* 이력 기록 (서버 연동 시) */}
            {historyConfigured && historyRecords.length > 0 && (
              <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">📜 이력관리 기록 (최근 50건)</h2>
                <p className="text-xs text-gray-500 mb-3">Google Sheets &quot;이력관리&quot; 시트에 자동 기록된 이벤트입니다.</p>
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700">날짜시간</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700">캠핑장명</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700">이벤트</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700">담당 MD</th>
                        <th className="text-left px-4 py-2 font-semibold text-gray-700">비고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRecords.slice(-50).reverse().map((h, i) => (
                        <tr key={i} className="border-t border-gray-100 hover:bg-gray-50/50">
                          <td className="px-4 py-2 text-gray-600 text-xs">{h.date}</td>
                          <td className="px-4 py-2 font-medium">{h.campground}</td>
                          <td className="px-4 py-2">
                            <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                              h.type === '이탈' ? 'bg-red-100 text-red-700' :
                              h.type === '재입점' ? 'bg-emerald-100 text-emerald-700' :
                              'bg-blue-100 text-blue-700'
                            }`}>{h.type}</span>
                          </td>
                          <td className="px-4 py-2">{h.md || '-'}</td>
                          <td className="px-4 py-2 text-xs text-gray-500">{h.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* 이력 미설정 안내 */}
            {historyConfigured === false && (
              <section className="bg-amber-50 rounded-2xl border-2 border-amber-200 p-6">
                <h2 className="text-lg font-bold text-amber-800 mb-2">⚠️ 이력관리 서버 연동이 설정되지 않았습니다</h2>
                <p className="text-sm text-amber-700 mb-3">
                  현재 이탈/재입점 기록이 브라우저에만 저장되어, 다른 기기에서는 볼 수 없습니다.
                  아래 설정을 완료하면 Google Sheets에 이력이 자동 기록됩니다.
                </p>
                <div className="bg-white rounded-xl p-4 text-sm text-gray-700 space-y-2">
                  <p className="font-bold">📝 설정 방법:</p>
                  <ol className="list-decimal list-inside space-y-1 pl-2">
                    <li>Google Cloud Console에서 서비스 계정 생성</li>
                    <li>Google Sheets API 활성화</li>
                    <li>서비스 계정 JSON 키 다운로드</li>
                    <li>해당 스프레드시트를 서비스 계정 이메일로 공유 (편집 권한)</li>
                    <li>Vercel 환경변수에 <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">GOOGLE_SERVICE_ACCOUNT_KEY</code> 추가 (JSON 키 전체)</li>
                  </ol>
                </div>
              </section>
            )}
          </>
        )}

        {/* ═══ 탭 3: MD별 현황 ═══ */}
        {activeTab === 'md' && (
          <>
            <PeriodSelector
              periodType={mdPeriodType}
              periodValue={mdPeriodValue}
              availableMonths={availableMonths}
              availableWeeks={availableWeeks}
              onTypeChange={(t) => {
                setMdPeriodType(t);
                if (t === 'week') setMdPeriodValue(availableWeeks[0] || getWeekKey(now));
                else setMdPeriodValue(availableMonths[0] || getMonthKey(now));
              }}
              onValueChange={setMdPeriodValue}
              label={mdPeriodLabel}
            />

            <section className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <KPICard label="전체 MD 수" value={mdOverview.filter((m) => m.md !== '미지정').length.toLocaleString()} sub="담당 MD 지정된 수" gradient="from-blue-500 to-indigo-600" />
              <KPICard
                label={`${mdPeriodLabel} 신규 입점 1위`}
                value={topMd?.md || '-'}
                sub={topMd && topMd.periodTrueNew > 0 ? `${topMd.periodTrueNew}건 (진짜 신규)` : '해당 기간 신규 없음'}
                gradient="from-amber-500 to-orange-600"
              />
              <KPICard label="미지정 건수" value={(mdOverview.find((m) => m.md === '미지정')?.totalCount ?? 0).toLocaleString()} sub="담당 MD가 없는 건" gradient="from-gray-500 to-gray-600" />
            </section>

            {mdNewChart.length > 0 && (
              <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🏆 {mdPeriodLabel} MD별 신규 입점 Top 10</h2>
                <div className="h-72 md:h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={mdNewChart} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis dataKey="md" type="category" tick={{ fontSize: 11 }} width={80} />
                      <Tooltip formatter={(value: number) => [value.toLocaleString() + '건', '신규 입점']} contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }} />
                      <Bar dataKey="periodTrueNew" name="신규 입점" fill="#22c55e" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}

            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">📋 MD별 종합 현황</h2>
              <div className="max-h-[500px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-indigo-50 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold text-indigo-800">순위</th>
                      <th className="text-left px-4 py-3 font-semibold text-indigo-800">담당 MD</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">담당 캠핑장</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">전체 건수</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">정상 운영</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">종료/취소</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">{mdPeriodLabel} 신규</th>
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">{mdPeriodLabel} 플랜변경</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mdOverview.map((m, i) => (
                      <tr key={m.md} className="border-t border-gray-100 hover:bg-indigo-50/30 transition-colors">
                        <td className="px-4 py-3 text-gray-500 font-medium">{i + 1}</td>
                        <td className="px-4 py-3 font-bold text-gray-900">{m.md}</td>
                        <td className="px-4 py-3 text-right font-medium">{m.campgroundCount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">{m.totalCount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-emerald-600 font-medium">{m.activeCount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right text-red-600 font-medium">{m.endedCount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right">
                          {m.periodTrueNew > 0 ? (
                            <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">+{m.periodTrueNew}</span>
                          ) : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {m.periodPlanChange > 0 ? (
                            <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-bold">{m.periodPlanChange}</span>
                          ) : <span className="text-gray-400">-</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════
// 서브 컴포넌트
// ═══════════════════════════════════════

function PeriodSelector({ periodType, periodValue, availableMonths, availableWeeks, onTypeChange, onValueChange, label }: {
  periodType: PeriodType; periodValue: string; availableMonths: string[]; availableWeeks: string[];
  onTypeChange: (t: PeriodType) => void; onValueChange: (v: string) => void; label: string;
}) {
  const options = periodType === 'week' ? availableWeeks : availableMonths;
  return (
    <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-4 md:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          <button onClick={() => onTypeChange('week')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${periodType === 'week' ? 'bg-indigo-600 text-white shadow' : 'text-gray-600 hover:text-gray-900'}`}>📅 주간</button>
          <button onClick={() => onTypeChange('month')} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${periodType === 'month' ? 'bg-indigo-600 text-white shadow' : 'text-gray-600 hover:text-gray-900'}`}>🗓️ 월간</button>
        </div>
        <div className="flex items-center gap-3 flex-1">
          <select value={periodValue} onChange={(e) => onValueChange(e.target.value)} className="px-4 py-2.5 border-2 border-gray-300 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 min-w-[200px]">
            {options.map((opt) => (<option key={opt} value={opt}>{periodType === 'week' ? getWeekLabel(opt) : getMonthLabel(opt)}</option>))}
          </select>
          <span className="text-sm text-indigo-600 font-bold hidden sm:block">선택: {label}</span>
        </div>
      </div>
    </section>
  );
}

function KPICard({ label, value, sub, gradient }: { label: string; value: string; sub?: string; gradient: string }) {
  return (
    <div className={`bg-gradient-to-br ${gradient} text-white rounded-2xl shadow-lg p-5 transform hover:scale-[1.02] transition-all`}>
      <div className="text-xs md:text-sm font-medium text-white/80 mb-1">{label}</div>
      <div className="text-2xl md:text-3xl font-extrabold truncate">{value}</div>
      {sub && <div className="text-[11px] md:text-xs text-white/70 mt-1">{sub}</div>}
    </div>
  );
}

function StatusTable({ title, data, total }: { title: string; data: { name: string; count: number }[]; total: number }) {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <h2 className="text-lg font-bold text-gray-800 mb-4">{title}</h2>
      <div className="space-y-2">
        {data.map((item) => {
          const pct = total ? (item.count / total) * 100 : 0;
          return (
            <div key={item.name}>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-gray-700">{item.name}</span>
                <span className="text-gray-600">{item.count.toLocaleString()}건 ({pct.toFixed(1)}%)</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChurnList({ title, items, color, emptyMessage }: { title: string; items: string[]; color: 'red' | 'emerald'; emptyMessage: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className={`text-lg font-bold text-${color}-700 flex items-center gap-2`}>{title}</h2>
        <span className={`px-3 py-1 rounded-full bg-${color}-100 text-${color}-700 text-sm font-bold`}>{items.length}개</span>
      </div>
      {items.length === 0 ? (
        <p className="text-gray-500 text-sm">{emptyMessage}</p>
      ) : (
        <ul className="max-h-[250px] overflow-auto text-sm space-y-1">
          {items.map((name) => (
            <li key={name} className={`px-3 py-2 bg-${color}-50 rounded-lg text-gray-800`}>{name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DataTable({ data, title }: { data: CampfitPlanRecord[]; title: string }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter((r) => r.campgroundName.toLowerCase().includes(q) || r.mainPlanName?.toLowerCase().includes(q) || r.md?.toLowerCase().includes(q) || r.detailPlanName?.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-800">📋 {title} ({filtered.length.toLocaleString()}건)</h2>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="캠핑장명, 플랜, MD 검색..." className="px-4 py-2 border-2 border-gray-300 rounded-xl text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 w-full sm:w-64" />
      </div>
      <div className="max-h-[600px] overflow-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white sticky top-0">
            <tr>
              <th className="px-3 py-3 text-left font-semibold">#</th>
              <th className="px-3 py-3 text-left font-semibold">캠핑장명</th>
              <th className="px-3 py-3 text-left font-semibold">운영상태</th>
              <th className="px-3 py-3 text-left font-semibold hidden md:table-cell">세부플랜</th>
              <th className="px-3 py-3 text-left font-semibold">대표플랜</th>
              <th className="px-3 py-3 text-left font-semibold hidden lg:table-cell">결합형</th>
              <th className="px-3 py-3 text-left font-semibold hidden lg:table-cell">이지캠핑</th>
              <th className="px-3 py-3 text-left font-semibold">플랜상태</th>
              <th className="px-3 py-3 text-left font-semibold">등록일</th>
              <th className="px-3 py-3 text-left font-semibold hidden md:table-cell">취소일</th>
              <th className="px-3 py-3 text-left font-semibold">담당 MD</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-gray-500">검색 결과가 없습니다.</td></tr>
            ) : (
              filtered.map((row) => {
                const ended = row.planStatus?.includes('종료') || row.planStatus?.includes('취소') || row.operateStatus?.includes('중단') || row.operateStatus?.includes('종료');
                return (
                  <tr key={row.rowNumber} className={`border-b transition-colors ${ended ? 'bg-red-50/50 hover:bg-red-100/50' : 'hover:bg-blue-50/30'}`}>
                    <td className="px-3 py-2 text-gray-400">{row.rowNumber}</td>
                    <td className="px-3 py-2 font-bold text-gray-900">{row.campgroundName}</td>
                    <td className="px-3 py-2"><StatusBadge value={row.operateStatus} type="operate" /></td>
                    <td className="px-3 py-2 text-gray-700 hidden md:table-cell">{row.detailPlanName || '-'}</td>
                    <td className="px-3 py-2 text-gray-700">{row.mainPlanName || '-'}</td>
                    <td className="px-3 py-2 text-gray-600 hidden lg:table-cell">{row.bundleSubType || '-'}</td>
                    <td className="px-3 py-2 text-gray-600 hidden lg:table-cell">{row.easyCamping || '-'}</td>
                    <td className="px-3 py-2"><StatusBadge value={row.planStatus} type="plan" /></td>
                    <td className="px-3 py-2 text-gray-700">{row.planStartDate || '-'}</td>
                    <td className="px-3 py-2 text-gray-700 hidden md:table-cell">{row.planEndDate || '-'}</td>
                    <td className="px-3 py-2 text-gray-800 font-medium">{row.md || '-'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusBadge({ value, type }: { value?: string; type: 'operate' | 'plan' }) {
  if (!value) return <span className="text-gray-400">-</span>;
  const isGood = type === 'operate' ? value.includes('운영') || value.includes('정상') : value.includes('정상') || value.includes('사용');
  const isBad = type === 'operate' ? value.includes('중단') || value.includes('종료') : value.includes('종료') || value.includes('취소');
  const cls = isGood ? 'bg-emerald-100 text-emerald-700' : isBad ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700';
  return <span className={`px-2 py-1 rounded-full text-xs font-semibold ${cls}`}>{value}</span>;
}
