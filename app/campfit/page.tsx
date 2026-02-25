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
import { parseISO, format, startOfMonth, endOfMonth, isBefore, isAfter, isEqual } from 'date-fns';

// ─── 색상 팔레트 ───
const COLORS = [
  '#4f46e5', '#22c55e', '#f97316', '#06b6d4', '#a855f7',
  '#e11d48', '#0f766e', '#14b8a6', '#f59e0b', '#ec4899',
  '#6366f1', '#84cc16', '#fb923c', '#2dd4bf', '#c084fc',
];

// ─── 탭 타입 ───
type TabKey = 'overview' | 'changes' | 'md';

// ─── 이탈/재입점 스냅샷 키 ───
const SNAPSHOT_KEY = 'campfit_prev_snapshot_v2';
const HISTORY_KEY = 'campfit_history_v2';

interface HistoryEntry {
  status: 'active' | 'churned';
  updatedAt: number;
}

// ─── 이탈/재입점 계산 ───
function calculateChurn(currentNames: string[]): { lost: string[]; rejoined: string[] } {
  if (typeof window === 'undefined') return { lost: [], rejoined: [] };

  const now = Date.now();
  let prevNames: string[] = [];
  let history: Record<string, HistoryEntry> = {};

  try {
    const prevRaw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (prevRaw) prevNames = JSON.parse(prevRaw);
  } catch { prevNames = []; }

  try {
    const histRaw = window.localStorage.getItem(HISTORY_KEY);
    if (histRaw) history = JSON.parse(histRaw);
  } catch { history = {}; }

  const prevSet = new Set(prevNames);
  const currSet = new Set(currentNames);

  const lost: string[] = [];
  const rejoined: string[] = [];

  prevSet.forEach((name) => {
    if (!currSet.has(name)) {
      lost.push(name);
      history[name] = { status: 'churned', updatedAt: now };
    }
  });

  currSet.forEach((name) => {
    const prev = history[name];
    if (!prev) {
      history[name] = { status: 'active', updatedAt: now };
    } else if (prev.status === 'churned' && !prevSet.has(name)) {
      rejoined.push(name);
      history[name] = { status: 'active', updatedAt: now };
    } else {
      history[name] = { status: 'active', updatedAt: now };
    }
  });

  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(currentNames));
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}

  return { lost, rejoined };
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

// ─── 메인 컴포넌트 ───
export default function CampfitDashboardPage() {
  const [data, setData] = useState<CampfitPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [lostCampgrounds, setLostCampgrounds] = useState<string[]>([]);
  const [rejoinedCampgrounds, setRejoinedCampgrounds] = useState<string[]>([]);

  // 데이터 로드
  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const ts = Date.now();
      const res = await fetch(`/api/campfit-reservations?t=${ts}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API 오류 (${res.status}): ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      if (json.error) throw new Error(json.error);

      const rows: CampfitPlanRecord[] = Array.isArray(json.data) ? json.data : [];
      setData(rows);

      // 이탈/재입점 계산
      const names = [...new Set(rows.map((r) => r.campgroundName).filter(Boolean))];
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

  useEffect(() => { fetchData(); }, []);

  // ───────────── 전체 현황 집계 ─────────────

  // 1) 전체 등록 건수 (시트 전체 행)
  const totalRecords = data.length;

  // 2) 전체 캠핑장 수 (고유 캠핑장명)
  const allCampgroundNames = useMemo(() => {
    return [...new Set(data.map((r) => r.campgroundName))];
  }, [data]);
  const totalCampgrounds = allCampgroundNames.length;

  // 3) 정상 운영 건수 / 종료·취소 건수
  const { activeRecords, endedRecords } = useMemo(() => {
    let active = 0;
    let ended = 0;
    data.forEach((r) => {
      if (isEnded(r)) ended++;
      else active++;
    });
    return { activeRecords: active, endedRecords: ended };
  }, [data]);

  // 4) 운영상태별 현황
  const operateStatusStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const key = r.operateStatus?.trim() || '미기재';
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // 5) 플랜상태별 현황
  const planStatusStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const key = r.planStatus?.trim() || '미기재';
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // 6) 대표플랜별 등록 현황
  const planDistribution = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const key = r.mainPlanName?.trim() || '미지정';
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([plan, count]) => ({ plan, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // ───────────── 신규 / 이탈 / 변경 현황 ─────────────

  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const thisMonthEnd = endOfMonth(now);

  // 이번달 신규 입점 (플랜등록일이 이번달인 건)
  const thisMonthNew = useMemo(() => {
    return data.filter((r) => {
      const d = parseDate(r.planStartDate);
      if (!d) return false;
      return !isBefore(d, thisMonthStart) && !isAfter(d, thisMonthEnd);
    });
  }, [data, thisMonthStart, thisMonthEnd]);

  // 이번달 종료 (플랜상태/운영상태가 종료이고, 플랜등록일이 이번달인 건)
  const thisMonthEnded = useMemo(() => {
    return data.filter((r) => {
      if (!isEnded(r)) return false;
      const d = parseDate(r.planStartDate);
      if (!d) return false;
      return !isBefore(d, thisMonthStart) && !isAfter(d, thisMonthEnd);
    });
  }, [data, thisMonthStart, thisMonthEnd]);

  // 플랜 변경 이벤트 (같은 캠핑장, 다른 세부플랜)
  const planChangeEvents = useMemo(() => {
    const byCampground = new Map<string, CampfitPlanRecord[]>();
    data.forEach((r) => {
      if (!byCampground.has(r.campgroundName)) byCampground.set(r.campgroundName, []);
      byCampground.get(r.campgroundName)!.push(r);
    });

    const changes: { campground: string; fromPlan: string; toPlan: string; date: string; md?: string }[] = [];

    byCampground.forEach((rows, campground) => {
      if (rows.length <= 1) return;
      const sorted = [...rows].sort((a, b) => {
        const da = parseDate(a.planStartDate)?.getTime() ?? 0;
        const db = parseDate(b.planStartDate)?.getTime() ?? 0;
        return da - db;
      });

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1].detailPlanName || '';
        const curr = sorted[i].detailPlanName || '';
        if (prev && curr && prev !== curr) {
          changes.push({
            campground,
            fromPlan: prev,
            toPlan: curr,
            date: sorted[i].planStartDate || '',
            md: sorted[i].md,
          });
        }
      }
    });

    return changes;
  }, [data]);

  // 월별 신규 입점 추이 (최근 12개월)
  const monthlyNewTrend = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const d = parseDate(r.planStartDate);
      if (!d) return;
      const key = format(d, 'yyyy-MM');
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12); // 최근 12개월
  }, [data]);

  // ───────────── MD별 현황 ─────────────

  const mdOverview = useMemo(() => {
    const map = new Map<string, {
      md: string;
      totalCount: number;      // 전체 담당 건수
      activeCount: number;      // 정상 운영 건수
      endedCount: number;       // 종료 건수
      thisMonthNew: number;     // 이번달 신규
      campgrounds: Set<string>; // 고유 캠핑장
    }>();

    data.forEach((r) => {
      const md = r.md?.trim() || '미지정';
      if (!map.has(md)) {
        map.set(md, {
          md,
          totalCount: 0,
          activeCount: 0,
          endedCount: 0,
          thisMonthNew: 0,
          campgrounds: new Set(),
        });
      }
      const stat = map.get(md)!;
      stat.totalCount += 1;
      stat.campgrounds.add(r.campgroundName);

      if (isEnded(r)) {
        stat.endedCount += 1;
      } else {
        stat.activeCount += 1;
      }

      const d = parseDate(r.planStartDate);
      if (d && !isBefore(d, thisMonthStart) && !isAfter(d, thisMonthEnd)) {
        stat.thisMonthNew += 1;
      }
    });

    return [...map.values()]
      .map((s) => ({
        md: s.md,
        totalCount: s.totalCount,
        activeCount: s.activeCount,
        endedCount: s.endedCount,
        thisMonthNew: s.thisMonthNew,
        campgroundCount: s.campgrounds.size,
      }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [data, thisMonthStart, thisMonthEnd]);

  // MD별 이번달 신규 입점 Top 10 (차트용)
  const mdNewChart = useMemo(() => {
    return mdOverview
      .filter((m) => m.thisMonthNew > 0)
      .sort((a, b) => b.thisMonthNew - a.thisMonthNew)
      .slice(0, 10);
  }, [mdOverview]);

  const topMd = mdOverview.length > 0 ? mdOverview.sort((a, b) => b.thisMonthNew - a.thisMonthNew)[0] : null;

  // ───────────── 로딩/에러 ─────────────

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
          <h1 className="text-3xl font-bold text-red-700 flex items-center gap-3">
            <span className="text-4xl">⚠️</span> 데이터 로드 오류
          </h1>
          <p className="text-base text-gray-700 whitespace-pre-wrap break-words bg-red-50 p-4 rounded-lg">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-semibold hover:from-red-700 hover:to-rose-700 transition-all shadow-lg"
          >
            🔄 다시 시도
          </button>
        </div>
      </div>
    );
  }

  // ───────────── 렌더링 ─────────────

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: '운영 현황', icon: '📊' },
    { key: 'changes', label: '신규 / 이탈 / 변경', icon: '📈' },
    { key: 'md', label: 'MD별 현황', icon: '👤' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* ─── 상단 헤더 ─── */}
      <header className="bg-white/90 backdrop-blur-md border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent">
                캠핏 예약팀 대시보드
              </h1>
              <p className="text-xs md:text-sm text-gray-500 mt-1">
                Google Sheets 실시간 연동 · 마지막 업데이트: {format(now, 'yyyy.MM.dd HH:mm')}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchData}
                className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-all shadow-lg hover:shadow-xl flex items-center gap-2"
              >
                🔄 새로고침
              </button>
              <div className="bg-indigo-50 text-indigo-700 px-3 py-2 rounded-lg text-sm font-bold">
                시트 전체 {totalRecords.toLocaleString()}건
              </div>
            </div>
          </div>

          {/* ─── 탭 네비게이션 ─── */}
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

        {/* ════════════════════════════════════════════════════
            탭 1: 운영 현황
            ════════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <>
            {/* KPI 카드 4개 */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard
                label="전체 등록 건수"
                value={totalRecords.toLocaleString()}
                sub="시트 전체 행 수"
                gradient="from-blue-500 to-indigo-600"
              />
              <KPICard
                label="등록 캠핑장 수"
                sub="고유 캠핑장명 기준"
                value={totalCampgrounds.toLocaleString()}
                gradient="from-emerald-500 to-teal-600"
              />
              <KPICard
                label="정상 운영"
                value={activeRecords.toLocaleString()}
                sub={`전체의 ${totalRecords ? ((activeRecords / totalRecords) * 100).toFixed(1) : 0}%`}
                gradient="from-cyan-500 to-blue-600"
              />
              <KPICard
                label="종료 / 취소"
                value={endedRecords.toLocaleString()}
                sub={`전체의 ${totalRecords ? ((endedRecords / totalRecords) * 100).toFixed(1) : 0}%`}
                gradient="from-rose-500 to-pink-600"
              />
            </section>

            {/* 대표플랜별 등록 현황 */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* 대표플랜 테이블 */}
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                  📋 대표플랜별 등록 현황
                </h2>
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
                        <tr key={item.plan} className="border-t border-gray-100 hover:bg-blue-50/50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-800 flex items-center gap-2">
                            <span
                              className="w-3 h-3 rounded-full inline-block"
                              style={{ backgroundColor: COLORS[i % COLORS.length] }}
                            />
                            {item.plan}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">{item.count.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right text-gray-600">
                            {totalRecords ? ((item.count / totalRecords) * 100).toFixed(1) : 0}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 대표플랜 도넛 차트 */}
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                  🥧 대표플랜 비율
                </h2>
                <div className="h-[400px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={planDistribution}
                        dataKey="count"
                        nameKey="plan"
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={120}
                        paddingAngle={2}
                        label={({ plan, percent }) =>
                          `${String(plan).length > 8 ? String(plan).slice(0, 8) + '…' : plan} ${(percent * 100).toFixed(0)}%`
                        }
                        labelLine={true}
                      >
                        {planDistribution.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number) => [value.toLocaleString() + '건', '등록 수']}
                        contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>

            {/* 운영상태 / 플랜상태 분포 */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <StatusTable title="🏢 운영상태별 분포" data={operateStatusStats} total={totalRecords} />
              <StatusTable title="📄 플랜상태별 분포" data={planStatusStats} total={totalRecords} />
            </section>

            {/* 전체 데이터 테이블 */}
            <DataTable data={data} title="전체 캠핑장 / 플랜 리스트" />
          </>
        )}

        {/* ════════════════════════════════════════════════════
            탭 2: 신규 / 이탈 / 변경 현황
            ════════════════════════════════════════════════════ */}
        {activeTab === 'changes' && (
          <>
            {/* KPI 카드 */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard
                label={`이번달 신규 입점 (${format(now, 'M')}월)`}
                value={thisMonthNew.length.toLocaleString()}
                sub="플랜등록일 기준"
                gradient="from-emerald-500 to-green-600"
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
                label="플랜 변경 건수"
                value={planChangeEvents.length.toLocaleString()}
                sub="동일 캠핑장, 다른 플랜"
                gradient="from-purple-500 to-violet-600"
              />
            </section>

            {/* 월별 신규 입점 추이 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                📈 월별 신규 입점 추이
              </h2>
              <div className="h-72 md:h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyNewTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: number) => [value.toLocaleString() + '건', '신규 입점']}
                      contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }}
                    />
                    <Bar dataKey="count" name="신규 입점" fill="#22c55e" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* 이번달 신규 입점 목록 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                🆕 이번달 신규 입점 ({format(now, 'yyyy년 M월')}) — {thisMonthNew.length}건
              </h2>
              {thisMonthNew.length === 0 ? (
                <p className="text-gray-500 text-sm">이번달 신규 입점 데이터가 없습니다.</p>
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
                      {thisMonthNew.map((r) => (
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

            {/* 이탈 / 재입점 캠핑장 */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-red-700 flex items-center gap-2">🔴 이탈 캠핑장</h2>
                  <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 text-sm font-bold">
                    {lostCampgrounds.length}개
                  </span>
                </div>
                {lostCampgrounds.length === 0 ? (
                  <p className="text-gray-500 text-sm">이전 스냅샷 대비 이탈한 캠핑장이 없습니다.</p>
                ) : (
                  <ul className="max-h-[250px] overflow-auto text-sm space-y-1">
                    {lostCampgrounds.map((name) => (
                      <li key={name} className="px-3 py-2 bg-red-50 rounded-lg text-gray-800">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-gray-400">
                  브라우저 로컬 저장소 기준으로 직전 조회와 비교합니다.
                </p>
              </div>

              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-emerald-700 flex items-center gap-2">🟢 재입점 캠핑장</h2>
                  <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-sm font-bold">
                    {rejoinedCampgrounds.length}개
                  </span>
                </div>
                {rejoinedCampgrounds.length === 0 ? (
                  <p className="text-gray-500 text-sm">이전에 이탈했다가 다시 입점한 캠핑장이 없습니다.</p>
                ) : (
                  <ul className="max-h-[250px] overflow-auto text-sm space-y-1">
                    {rejoinedCampgrounds.map((name) => (
                      <li key={name} className="px-3 py-2 bg-emerald-50 rounded-lg text-gray-800">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-gray-400">
                  이전에 이탈 상태였다가 시트에 다시 등장한 캠핑장입니다.
                </p>
              </div>
            </section>

            {/* 플랜 변경 내역 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                🔄 플랜 변경 내역 — {planChangeEvents.length}건
              </h2>
              {planChangeEvents.length === 0 ? (
                <p className="text-gray-500 text-sm">플랜 변경 이력이 없습니다.</p>
              ) : (
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-purple-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">캠핑장명</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">이전 플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">변경 플랜</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">변경일</th>
                        <th className="text-left px-4 py-2 font-semibold text-purple-800">담당 MD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planChangeEvents.map((ev, i) => (
                        <tr key={i} className="border-t border-gray-100 hover:bg-purple-50/50">
                          <td className="px-4 py-2 font-medium">{ev.campground}</td>
                          <td className="px-4 py-2 text-red-600">{ev.fromPlan}</td>
                          <td className="px-4 py-2 text-emerald-600">{ev.toPlan}</td>
                          <td className="px-4 py-2">{ev.date || '-'}</td>
                          <td className="px-4 py-2">{ev.md || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ════════════════════════════════════════════════════
            탭 3: MD별 현황
            ════════════════════════════════════════════════════ */}
        {activeTab === 'md' && (
          <>
            {/* MD Top 요약 */}
            <section className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <KPICard
                label="전체 MD 수"
                value={mdOverview.filter((m) => m.md !== '미지정').length.toLocaleString()}
                sub="담당 MD가 지정된 수"
                gradient="from-blue-500 to-indigo-600"
              />
              <KPICard
                label={`이번달 신규 입점 1위`}
                value={topMd?.md || '-'}
                sub={topMd ? `${topMd.thisMonthNew}건 입점` : ''}
                gradient="from-amber-500 to-orange-600"
              />
              <KPICard
                label="미지정 건수"
                value={(mdOverview.find((m) => m.md === '미지정')?.totalCount ?? 0).toLocaleString()}
                sub="담당 MD가 없는 건"
                gradient="from-gray-500 to-gray-600"
              />
            </section>

            {/* MD별 이번달 신규 입점 차트 */}
            {mdNewChart.length > 0 && (
              <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                  🏆 이번달 MD별 신규 입점 Top 10
                </h2>
                <div className="h-72 md:h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={mdNewChart} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis dataKey="md" type="category" tick={{ fontSize: 11 }} width={80} />
                      <Tooltip
                        formatter={(value: number) => [value.toLocaleString() + '건', '이번달 신규']}
                        contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }}
                      />
                      <Bar dataKey="thisMonthNew" name="이번달 신규" fill="#22c55e" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}

            {/* MD별 상세 테이블 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                📋 MD별 종합 현황
              </h2>
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
                      <th className="text-right px-4 py-3 font-semibold text-indigo-800">이번달 신규</th>
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
                          {m.thisMonthNew > 0 && (
                            <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">
                              +{m.thisMonthNew}
                            </span>
                          )}
                          {m.thisMonthNew === 0 && <span className="text-gray-400">-</span>}
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

// ─── 서브 컴포넌트 ───

function KPICard({
  label,
  value,
  sub,
  gradient,
}: {
  label: string;
  value: string;
  sub?: string;
  gradient: string;
}) {
  return (
    <div
      className={`bg-gradient-to-br ${gradient} text-white rounded-2xl shadow-lg p-5 transform hover:scale-[1.02] transition-all`}
    >
      <div className="text-xs md:text-sm font-medium text-white/80 mb-1">{label}</div>
      <div className="text-2xl md:text-3xl font-extrabold truncate">{value}</div>
      {sub && <div className="text-[11px] md:text-xs text-white/70 mt-1">{sub}</div>}
    </div>
  );
}

function StatusTable({
  title,
  data,
  total,
}: {
  title: string;
  data: { name: string; count: number }[];
  total: number;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <h2 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">{title}</h2>
      <div className="space-y-2">
        {data.map((item) => {
          const pct = total ? (item.count / total) * 100 : 0;
          return (
            <div key={item.name}>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-gray-700">{item.name}</span>
                <span className="text-gray-600">
                  {item.count.toLocaleString()}건 ({pct.toFixed(1)}%)
                </span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 rounded-full transition-all"
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DataTable({ data, title }: { data: CampfitPlanRecord[]; title: string }) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter(
      (r) =>
        r.campgroundName.toLowerCase().includes(q) ||
        r.mainPlanName?.toLowerCase().includes(q) ||
        r.md?.toLowerCase().includes(q) ||
        r.detailPlanName?.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
          📋 {title} ({filtered.length.toLocaleString()}건)
        </h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="캠핑장명, 플랜, MD 검색..."
          className="px-4 py-2 border-2 border-gray-300 rounded-xl text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 w-full sm:w-64"
        />
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
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-500">
                  검색 결과가 없습니다.
                </td>
              </tr>
            ) : (
              filtered.map((row) => {
                const ended = row.planStatus?.includes('종료') || row.planStatus?.includes('취소') ||
                  row.operateStatus?.includes('중단') || row.operateStatus?.includes('종료');
                return (
                  <tr
                    key={row.rowNumber}
                    className={`border-b transition-colors ${ended ? 'bg-red-50/50 hover:bg-red-100/50' : 'hover:bg-blue-50/30'}`}
                  >
                    <td className="px-3 py-2 text-gray-400">{row.rowNumber}</td>
                    <td className="px-3 py-2 font-bold text-gray-900">{row.campgroundName}</td>
                    <td className="px-3 py-2">
                      <StatusBadge value={row.operateStatus} type="operate" />
                    </td>
                    <td className="px-3 py-2 text-gray-700 hidden md:table-cell">{row.detailPlanName || '-'}</td>
                    <td className="px-3 py-2 text-gray-700">{row.mainPlanName || '-'}</td>
                    <td className="px-3 py-2 text-gray-600 hidden lg:table-cell">{row.bundleSubType || '-'}</td>
                    <td className="px-3 py-2 text-gray-600 hidden lg:table-cell">{row.easyCamping || '-'}</td>
                    <td className="px-3 py-2">
                      <StatusBadge value={row.planStatus} type="plan" />
                    </td>
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

  const isGood =
    type === 'operate'
      ? value.includes('운영') || value.includes('정상')
      : value.includes('정상') || value.includes('사용');

  const isBad =
    type === 'operate'
      ? value.includes('중단') || value.includes('종료')
      : value.includes('종료') || value.includes('취소');

  const cls = isGood
    ? 'bg-emerald-100 text-emerald-700'
    : isBad
      ? 'bg-red-100 text-red-700'
      : 'bg-gray-100 text-gray-700';

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${cls}`}>
      {value}
    </span>
  );
}
