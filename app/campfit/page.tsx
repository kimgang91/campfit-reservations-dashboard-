'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
  Legend,
} from 'recharts';
import type { CampfitPlanRecord, CampgroundType } from '@/lib/campfitReservations';
import type { TransactionData, TransactionSection, YearlyMonthlyData } from '@/lib/campfitTransactions';
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

const TYPE_COLORS: Record<string, string> = {
  '오토캠핑': '#22c55e', '글램핑': '#a855f7', '카라반': '#f97316',
  '펜션': '#06b6d4', '방가로': '#f59e0b', '차박': '#e11d48', '기타': '#94a3b8',
};
const GRADE_COLORS: Record<string, string> = {
  'S': '#ef4444', 'A': '#f97316', 'B': '#eab308', 'C': '#22c55e', 'D': '#06b6d4',
};

type TabKey = 'overview' | 'changes' | 'md' | 'transactions';
type PeriodType = 'week' | 'month';

// ─── 이력 타입 ───
interface HistoryRecord { date: string; campground: string; type: string; md: string; note: string; }

// ─── localStorage 폴백용 ───
const LS_SNAPSHOT_KEY = 'campfit_prev_snapshot_v3';
const LS_HISTORY_KEY = 'campfit_history_v3';

function localCalculateChurn(currentNames: string[]): { lost: string[]; rejoined: string[] } {
  if (typeof window === 'undefined') return { lost: [], rejoined: [] };
  let prevNames: string[] = [];
  let everChurned: string[] = [];
  try { const raw = window.localStorage.getItem(LS_SNAPSHOT_KEY); if (raw) prevNames = JSON.parse(raw); } catch { prevNames = []; }
  try { const raw = window.localStorage.getItem(LS_HISTORY_KEY); if (raw) everChurned = JSON.parse(raw); } catch { everChurned = []; }
  const prevSet = new Set(prevNames); const currSet = new Set(currentNames); const churnedSet = new Set(everChurned);
  const lost: string[] = []; const rejoined: string[] = [];
  prevSet.forEach((name) => { if (!currSet.has(name)) { lost.push(name); churnedSet.add(name); } });
  currSet.forEach((name) => { if (!prevSet.has(name) && churnedSet.has(name)) rejoined.push(name); });
  try { window.localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(currentNames)); window.localStorage.setItem(LS_HISTORY_KEY, JSON.stringify([...churnedSet])); } catch {}
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
function dateInRange(d: Date, rangeStart: Date, rangeEnd: Date): boolean {
  return !isBefore(d, rangeStart) && !isAfter(d, rangeEnd);
}
function getWeekKey(d: Date): string { return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd'); }
function getMonthKey(d: Date): string { return format(d, 'yyyy-MM'); }
function getWeekLabel(mondayStr: string): string {
  const monday = parseISO(mondayStr); const sunday = addDays(monday, 6);
  const weekNum = getISOWeek(monday); const monthNum = monday.getMonth() + 1;
  return `${monthNum}월 ${weekNum}주차 (${format(monday, 'MM.dd')}~${format(sunday, 'MM.dd')})`;
}
function getMonthLabel(monthKey: string): string { return format(parseISO(monthKey + '-01'), 'yyyy년 M월'); }
function getPeriodRange(periodType: PeriodType, periodValue: string): { start: Date; end: Date } {
  if (periodType === 'week') {
    const monday = parseISO(periodValue);
    return { start: monday, end: endOfWeek(monday, { weekStartsOn: 1 }) };
  }
  const d = parseISO(periodValue + '-01');
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

/** 이력 날짜시간 문자열(YYYY-MM-DD HH:mm:ss)을 Date로 파싱 */
function parseHistoryDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  try {
    const trimmed = dateStr.trim().split(' ')[0]; // YYYY-MM-DD 부분만
    return parseISO(trimmed);
  } catch { return null; }
}

// ─── 집계 헬퍼 ───
function countByKey<T>(items: T[], keyFn: (item: T) => string): { name: string; count: number }[] {
  const map = new Map<string, number>();
  items.forEach((item) => { const k = keyFn(item); map.set(k, (map.get(k) ?? 0) + 1); });
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

// ═══════════════════════════════════════
// ─── 메인 컴포넌트 ───
// ═══════════════════════════════════════
export default function CampfitDashboardPage() {
  const [data, setData] = useState<CampfitPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // ─── 상세 리스트 모달 ───
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalColor, setModalColor] = useState<'emerald' | 'purple' | 'red' | 'amber'>('emerald');
  const [modalRecords, setModalRecords] = useState<CampfitPlanRecord[]>([]);
  const [modalNames, setModalNames] = useState<string[]>([]); // 이탈/재입점용 (이름만)
  const [modalMode, setModalMode] = useState<'records' | 'names'>('records');

  const openDetailModal = useCallback((
    title: string,
    color: 'emerald' | 'purple' | 'red' | 'amber',
    records?: CampfitPlanRecord[],
    names?: string[],
  ) => {
    setModalTitle(title);
    setModalColor(color);
    if (records) {
      setModalRecords(records);
      setModalNames([]);
      setModalMode('records');
    } else if (names) {
      setModalNames(names);
      setModalRecords([]);
      setModalMode('names');
    }
    setModalOpen(true);
  }, []);

  // 거래액/매출
  const [txData, setTxData] = useState<TransactionData | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // 이탈/재입점
  const [lostCampgrounds, setLostCampgrounds] = useState<string[]>([]);
  const [rejoinedCampgrounds, setRejoinedCampgrounds] = useState<string[]>([]);
  const [historyConfigured, setHistoryConfigured] = useState<boolean | null>(null);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySource, setHistorySource] = useState<string>('');
  const [resetting, setResetting] = useState(false);

  // 기간 선택
  const [changesPeriodType, setChangesPeriodType] = useState<PeriodType>('month');
  const [changesPeriodValue, setChangesPeriodValue] = useState<string>('');
  const [mdPeriodType, setMdPeriodType] = useState<PeriodType>('month');
  const [mdPeriodValue, setMdPeriodValue] = useState<string>('');

  // 이탈/재입점 기간 선택
  const [churnPeriodType, setChurnPeriodType] = useState<PeriodType>('month');
  const [churnPeriodValue, setChurnPeriodValue] = useState<string>('');

  // 필터: 유형 & 등급
  const [filterType, setFilterType] = useState<string>('전체');
  const [filterGrade, setFilterGrade] = useState<string>('전체');

  const now = new Date();

  // ─── 시트 데이터만 가져오기 (초기 로드용) ───
  const loadSheetData = useCallback(async (): Promise<CampfitPlanRecord[]> => {
    const ts = Date.now();
    const res = await fetch(`/api/campfit-reservations?t=${ts}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } });
    if (!res.ok) throw new Error(`API 오류 (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return Array.isArray(json.data) ? json.data : [];
  }, []);

  // ─── 이력 읽기만 (스냅샷 업데이트 안 함) ───
  const loadHistoryOnly = useCallback(async () => {
    try {
      const getRes = await fetch('/api/campfit-history');
      const getJson = await getRes.json();
      if (getJson.configured) {
        setHistoryConfigured(true);
        setHistorySource(getJson.configStatus?.source || '');
        setHistoryRecords(getJson.history || []);

        // 런타임 오류가 있으면 오류 표시 (설정은 됨)
        if (getJson.runtimeError) {
          setHistoryError(`⚠️ 연동은 설정되었으나 API 오류: ${getJson.error || '알 수 없는 오류'}`);
        } else {
          setHistoryError(null);
        }

        // 이력에서 이탈/재입점 추출
        const history: HistoryRecord[] = getJson.history || [];
        setLostCampgrounds(history.filter((h: HistoryRecord) => h.type === '이탈').map((h: HistoryRecord) => h.campground));
        setRejoinedCampgrounds(history.filter((h: HistoryRecord) => h.type === '재입점').map((h: HistoryRecord) => h.campground));
      } else {
        setHistoryConfigured(false);
        setHistoryError(getJson.error || getJson.message || '서버 연동 실패');
      }
    } catch (err: any) {
      setHistoryConfigured(false);
      setHistoryError(err?.message || '이력 API 호출 실패');
    }
  }, []);

  // ─── 초기 데이터 로드 (이력 업데이트 없이) ───
  const initialLoad = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const rows = await loadSheetData();
      setData(rows);
      await loadHistoryOnly();
    } catch (e: any) {
      console.error(e);
      setError(e?.message || '데이터를 불러오는 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, [loadSheetData, loadHistoryOnly]);

  // ─── 새로고침: 데이터 로드 + 이력 업데이트 (스냅샷 비교) ───
  const refreshWithHistoryUpdate = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const rows = await loadSheetData();
      setData(rows);

      const uniqueNames = [...new Set(rows.map((r) => r.campgroundName).filter(Boolean))];
      const mdMap: Record<string, string> = {};
      rows.forEach((r) => { if (r.campgroundName && r.md && !mdMap[r.campgroundName]) mdMap[r.campgroundName] = r.md; });

      setHistoryError(null);
      try {
        const histRes = await fetch('/api/campfit-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentNames: uniqueNames, mdMap }) });
        const histJson = await histRes.json();
        if (histJson.configured) {
          setHistoryConfigured(true);
          setHistorySource(histJson.configStatus?.source || '');
          // POST 결과에서 바로 이탈/재입점 가져오기
          setLostCampgrounds(histJson.lost || []);
          setRejoinedCampgrounds(histJson.rejoined || []);
          // 런타임 오류가 있으면 경고 표시 (설정은 됨)
          if (histJson.runtimeError) {
            setHistoryError(`⚠️ 연동은 설정되었으나 API 오류: ${histJson.error || '알 수 없는 오류'}`);
          }
          try { window.localStorage.removeItem(LS_SNAPSHOT_KEY); window.localStorage.removeItem(LS_HISTORY_KEY); } catch {}
          // 전체 이력도 다시 가져오기
          const getRes = await fetch('/api/campfit-history');
          const getJson = await getRes.json();
          if (getJson.history) setHistoryRecords(getJson.history);
        } else {
          setHistoryConfigured(false);
          setHistoryError(histJson.error || histJson.message || '서버 연동 실패');
          const local = localCalculateChurn(uniqueNames);
          setLostCampgrounds(local.lost);
          setRejoinedCampgrounds(local.rejoined);
        }
      } catch (histErr: any) {
        setHistoryConfigured(false);
        setHistoryError(histErr?.message || '이력 API 호출 실패');
        const local = localCalculateChurn(uniqueNames);
        setLostCampgrounds(local.lost);
        setRejoinedCampgrounds(local.rejoined);
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || '데이터를 불러오는 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, [loadSheetData]);

  // ─── 이력 초기화 ───
  const resetHistory = useCallback(async () => {
    if (!confirm('⚠️ 이력(이탈/재입점 기록)을 모두 초기화하시겠습니까?\n\n초기화 후 현재 시트 상태가 새로운 기준이 됩니다.')) return;
    setResetting(true);
    try {
      // 서버 초기화
      const res = await fetch('/api/campfit-history', { method: 'DELETE' });
      const json = await res.json();
      if (json.success || !json.configured) {
        // localStorage도 클리어
        try { window.localStorage.removeItem(LS_SNAPSHOT_KEY); window.localStorage.removeItem(LS_HISTORY_KEY); } catch {}
        setLostCampgrounds([]);
        setRejoinedCampgrounds([]);
        setHistoryRecords([]);
        alert('✅ 이력이 초기화되었습니다.\n\n다음 새로고침 시 현재 시트 상태가 새로운 기준이 됩니다.');
      } else {
        alert(`❌ 초기화 실패: ${json.error || '알 수 없는 오류'}`);
      }
    } catch (e: any) {
      alert(`❌ 초기화 실패: ${e?.message || '네트워크 오류'}`);
    } finally {
      setResetting(false);
    }
  }, []);

  // ─── 거래액/매출 데이터 로드 ───
  const loadTransactions = useCallback(async () => {
    try {
      setTxLoading(true);
      setTxError(null);
      const ts = Date.now();
      const res = await fetch(`/api/campfit-transactions?t=${ts}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`거래액 API 오류 (${res.status})`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setTxData(json.data || null);
    } catch (e: any) {
      console.error('[Transactions]', e);
      setTxError(e?.message || '거래액/매출 데이터 로드 실패');
    } finally {
      setTxLoading(false);
    }
  }, []);

  // 거래액 탭 처음 클릭 시 데이터 로드
  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    if (tab === 'transactions' && !txData && !txLoading) {
      loadTransactions();
    }
  }, [txData, txLoading, loadTransactions]);

  useEffect(() => { initialLoad(); }, [initialLoad]);

  // ─── 필터 적용 데이터 ───
  const filteredData = useMemo(() => {
    return data.filter((r) => {
      if (filterType !== '전체' && r.campgroundType !== filterType) return false;
      if (filterGrade !== '전체' && (r.grade || '미지정') !== filterGrade) return false;
      return true;
    });
  }, [data, filterType, filterGrade]);

  // ─── 유형 & 등급 옵션 목록 ───
  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => set.add(r.campgroundType));
    return ['전체', ...['오토캠핑', '글램핑', '카라반', '펜션', '방가로', '차박', '기타'].filter((t) => set.has(t))];
  }, [data]);

  const gradeOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => set.add(r.grade || '미지정'));
    return ['전체', ...['S', 'A', 'B', 'C', 'D'].filter((g) => set.has(g)), ...(set.has('미지정') ? ['미지정'] : [])];
  }, [data]);

  // ─── 기간 옵션 ───
  const allDates = useMemo(() => {
    const dates: Date[] = [];
    data.forEach((r) => { const d = parseDate(r.planStartDate); if (d) dates.push(d); });
    return dates;
  }, [data]);
  const availableMonths = useMemo(() => { const set = new Set<string>(); allDates.forEach((d) => set.add(getMonthKey(d))); return [...set].sort().reverse(); }, [allDates]);
  const availableWeeks = useMemo(() => { const set = new Set<string>(); allDates.forEach((d) => set.add(getWeekKey(d))); return [...set].sort().reverse(); }, [allDates]);

  // 이력 기반 기간 옵션 (이탈/재입점 이력의 날짜에서 추출)
  const historyMonths = useMemo(() => {
    const set = new Set<string>();
    // 이력 기록 날짜에서 추출
    historyRecords.forEach((h) => {
      const d = parseHistoryDate(h.date);
      if (d) set.add(getMonthKey(d));
    });
    // 현재 월도 추가
    set.add(getMonthKey(now));
    return [...set].sort().reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRecords]);

  const historyWeeks = useMemo(() => {
    const set = new Set<string>();
    historyRecords.forEach((h) => {
      const d = parseHistoryDate(h.date);
      if (d) set.add(getWeekKey(d));
    });
    set.add(getWeekKey(now));
    return [...set].sort().reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRecords]);

  useEffect(() => {
    if (data.length > 0) {
      const curMonth = getMonthKey(now);
      if (!changesPeriodValue) setChangesPeriodValue(availableMonths.includes(curMonth) ? curMonth : availableMonths[0] || curMonth);
      if (!mdPeriodValue) setMdPeriodValue(availableMonths.includes(curMonth) ? curMonth : availableMonths[0] || curMonth);
      if (!churnPeriodValue) setChurnPeriodValue(curMonth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ─── 전체 현황 집계 ───
  const totalRecords = filteredData.length;
  const totalCampgrounds = useMemo(() => new Set(filteredData.map((r) => r.campgroundName)).size, [filteredData]);
  const { activeRecords, endedRecords } = useMemo(() => {
    let active = 0, ended = 0;
    filteredData.forEach((r) => { if (isEnded(r)) ended++; else active++; });
    return { activeRecords: active, endedRecords: ended };
  }, [filteredData]);

  const typeStats = useMemo(() => countByKey(filteredData, (r) => r.campgroundType), [filteredData]);
  const gradeStats = useMemo(() => countByKey(filteredData, (r) => r.grade || '미지정'), [filteredData]);
  const planDistribution = useMemo(() => countByKey(filteredData, (r) => r.mainPlanName?.trim() || '미지정'), [filteredData]);
  const operateStatusStats = useMemo(() => countByKey(filteredData, (r) => r.operateStatus?.trim() || '미기재'), [filteredData]);
  const planStatusStats = useMemo(() => countByKey(filteredData, (r) => r.planStatus?.trim() || '미기재'), [filteredData]);

  // ★ 유형 × 등급 교차분석
  const typeCrossGrade = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    const allGrades = new Set<string>();
    filteredData.forEach((r) => {
      const t = r.campgroundType;
      const g = r.grade || '미지정';
      allGrades.add(g);
      if (!map.has(t)) map.set(t, new Map());
      const inner = map.get(t)!;
      inner.set(g, (inner.get(g) ?? 0) + 1);
    });
    const gradeKeys = ['S', 'A', 'B', 'C', 'D', '미지정'].filter((g) => allGrades.has(g));
    const rows = [...map.entries()].map(([type, gradeMap]) => {
      const row: Record<string, string | number> = { type, total: 0 };
      gradeKeys.forEach((g) => { row[g] = gradeMap.get(g) ?? 0; row.total = (row.total as number) + (gradeMap.get(g) ?? 0); });
      return row;
    }).sort((a, b) => (b.total as number) - (a.total as number));
    return { rows, gradeKeys };
  }, [filteredData]);

  // ─── 캠핑장별 최초 등록일 ───
  const campgroundFirstDate = useMemo(() => {
    const map = new Map<string, Date>();
    data.forEach((r) => {
      const d = parseDate(r.planStartDate);
      if (!d) return;
      const existing = map.get(r.campgroundName);
      if (!existing || isBefore(d, existing)) map.set(r.campgroundName, d);
    });
    return map;
  }, [data]);

  // ─── 신규/이탈/변경 현황 ───
  const changesRange = useMemo(() => changesPeriodValue ? getPeriodRange(changesPeriodType, changesPeriodValue) : null, [changesPeriodType, changesPeriodValue]);
  const changesPeriodLabel = useMemo(() => !changesPeriodValue ? '' : changesPeriodType === 'week' ? getWeekLabel(changesPeriodValue) : getMonthLabel(changesPeriodValue), [changesPeriodType, changesPeriodValue]);

  const periodTrueNew = useMemo(() => {
    if (!changesRange) return [];
    const newCampgrounds = new Set<string>();
    campgroundFirstDate.forEach((firstDate, name) => { if (dateInRange(firstDate, changesRange.start, changesRange.end)) newCampgrounds.add(name); });
    return filteredData.filter((r) => {
      if (!newCampgrounds.has(r.campgroundName)) return false;
      const d = parseDate(r.planStartDate);
      return d ? dateInRange(d, changesRange.start, changesRange.end) : false;
    });
  }, [filteredData, campgroundFirstDate, changesRange]);

  const periodTrueNewCampgrounds = useMemo(() => [...new Set(periodTrueNew.map((r) => r.campgroundName))], [periodTrueNew]);

  const periodPlanChanges = useMemo(() => {
    if (!changesRange) return [];
    return filteredData.filter((r) => {
      const d = parseDate(r.planStartDate);
      if (!d || !dateInRange(d, changesRange.start, changesRange.end)) return false;
      const firstDate = campgroundFirstDate.get(r.campgroundName);
      if (!firstDate) return false;
      return isBefore(firstDate, changesRange.start);
    });
  }, [filteredData, campgroundFirstDate, changesRange]);

  const periodPlanChangeCampgrounds = useMemo(() => [...new Set(periodPlanChanges.map((r) => r.campgroundName))], [periodPlanChanges]);

  // 신규/변경의 유형별·등급별 분석
  const newByType = useMemo(() => countByKey(periodTrueNew, (r) => r.campgroundType), [periodTrueNew]);
  const newByGrade = useMemo(() => countByKey(periodTrueNew, (r) => r.grade || '미지정'), [periodTrueNew]);
  const changeByType = useMemo(() => countByKey(periodPlanChanges, (r) => r.campgroundType), [periodPlanChanges]);
  const changeByGrade = useMemo(() => countByKey(periodPlanChanges, (r) => r.grade || '미지정'), [periodPlanChanges]);

  // ★ 이탈/재입점 이력을 기간별로 필터
  const churnRange = useMemo(() => churnPeriodValue ? getPeriodRange(churnPeriodType, churnPeriodValue) : null, [churnPeriodType, churnPeriodValue]);
  const churnPeriodLabel = useMemo(() => !churnPeriodValue ? '' : churnPeriodType === 'week' ? getWeekLabel(churnPeriodValue) : getMonthLabel(churnPeriodValue), [churnPeriodType, churnPeriodValue]);

  const filteredLost = useMemo(() => {
    if (!churnRange || historyRecords.length === 0) return lostCampgrounds; // 이력이 없으면 전체 표시
    return historyRecords
      .filter((h) => {
        if (h.type !== '이탈') return false;
        const d = parseHistoryDate(h.date);
        return d ? dateInRange(d, churnRange.start, churnRange.end) : false;
      })
      .map((h) => h.campground);
  }, [historyRecords, churnRange, lostCampgrounds]);

  const filteredRejoined = useMemo(() => {
    if (!churnRange || historyRecords.length === 0) return rejoinedCampgrounds;
    return historyRecords
      .filter((h) => {
        if (h.type !== '재입점') return false;
        const d = parseHistoryDate(h.date);
        return d ? dateInRange(d, churnRange.start, churnRange.end) : false;
      })
      .map((h) => h.campground);
  }, [historyRecords, churnRange, rejoinedCampgrounds]);

  // 추이 차트
  const newTrend = useMemo(() => {
    const map = new Map<string, number>();
    campgroundFirstDate.forEach((firstDate) => {
      const key = changesPeriodType === 'week' ? getWeekKey(firstDate) : getMonthKey(firstDate);
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return [...map.entries()].map(([period, count]) => ({
      period, label: changesPeriodType === 'week' ? format(parseISO(period), 'MM.dd') + '~' : period, count,
    })).sort((a, b) => a.period.localeCompare(b.period)).slice(-12);
  }, [campgroundFirstDate, changesPeriodType]);

  // ─── MD별 현황 ───
  const mdRange = useMemo(() => mdPeriodValue ? getPeriodRange(mdPeriodType, mdPeriodValue) : null, [mdPeriodType, mdPeriodValue]);
  const mdPeriodLabel = useMemo(() => !mdPeriodValue ? '' : mdPeriodType === 'week' ? getWeekLabel(mdPeriodValue) : getMonthLabel(mdPeriodValue), [mdPeriodType, mdPeriodValue]);

  const mdOverview = useMemo(() => {
    const map = new Map<string, {
      md: string; totalCount: number; activeCount: number; endedCount: number;
      periodTrueNew: number; periodPlanChange: number;
      campgrounds: Set<string>;
      types: Map<string, number>;
      grades: Map<string, number>;
    }>();

    filteredData.forEach((r) => {
      const md = r.md?.trim() || '미지정';
      if (!map.has(md)) {
        map.set(md, { md, totalCount: 0, activeCount: 0, endedCount: 0, periodTrueNew: 0, periodPlanChange: 0, campgrounds: new Set(), types: new Map(), grades: new Map() });
      }
      const stat = map.get(md)!;
      stat.totalCount += 1;
      stat.campgrounds.add(r.campgroundName);
      if (isEnded(r)) stat.endedCount += 1; else stat.activeCount += 1;

      stat.types.set(r.campgroundType, (stat.types.get(r.campgroundType) ?? 0) + 1);
      const g = r.grade || '미지정';
      stat.grades.set(g, (stat.grades.get(g) ?? 0) + 1);

      if (mdRange) {
        const firstDate = campgroundFirstDate.get(r.campgroundName);
        const d = parseDate(r.planStartDate);
        if (d && firstDate && dateInRange(d, mdRange.start, mdRange.end)) {
          if (dateInRange(firstDate, mdRange.start, mdRange.end)) stat.periodTrueNew += 1;
          else if (isBefore(firstDate, mdRange.start)) stat.periodPlanChange += 1;
        }
      }
    });

    return [...map.values()]
      .map((s) => ({
        md: s.md, totalCount: s.totalCount, activeCount: s.activeCount, endedCount: s.endedCount,
        periodTrueNew: s.periodTrueNew, periodPlanChange: s.periodPlanChange, campgroundCount: s.campgrounds.size,
        types: Object.fromEntries(s.types), grades: Object.fromEntries(s.grades),
      }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [filteredData, mdRange, campgroundFirstDate]);

  const mdNewChart = useMemo(() => mdOverview.filter((m) => m.periodTrueNew > 0).sort((a, b) => b.periodTrueNew - a.periodTrueNew).slice(0, 10), [mdOverview]);
  const topMd = useMemo(() => mdOverview.length === 0 ? null : [...mdOverview].sort((a, b) => b.periodTrueNew - a.periodTrueNew)[0], [mdOverview]);

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
          <h1 className="text-3xl font-bold text-red-700">⚠️ 데이터 로드 오류</h1>
          <p className="text-base text-gray-700 whitespace-pre-wrap break-words bg-red-50 p-4 rounded-lg">{error}</p>
          <button onClick={() => window.location.reload()} className="px-6 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-semibold">🔄 다시 시도</button>
        </div>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: '운영 현황', icon: '📊' },
    { key: 'changes', label: '신규 / 이탈 / 변경', icon: '📈' },
    { key: 'md', label: 'MD별 현황', icon: '👤' },
    { key: 'transactions', label: '거래액 / 매출', icon: '💰' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      {/* ─── 상세 리스트 모달 ─── */}
      {modalOpen && (
        <DetailListModal
          title={modalTitle}
          color={modalColor}
          mode={modalMode}
          records={modalRecords}
          names={modalNames}
          onClose={() => setModalOpen(false)}
        />
      )}

      {/* ─── 헤더 ─── */}
      <header className="bg-white/90 backdrop-blur-md border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent">
                캠핏 예약팀 대시보드
              </h1>
              <p className="text-xs md:text-sm text-gray-500 mt-1">
                Google Sheets 실시간 연동 · {format(now, 'yyyy.MM.dd HH:mm')}
                {historyConfigured === true && !historyError && <span className="ml-2 text-emerald-600 font-semibold">✅ 이력관리 활성{historySource ? ` (${historySource})` : ''}</span>}
                {historyConfigured === true && historyError && <span className="ml-2 text-blue-600 font-semibold">ℹ️ 이력: 연동됨 (일시 오류)</span>}
                {historyConfigured === false && <span className="ml-2 text-amber-600 font-semibold">⚠️ 이력: 브라우저 저장</span>}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-3 py-2 border-2 border-indigo-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 bg-white">
                {typeOptions.map((t) => <option key={t} value={t}>{t === '전체' ? '🏕️ 유형: 전체' : `🏕️ ${t}`}</option>)}
              </select>
              <select value={filterGrade} onChange={(e) => setFilterGrade(e.target.value)} className="px-3 py-2 border-2 border-purple-200 rounded-xl text-sm font-medium focus:border-purple-500 focus:ring-2 focus:ring-purple-200 bg-white">
                {gradeOptions.map((g) => <option key={g} value={g}>{g === '전체' ? '🏆 등급: 전체' : `🏆 ${g}등급`}</option>)}
              </select>
              <button onClick={refreshWithHistoryUpdate} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-all shadow-lg">
                🔄 새로고침 (이력 업데이트)
              </button>
              <div className="bg-indigo-50 text-indigo-700 px-3 py-2 rounded-lg text-sm font-bold">
                {filterType !== '전체' || filterGrade !== '전체' ? `필터 ${totalRecords.toLocaleString()}건` : `전체 ${data.length.toLocaleString()}건`}
              </div>
            </div>
          </div>
          <nav className="mt-4 flex gap-1 flex-wrap">
            {tabs.map((tab) => (
              <button key={tab.key} onClick={() => handleTabChange(tab.key)}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${activeTab === tab.key ? 'bg-indigo-600 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'}`}>
                {tab.icon} {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 md:px-6 py-6 space-y-6">

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
                <h2 className="text-lg font-bold text-gray-800 mb-4">🏕️ 유형별 입점 현황</h2>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={typeStats} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={2}
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine>
                        {typeStats.map((item) => <Cell key={item.name} fill={TYPE_COLORS[item.name] || '#94a3b8'} />)}
                      </Pie>
                      <Tooltip formatter={(value: number) => [value.toLocaleString() + '건', '등록 수']} contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 space-y-1.5">
                  {typeStats.map((item) => (
                    <div key={item.name} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ backgroundColor: TYPE_COLORS[item.name] || '#94a3b8' }} />{item.name}</span>
                      <span className="font-bold">{item.count.toLocaleString()}건 <span className="text-gray-400 font-normal">({totalRecords ? ((item.count / totalRecords) * 100).toFixed(1) : 0}%)</span></span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🏆 등급별 입점 현황</h2>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={gradeStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(value: number) => [value.toLocaleString() + '건', '등록 수']} contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }} />
                      <Bar dataKey="count" name="등록 수" radius={[6, 6, 0, 0]}>
                        {gradeStats.map((item) => <Cell key={item.name} fill={GRADE_COLORS[item.name] || '#94a3b8'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 space-y-1.5">
                  {gradeStats.map((item) => (
                    <div key={item.name} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ backgroundColor: GRADE_COLORS[item.name] || '#94a3b8' }} />{item.name}등급</span>
                      <span className="font-bold">{item.count.toLocaleString()}건 <span className="text-gray-400 font-normal">({totalRecords ? ((item.count / totalRecords) * 100).toFixed(1) : 0}%)</span></span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">📊 유형 × 등급 교차분석</h2>
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gradient-to-r from-indigo-50 to-purple-50">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold text-gray-700">유형</th>
                      {typeCrossGrade.gradeKeys.map((g) => <th key={g} className="text-right px-4 py-3 font-semibold text-gray-700">{g}등급</th>)}
                      <th className="text-right px-4 py-3 font-bold text-gray-900">합계</th>
                    </tr>
                  </thead>
                  <tbody>
                    {typeCrossGrade.rows.map((row) => (
                      <tr key={row.type as string} className="border-t border-gray-100 hover:bg-indigo-50/30">
                        <td className="px-4 py-3 font-bold text-gray-800 flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TYPE_COLORS[row.type as string] || '#94a3b8' }} />
                          {row.type as string}
                        </td>
                        {typeCrossGrade.gradeKeys.map((g) => (
                          <td key={g} className="text-right px-4 py-3">
                            {(row[g] as number) > 0 ? <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ backgroundColor: (GRADE_COLORS[g] || '#94a3b8') + '20', color: GRADE_COLORS[g] || '#64748b' }}>{(row[g] as number).toLocaleString()}</span> : <span className="text-gray-300">-</span>}
                          </td>
                        ))}
                        <td className="text-right px-4 py-3 font-bold text-gray-900">{(row.total as number).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">📋 대표플랜별 등록 현황</h2>
                <div className="max-h-[350px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0"><tr><th className="text-left px-4 py-3 font-semibold text-gray-700">대표플랜</th><th className="text-right px-4 py-3 font-semibold text-gray-700">등록 수</th><th className="text-right px-4 py-3 font-semibold text-gray-700">비율</th></tr></thead>
                    <tbody>
                      {planDistribution.map((item, i) => (
                        <tr key={item.name} className="border-t border-gray-100 hover:bg-blue-50/50">
                          <td className="px-4 py-3 font-medium text-gray-800 flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />{item.name}</td>
                          <td className="px-4 py-3 text-right font-bold">{item.count.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{totalRecords ? ((item.count / totalRecords) * 100).toFixed(1) : 0}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🥧 대표플랜 비율</h2>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={planDistribution} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={110} paddingAngle={2}
                        label={({ name, percent }) => `${String(name).length > 8 ? String(name).slice(0, 8) + '…' : name} ${(percent * 100).toFixed(0)}%`} labelLine>
                        {planDistribution.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
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

            <DataTable data={filteredData} title="전체 캠핑장 / 플랜 리스트" />
          </>
        )}

        {/* ═══ 탭 2: 신규 / 이탈 / 변경 ═══ */}
        {activeTab === 'changes' && (
          <>
            <PeriodSelector periodType={changesPeriodType} periodValue={changesPeriodValue} availableMonths={availableMonths} availableWeeks={availableWeeks}
              onTypeChange={(t) => { setChangesPeriodType(t); if (t === 'week') setChangesPeriodValue(availableWeeks[0] || getWeekKey(now)); else setChangesPeriodValue(availableMonths[0] || getMonthKey(now)); }}
              onValueChange={setChangesPeriodValue} label={changesPeriodLabel} />

            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard label="신규 입점" value={`${periodTrueNewCampgrounds.length}`} sub={`${changesPeriodLabel} · 처음 등장한 캠핑장`} gradient="from-emerald-500 to-green-600"
                onClick={() => openDetailModal(`🆕 ${changesPeriodLabel} 신규 입점 캠핑장 (${periodTrueNewCampgrounds.length}개)`, 'emerald', periodTrueNew)} />
              <KPICard label="플랜 변경/추가" value={`${periodPlanChangeCampgrounds.length}`} sub={`${changesPeriodLabel} · 기존 캠핑장 새 플랜`} gradient="from-purple-500 to-violet-600"
                onClick={() => openDetailModal(`🔄 ${changesPeriodLabel} 플랜 변경/추가 (${periodPlanChangeCampgrounds.length}개 캠핑장)`, 'purple', periodPlanChanges)} />
              <KPICard label={`이탈 (${churnPeriodLabel || '전체'})`} value={filteredLost.length.toLocaleString()} sub="스냅샷 기반 이탈" gradient="from-rose-500 to-red-600"
                onClick={() => openDetailModal(`🔴 이탈 캠핑장 (${filteredLost.length}개) — ${churnPeriodLabel || '전체'}`, 'red', undefined, filteredLost)} />
              <KPICard label={`재입점 (${churnPeriodLabel || '전체'})`} value={filteredRejoined.length.toLocaleString()} sub="이전 이탈 후 복귀" gradient="from-amber-500 to-orange-600"
                onClick={() => openDetailModal(`🟢 재입점 캠핑장 (${filteredRejoined.length}개) — ${churnPeriodLabel || '전체'}`, 'amber', undefined, filteredRejoined)} />
            </section>

            {/* 유형별·등급별 신규/변경 분석 */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🏕️ 신규 입점 유형·등급별</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">유형별</h3>
                    {newByType.length === 0 ? <p className="text-xs text-gray-400">없음</p> : newByType.map((item) => (
                      <div key={item.name} className="flex justify-between text-sm py-1">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[item.name] || '#94a3b8' }} />{item.name}</span>
                        <span className="font-bold">{item.count}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">등급별</h3>
                    {newByGrade.length === 0 ? <p className="text-xs text-gray-400">없음</p> : newByGrade.map((item) => (
                      <div key={item.name} className="flex justify-between text-sm py-1">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: GRADE_COLORS[item.name] || '#94a3b8' }} />{item.name}</span>
                        <span className="font-bold">{item.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">🔄 플랜 변경/추가 유형·등급별</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">유형별</h3>
                    {changeByType.length === 0 ? <p className="text-xs text-gray-400">없음</p> : changeByType.map((item) => (
                      <div key={item.name} className="flex justify-between text-sm py-1">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[item.name] || '#94a3b8' }} />{item.name}</span>
                        <span className="font-bold">{item.count}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-600 mb-2">등급별</h3>
                    {changeByGrade.length === 0 ? <p className="text-xs text-gray-400">없음</p> : changeByGrade.map((item) => (
                      <div key={item.name} className="flex justify-between text-sm py-1">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: GRADE_COLORS[item.name] || '#94a3b8' }} />{item.name}</span>
                        <span className="font-bold">{item.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* 추이 차트 */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-4">📈 {changesPeriodType === 'week' ? '주별' : '월별'} 신규 캠핑장 입점 추이</h2>
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
              <h2 className="text-lg font-bold text-gray-800 mb-4">🆕 {changesPeriodLabel} 신규 입점 — {periodTrueNewCampgrounds.length}개 캠핑장 ({periodTrueNew.length}건)</h2>
              {periodTrueNew.length === 0 ? <p className="text-gray-500 text-sm">해당 기간에 신규 입점 캠핑장이 없습니다.</p> : (
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-emerald-50 sticky top-0"><tr>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">캠핑장명</th>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">유형</th>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">등급</th>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">대표플랜</th>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">플랜등록일</th>
                      <th className="text-left px-4 py-2 font-semibold text-emerald-800">담당 MD</th>
                    </tr></thead>
                    <tbody>
                      {periodTrueNew.map((r) => (
                        <tr key={r.rowNumber} className="border-t border-gray-100 hover:bg-emerald-50/50">
                          <td className="px-4 py-2 font-medium">{r.campgroundName}</td>
                          <td className="px-4 py-2"><TypeBadge type={r.campgroundType} /></td>
                          <td className="px-4 py-2"><GradeBadge grade={r.grade} /></td>
                          <td className="px-4 py-2">{r.mainPlanName || '-'}</td>
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
              <h2 className="text-lg font-bold text-gray-800 mb-4">🔄 {changesPeriodLabel} 플랜 변경/추가 — {periodPlanChangeCampgrounds.length}개 캠핑장 ({periodPlanChanges.length}건)</h2>
              {periodPlanChanges.length === 0 ? <p className="text-gray-500 text-sm">해당 기간에 플랜 변경/추가 건이 없습니다.</p> : (
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-purple-50 sticky top-0"><tr>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">캠핑장명</th>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">유형</th>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">등급</th>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">대표플랜</th>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">플랜등록일</th>
                      <th className="text-left px-4 py-2 font-semibold text-purple-800">담당 MD</th>
                    </tr></thead>
                    <tbody>
                      {periodPlanChanges.map((r) => (
                        <tr key={r.rowNumber} className="border-t border-gray-100 hover:bg-purple-50/50">
                          <td className="px-4 py-2 font-medium">{r.campgroundName}</td>
                          <td className="px-4 py-2"><TypeBadge type={r.campgroundType} /></td>
                          <td className="px-4 py-2"><GradeBadge grade={r.grade} /></td>
                          <td className="px-4 py-2">{r.mainPlanName || '-'}</td>
                          <td className="px-4 py-2">{r.planStartDate || '-'}</td>
                          <td className="px-4 py-2">{r.md || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ─── 이탈 / 재입점 (기간별 조회) ─── */}
            <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <h2 className="text-lg font-bold text-gray-800">🔴🟢 이탈 / 재입점 현황</h2>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
                    <button onClick={() => { setChurnPeriodType('week'); setChurnPeriodValue(historyWeeks[0] || getWeekKey(now)); }} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${churnPeriodType === 'week' ? 'bg-indigo-600 text-white shadow' : 'text-gray-600'}`}>📅 주간</button>
                    <button onClick={() => { setChurnPeriodType('month'); setChurnPeriodValue(historyMonths[0] || getMonthKey(now)); }} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${churnPeriodType === 'month' ? 'bg-indigo-600 text-white shadow' : 'text-gray-600'}`}>🗓️ 월간</button>
                  </div>
                  <select value={churnPeriodValue} onChange={(e) => setChurnPeriodValue(e.target.value)} className="px-3 py-2 border-2 border-gray-300 rounded-xl text-sm font-medium focus:border-indigo-500 min-w-[180px]">
                    {(churnPeriodType === 'week' ? historyWeeks : historyMonths).map((opt) => (
                      <option key={opt} value={opt}>{churnPeriodType === 'week' ? getWeekLabel(opt) : getMonthLabel(opt)}</option>
                    ))}
                  </select>
                  <button onClick={resetHistory} disabled={resetting} className="px-3 py-2 rounded-xl bg-red-100 text-red-700 text-xs font-semibold hover:bg-red-200 transition-all disabled:opacity-50">
                    {resetting ? '초기화 중...' : '🗑️ 이력 초기화'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                ⓘ 이탈/재입점은 <strong>새로고침 (이력 업데이트)</strong> 버튼을 눌러야 현재 시트와 이전 스냅샷을 비교하여 기록됩니다. 기간: <strong>{churnPeriodLabel || '전체'}</strong>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <ChurnList title="🔴 이탈 캠핑장" items={filteredLost} color="red" emptyMessage={`${churnPeriodLabel || '해당 기간'}에 이탈한 캠핑장이 없습니다.`} />
                <ChurnList title="🟢 재입점 캠핑장" items={filteredRejoined} color="emerald" emptyMessage={`${churnPeriodLabel || '해당 기간'}에 재입점한 캠핑장이 없습니다.`} />
              </div>
            </section>

            {/* 이력 기록 */}
            {historyConfigured && historyRecords.length > 0 && (
              <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
                <h2 className="text-lg font-bold text-gray-800 mb-4">📜 이력관리 기록 (최근 50건)</h2>
                <div className="max-h-[300px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0"><tr>
                      <th className="text-left px-4 py-2 font-semibold text-gray-700">날짜시간</th>
                      <th className="text-left px-4 py-2 font-semibold text-gray-700">캠핑장명</th>
                      <th className="text-left px-4 py-2 font-semibold text-gray-700">이벤트</th>
                      <th className="text-left px-4 py-2 font-semibold text-gray-700">담당 MD</th>
                    </tr></thead>
                    <tbody>
                      {historyRecords.slice(-50).reverse().map((h, i) => (
                        <tr key={i} className="border-t border-gray-100"><td className="px-4 py-2 text-gray-600 text-xs">{h.date}</td><td className="px-4 py-2 font-medium">{h.campground}</td>
                          <td className="px-4 py-2"><span className={`px-2 py-1 rounded-full text-xs font-semibold ${h.type === '이탈' ? 'bg-red-100 text-red-700' : h.type === '재입점' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>{h.type}</span></td>
                          <td className="px-4 py-2">{h.md || '-'}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {/* 런타임 오류 (설정은 됐지만 API 오류) */}
            {historyConfigured === true && historyError && (
              <section className="bg-blue-50 rounded-2xl border-2 border-blue-200 p-5">
                <div className="flex items-start gap-3">
                  <span className="text-2xl">ℹ️</span>
                  <div className="flex-1">
                    <h2 className="text-base font-bold text-blue-800 mb-1">이력관리 서버 연동됨 — 일시적 오류</h2>
                    <p className="text-sm text-blue-700">{historyError}</p>
                    <p className="text-xs text-blue-500 mt-1">서비스 계정은 정상 설정되어 있습니다. 새로고침 시 자동 재시도됩니다.</p>
                  </div>
                  <button onClick={() => refreshWithHistoryUpdate()} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700">🔄 재시도</button>
                </div>
              </section>
            )}
            {/* 미설정 (서비스 계정 키가 아예 없음) */}
            {historyConfigured === false && (
              <section className="bg-amber-50 rounded-2xl border-2 border-amber-200 p-6">
                <h2 className="text-lg font-bold text-amber-800 mb-2">⚠️ 이력관리 서버 연동이 설정되지 않았습니다</h2>
                <p className="text-sm text-amber-700 mb-3">현재 이탈/재입점 기록이 브라우저에만 저장되어, 다른 기기에서는 볼 수 없습니다.</p>
                {historyError && <div className="bg-red-50 rounded-xl p-4 mb-3 border border-red-200"><p className="text-sm font-bold text-red-800 mb-1">🔍 연동 실패 원인:</p><p className="text-sm text-red-700 break-all">{historyError}</p></div>}
                <div className="bg-white rounded-xl p-4 text-sm text-gray-700 space-y-2">
                  <p className="font-bold">📝 설정 방법:</p>
                  <ol className="list-decimal list-inside space-y-1 pl-2">
                    <li>Google Cloud Console에서 서비스 계정 생성</li><li>Google Sheets API 활성화</li><li>서비스 계정 JSON 키 다운로드</li>
                    <li>해당 스프레드시트를 서비스 계정 이메일로 공유 (편집 권한)</li>
                    <li><strong>로컬:</strong> JSON 키 파일을 프로젝트 루트에 배치</li>
                    <li><strong>Vercel:</strong> <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">GOOGLE_SERVICE_ACCOUNT_KEY</code>에 JSON 키 전체 입력 후 <strong className="text-red-600">재배포!</strong></li>
                  </ol>
                </div>
              </section>
            )}
          </>
        )}

        {/* ═══ 탭 3: MD별 현황 ═══ */}
        {activeTab === 'md' && (
          <>
            <PeriodSelector periodType={mdPeriodType} periodValue={mdPeriodValue} availableMonths={availableMonths} availableWeeks={availableWeeks}
              onTypeChange={(t) => { setMdPeriodType(t); if (t === 'week') setMdPeriodValue(availableWeeks[0] || getWeekKey(now)); else setMdPeriodValue(availableMonths[0] || getMonthKey(now)); }}
              onValueChange={setMdPeriodValue} label={mdPeriodLabel} />

            <section className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <KPICard label="전체 MD 수" value={mdOverview.filter((m) => m.md !== '미지정').length.toLocaleString()} sub="담당 MD 지정된 수" gradient="from-blue-500 to-indigo-600" />
              <KPICard label={`${mdPeriodLabel} 신규 입점 1위`} value={topMd?.md || '-'} sub={topMd && topMd.periodTrueNew > 0 ? `${topMd.periodTrueNew}건` : '해당 기간 신규 없음'} gradient="from-amber-500 to-orange-600" />
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
                      <th className="text-left px-3 py-3 font-semibold text-indigo-800">#</th>
                      <th className="text-left px-3 py-3 font-semibold text-indigo-800">담당 MD</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">캠핑장</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">전체</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">정상</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">종료</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">{mdPeriodLabel} 신규</th>
                      <th className="text-right px-3 py-3 font-semibold text-indigo-800">변경</th>
                      <th className="text-left px-3 py-3 font-semibold text-indigo-800">유형 분포</th>
                      <th className="text-left px-3 py-3 font-semibold text-indigo-800">등급 분포</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mdOverview.map((m, i) => (
                      <tr key={m.md} className="border-t border-gray-100 hover:bg-indigo-50/30 transition-colors">
                        <td className="px-3 py-3 text-gray-500">{i + 1}</td>
                        <td className="px-3 py-3 font-bold text-gray-900">{m.md}</td>
                        <td className="px-3 py-3 text-right">{m.campgroundCount.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">{m.totalCount.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-emerald-600 font-medium">{m.activeCount.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-red-600 font-medium">{m.endedCount.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">
                          {m.periodTrueNew > 0 ? <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">+{m.periodTrueNew}</span> : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {m.periodPlanChange > 0 ? <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-bold">{m.periodPlanChange}</span> : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(m.types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => (
                              <span key={t} className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: (TYPE_COLORS[t] || '#94a3b8') + '20', color: TYPE_COLORS[t] || '#64748b' }}>{t} {c}</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(m.grades).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, c]) => (
                              <span key={g} className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: (GRADE_COLORS[g] || '#94a3b8') + '20', color: GRADE_COLORS[g] || '#64748b' }}>{g} {c}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* ═══ 탭 4: 거래액 / 매출 ═══ */}
        {activeTab === 'transactions' && (
          <>
            {txLoading && (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-600 border-t-transparent mx-auto mb-3" />
                  <div className="text-lg font-bold text-gray-700">거래액 / 매출 데이터 로딩 중...</div>
                </div>
              </div>
            )}
            {txError && (
              <section className="bg-red-50 rounded-2xl border-2 border-red-200 p-6">
                <h2 className="text-lg font-bold text-red-800 mb-2">⚠️ 거래액/매출 데이터 로드 실패</h2>
                <p className="text-sm text-red-700 mb-3">{txError}</p>
                <button onClick={loadTransactions} className="px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold">🔄 다시 시도</button>
              </section>
            )}
            {txData && !txLoading && (
              <TransactionDashboard data={txData} onRefresh={loadTransactions} />
            )}
            {!txData && !txLoading && !txError && (
              <div className="flex items-center justify-center py-20">
                <button onClick={loadTransactions} className="px-6 py-3 rounded-xl bg-amber-600 text-white font-semibold hover:bg-amber-700 transition-all shadow-lg">
                  💰 거래액/매출 데이터 불러오기
                </button>
              </div>
            )}
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
        <select value={periodValue} onChange={(e) => onValueChange(e.target.value)} className="px-4 py-2.5 border-2 border-gray-300 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 min-w-[200px]">
          {options.map((opt) => <option key={opt} value={opt}>{periodType === 'week' ? getWeekLabel(opt) : getMonthLabel(opt)}</option>)}
        </select>
        <span className="text-sm text-indigo-600 font-bold hidden sm:block">선택: {label}</span>
      </div>
    </section>
  );
}

function KPICard({ label, value, sub, gradient, onClick }: { label: string; value: string; sub?: string; gradient: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`bg-gradient-to-br ${gradient} text-white rounded-2xl shadow-lg p-5 transform hover:scale-[1.02] transition-all ${onClick ? 'cursor-pointer ring-0 hover:ring-4 hover:ring-white/30' : ''}`}
    >
      <div className="text-xs md:text-sm font-medium text-white/80 mb-1">{label}</div>
      <div className="text-2xl md:text-3xl font-extrabold truncate">{value}</div>
      {sub && <div className="text-[11px] md:text-xs text-white/70 mt-1">{sub}</div>}
      {onClick && <div className="text-[10px] text-white/50 mt-2 flex items-center gap-1">👆 클릭하여 상세 목록 보기</div>}
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
              <div className="flex justify-between text-sm mb-1"><span className="font-medium text-gray-700">{item.name}</span><span className="text-gray-600">{item.count.toLocaleString()}건 ({pct.toFixed(1)}%)</span></div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChurnList({ title, items, color, emptyMessage }: { title: string; items: string[]; color: 'red' | 'emerald'; emptyMessage: string }) {
  const bgMap = { red: 'bg-red-100', emerald: 'bg-emerald-100' };
  const textMap = { red: 'text-red-700', emerald: 'text-emerald-700' };
  const itemBg = { red: 'bg-red-50', emerald: 'bg-emerald-50' };
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className={`text-lg font-bold ${textMap[color]}`}>{title}</h2>
        <span className={`px-3 py-1 rounded-full ${bgMap[color]} ${textMap[color]} text-sm font-bold`}>{items.length}개</span>
      </div>
      {items.length === 0 ? <p className="text-gray-500 text-sm">{emptyMessage}</p> : (
        <ul className="max-h-[250px] overflow-auto text-sm space-y-1">
          {items.map((name, i) => <li key={`${name}-${i}`} className={`px-3 py-2 ${itemBg[color]} rounded-lg text-gray-800`}>{name}</li>)}
        </ul>
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: CampgroundType }) {
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: (TYPE_COLORS[type] || '#94a3b8') + '20', color: TYPE_COLORS[type] || '#64748b' }}>{type}</span>;
}

function GradeBadge({ grade }: { grade?: string }) {
  const g = grade || '미지정';
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ backgroundColor: (GRADE_COLORS[g] || '#94a3b8') + '20', color: GRADE_COLORS[g] || '#64748b' }}>{g}</span>;
}

function DataTable({ data, title }: { data: CampfitPlanRecord[]; title: string }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter((r) => r.campgroundName.toLowerCase().includes(q) || r.mainPlanName?.toLowerCase().includes(q) || r.md?.toLowerCase().includes(q) || r.detailPlanName?.toLowerCase().includes(q) || r.campgroundType.toLowerCase().includes(q) || r.grade?.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-gray-800">📋 {title} ({filtered.length.toLocaleString()}건)</h2>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="캠핑장명, 플랜, MD, 유형, 등급 검색..." className="px-4 py-2 border-2 border-gray-300 rounded-xl text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 w-full sm:w-72" />
      </div>
      <div className="max-h-[600px] overflow-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white sticky top-0">
            <tr>
              <th className="px-3 py-3 text-left font-semibold">#</th>
              <th className="px-3 py-3 text-left font-semibold">캠핑장명</th>
              <th className="px-3 py-3 text-left font-semibold">유형</th>
              <th className="px-3 py-3 text-left font-semibold">등급</th>
              <th className="px-3 py-3 text-left font-semibold">운영상태</th>
              <th className="px-3 py-3 text-left font-semibold hidden md:table-cell">세부플랜</th>
              <th className="px-3 py-3 text-left font-semibold">대표플랜</th>
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
                    <td className="px-3 py-2"><TypeBadge type={row.campgroundType} /></td>
                    <td className="px-3 py-2"><GradeBadge grade={row.grade} /></td>
                    <td className="px-3 py-2"><StatusBadge value={row.operateStatus} type="operate" /></td>
                    <td className="px-3 py-2 text-gray-700 hidden md:table-cell">{row.detailPlanName || '-'}</td>
                    <td className="px-3 py-2 text-gray-700">{row.mainPlanName || '-'}</td>
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

// ═══════════════════════════════════════
// 상세 리스트 모달
// ═══════════════════════════════════════
const COLOR_MAP = {
  emerald: { bg: 'bg-emerald-50', header: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200', badge: 'bg-emerald-600' },
  purple: { bg: 'bg-purple-50', header: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200', badge: 'bg-purple-600' },
  red: { bg: 'bg-red-50', header: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', badge: 'bg-red-600' },
  amber: { bg: 'bg-amber-50', header: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200', badge: 'bg-amber-600' },
};

function DetailListModal({
  title,
  color,
  mode,
  records,
  names,
  onClose,
}: {
  title: string;
  color: 'emerald' | 'purple' | 'red' | 'amber';
  mode: 'records' | 'names';
  records: CampfitPlanRecord[];
  names: string[];
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const cm = COLOR_MAP[color];

  // 검색 필터
  const filteredRecords = useMemo(() => {
    if (!search.trim()) return records;
    const q = search.trim().toLowerCase();
    return records.filter((r) =>
      r.campgroundName.toLowerCase().includes(q) ||
      (r.md || '').toLowerCase().includes(q) ||
      (r.mainPlanName || '').toLowerCase().includes(q)
    );
  }, [records, search]);

  const filteredNames = useMemo(() => {
    if (!search.trim()) return names;
    const q = search.trim().toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(q));
  }, [names, search]);

  // 중복 제거된 캠핑장 목록 (records 모드)
  const uniqueCampgrounds = useMemo(() => {
    const map = new Map<string, CampfitPlanRecord>();
    filteredRecords.forEach((r) => {
      if (!map.has(r.campgroundName)) map.set(r.campgroundName, r);
    });
    return [...map.values()];
  }, [filteredRecords]);

  const totalCount = mode === 'records' ? uniqueCampgrounds.length : filteredNames.length;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-in"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'modalSlideUp 0.25s ease-out' }}
      >
        {/* 모달 헤더 */}
        <div className={`${cm.header} px-6 py-4 border-b ${cm.border} flex items-center justify-between shrink-0`}>
          <div>
            <h2 className={`text-lg font-bold ${cm.text}`}>{title}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{totalCount}개 캠핑장</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-white/60 transition-all text-gray-500 hover:text-gray-800">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* 검색바 */}
        <div className="px-6 py-3 border-b border-gray-100 shrink-0">
          <input
            type="text"
            placeholder="🔍 캠핑장명, MD, 플랜 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border-2 border-gray-200 text-sm focus:border-indigo-400 focus:outline-none transition-all"
            autoFocus
          />
        </div>

        {/* 리스트 */}
        <div className="flex-1 overflow-auto px-6 py-3">
          {mode === 'records' ? (
            uniqueCampgrounds.length === 0 ? (
              <p className="text-center text-gray-400 py-10">해당하는 캠핑장이 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {uniqueCampgrounds.map((r, idx) => (
                  <div key={r.campgroundName + idx} className={`${cm.bg} rounded-xl p-4 border ${cm.border} hover:shadow-md transition-all`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`${cm.badge} text-white text-[10px] font-bold px-2 py-0.5 rounded-full`}>{idx + 1}</span>
                          <h3 className="font-bold text-gray-900 truncate">{r.campgroundName}</h3>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-gray-600">
                          {r.campgroundType && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ backgroundColor: (TYPE_COLORS[r.campgroundType] || '#94a3b8') + '15', color: TYPE_COLORS[r.campgroundType] || '#64748b' }}>{r.campgroundType}</span>}
                          {r.grade && <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ backgroundColor: (GRADE_COLORS[r.grade] || '#94a3b8') + '15', color: GRADE_COLORS[r.grade] || '#64748b' }}>{r.grade}등급</span>}
                          {r.mainPlanName && <span className="text-gray-500">📋 {r.mainPlanName}</span>}
                          {r.planStartDate && <span className="text-gray-500">📅 {r.planStartDate}</span>}
                        </div>
                      </div>
                      {r.md && (
                        <span className="text-xs font-semibold bg-gray-100 text-gray-600 px-2.5 py-1 rounded-lg shrink-0">👤 {r.md}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            filteredNames.length === 0 ? (
              <p className="text-center text-gray-400 py-10">해당하는 캠핑장이 없습니다.</p>
            ) : (
              <div className="space-y-1.5">
                {filteredNames.map((name, idx) => (
                  <div key={name + idx} className={`${cm.bg} rounded-xl px-4 py-3 border ${cm.border} hover:shadow-md transition-all flex items-center gap-3`}>
                    <span className={`${cm.badge} text-white text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0`}>{idx + 1}</span>
                    <span className="font-semibold text-gray-900">{name}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* 모달 푸터 */}
        <div className="px-6 py-3 border-t border-gray-100 bg-gray-50 shrink-0 flex items-center justify-between">
          <span className="text-xs text-gray-400">총 {totalCount}개</span>
          <button onClick={onClose} className="px-5 py-2 rounded-xl bg-gray-800 text-white text-sm font-semibold hover:bg-gray-900 transition-all">닫기</button>
        </div>
      </div>

      {/* 모달 애니메이션 - global style */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes modalSlideUp {
          from { opacity: 0; transform: translateY(20px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      ` }} />
    </div>
  );
}

function StatusBadge({ value, type }: { value?: string; type: 'operate' | 'plan' }) {
  if (!value) return <span className="text-gray-400">-</span>;
  const isGood = type === 'operate' ? value.includes('운영') || value.includes('정상') : value.includes('정상') || value.includes('사용');
  const isBad = type === 'operate' ? value.includes('중단') || value.includes('종료') : value.includes('종료') || value.includes('취소');
  const cls = isGood ? 'bg-emerald-100 text-emerald-700' : isBad ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700';
  return <span className={`px-2 py-1 rounded-full text-xs font-semibold ${cls}`}>{value}</span>;
}

// ═══════════════════════════════════════
// 거래액 / 매출 대시보드 컴포넌트
// ═══════════════════════════════════════

const YEAR_COLORS: Record<string, string> = {
  '2021': '#94a3b8', '2022': '#06b6d4', '2023': '#a855f7',
  '2024': '#f97316', '2025': '#22c55e', '2026': '#4f46e5',
};

const MONTH_LABELS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

function formatAmount(value: number, compact = false): string {
  if (value === 0) return '0';
  if (compact) {
    if (value >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(1)}억`;
    if (value >= 1_0000) return `${(value / 1_0000).toFixed(0)}만`;
    return value.toLocaleString();
  }
  return value.toLocaleString();
}

function TransactionDashboard({ data, onRefresh }: { data: TransactionData; onRefresh: () => void }) {
  const [selectedSection, setSelectedSection] = useState(0);
  const [selectedYears, setSelectedYears] = useState<Set<string>>(new Set());

  // 모든 연도 목록 추출
  const allYears = useMemo(() => {
    const set = new Set<string>();
    data.sections.forEach((s) => s.data.forEach((d) => set.add(d.year)));
    return [...set].sort();
  }, [data]);

  // 선택된 연도 (기본: 최근 3년)
  useEffect(() => {
    if (allYears.length > 0 && selectedYears.size === 0) {
      const recent = allYears.slice(-3);
      setSelectedYears(new Set(recent));
    }
  }, [allYears, selectedYears]);

  const currentSection = data.sections[selectedSection] || null;
  const isEmpty = !currentSection && data.sections.length === 0;

  // ★ 핵심 수정: 모든 Hook을 조건부 return 위에 배치 (React Hook 규칙)
  // 현재 섹션의 필터된 데이터
  const filteredData = useMemo(() => {
    if (!currentSection) return [];
    return currentSection.data.filter((d) => selectedYears.has(d.year));
  }, [currentSection, selectedYears]);

  // 월별 비교 차트 데이터
  const monthlyChartData = useMemo(() => {
    return MONTH_LABELS.map((label, idx) => {
      const item: Record<string, string | number> = { month: label };
      filteredData.forEach((yd) => {
        item[yd.year] = yd.months[idx] || 0;
      });
      return item;
    });
  }, [filteredData]);

  // 연도별 누계 비교
  const yearlyTotalData = useMemo(() => {
    return filteredData.map((yd) => ({
      year: yd.year,
      total: yd.total,
    }));
  }, [filteredData]);

  // 최신 연도의 최신 월 찾기 (값이 0이 아닌)
  const latestYearData = useMemo(() => {
    if (filteredData.length === 0) return null;
    const sorted = [...filteredData].sort((a, b) => b.year.localeCompare(a.year));
    return sorted[0];
  }, [filteredData]);

  const latestMonth = useMemo(() => {
    if (!latestYearData) return -1;
    for (let i = 11; i >= 0; i--) {
      if (latestYearData.months[i] > 0) return i;
    }
    return -1;
  }, [latestYearData]);

  // YoY 비교 (전년 동월 대비)
  const yoyComparison = useMemo(() => {
    if (!latestYearData || latestMonth < 0) return null;
    const prevYearStr = String(Number(latestYearData.year) - 1);
    const prevYearData = currentSection?.data.find((d) => d.year === prevYearStr);
    if (!prevYearData) return null;
    const current = latestYearData.months[latestMonth];
    const previous = prevYearData.months[latestMonth];
    if (previous === 0) return null;
    const changeRate = ((current - previous) / previous) * 100;
    return {
      currentYear: latestYearData.year,
      prevYear: prevYearStr,
      month: latestMonth + 1,
      current,
      previous,
      changeRate,
    };
  }, [latestYearData, latestMonth, currentSection]);

  // ★ 모든 Hook 이후에 조건부 return (빈 데이터 표시)
  if (isEmpty) {
    return (
      <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-4">💰 거래액 / 매출 데이터</h2>
        <p className="text-gray-500">B179:Q211 범위에서 파싱할 수 있는 데이터가 없습니다.</p>
        <p className="text-sm text-gray-400 mt-2">총 {data.totalRows}행이 읽혔습니다.</p>
        {data.rawRows.length > 0 && (
          <details className="mt-4">
            <summary className="text-sm text-indigo-600 cursor-pointer font-medium">📋 원본 데이터 확인 (디버깅)</summary>
            <div className="mt-2 max-h-[400px] overflow-auto">
              <table className="w-full text-xs border">
                <tbody>
                  {data.rawRows.map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1 bg-gray-50 font-mono text-gray-500">{179 + i}</td>
                      {row.map((cell, j) => (
                        <td key={j} className="px-2 py-1 border-l">{cell || <span className="text-gray-300">-</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        <button onClick={onRefresh} className="mt-4 px-4 py-2 rounded-xl bg-amber-600 text-white text-sm font-semibold">🔄 다시 불러오기</button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* 섹션 선택 + 연도 필터 */}
      <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          {/* 섹션 탭 */}
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 flex-wrap">
            {data.sections.map((s, idx) => (
              <button key={idx} onClick={() => setSelectedSection(idx)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${selectedSection === idx ? 'bg-amber-600 text-white shadow' : 'text-gray-600 hover:text-gray-900'}`}>
                {s.title.replace(/^[IVX]+\.\s*/, '')}
              </button>
            ))}
          </div>

          {/* 연도 필터 */}
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-xs text-gray-500 font-medium">연도:</span>
            {allYears.map((year) => (
              <button key={year} onClick={() => {
                const next = new Set(selectedYears);
                if (next.has(year)) next.delete(year); else next.add(year);
                if (next.size > 0) setSelectedYears(next);
              }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border-2 ${selectedYears.has(year)
                  ? 'text-white border-transparent shadow'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'}`}
                style={selectedYears.has(year) ? { backgroundColor: YEAR_COLORS[year] || '#4f46e5', borderColor: YEAR_COLORS[year] || '#4f46e5' } : {}}>
                {year}
              </button>
            ))}
          </div>

          <button onClick={onRefresh} className="ml-auto px-3 py-2 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200">🔄</button>
        </div>
        {currentSection?.unit && <p className="text-xs text-gray-400 mt-2">{currentSection.unit}</p>}
      </section>

      {/* KPI 카드 */}
      {latestYearData && latestMonth >= 0 && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            label={`${latestYearData.year}년 누계`}
            value={formatAmount(latestYearData.total, true)}
            sub={currentSection?.title.replace(/^[IVX]+\.\s*/, '') || ''}
            gradient="from-amber-500 to-orange-600"
          />
          <KPICard
            label={`${latestYearData.year}년 ${latestMonth + 1}월`}
            value={formatAmount(latestYearData.months[latestMonth], true)}
            sub="최신 월 데이터"
            gradient="from-blue-500 to-indigo-600"
          />
          {yoyComparison && (
            <KPICard
              label={`전년 동월 대비 (${yoyComparison.month}월)`}
              value={`${yoyComparison.changeRate > 0 ? '+' : ''}${yoyComparison.changeRate.toFixed(1)}%`}
              sub={`${yoyComparison.prevYear}: ${formatAmount(yoyComparison.previous, true)}`}
              gradient={yoyComparison.changeRate >= 0 ? 'from-emerald-500 to-green-600' : 'from-rose-500 to-red-600'}
            />
          )}
          {filteredData.length >= 2 && (
            <KPICard
              label={`${filteredData[filteredData.length - 2]?.year}년 누계`}
              value={formatAmount(filteredData[filteredData.length - 2]?.total || 0, true)}
              sub="이전 연도 참고"
              gradient="from-gray-500 to-gray-600"
            />
          )}
        </section>
      )}

      {/* 월별 비교 라인 차트 */}
      <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-4">📈 월별 추이 비교 — {currentSection?.title.replace(/^[IVX]+\.\s*/, '')}</h2>
        <div className="h-80 md:h-96">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={monthlyChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => formatAmount(v, true)} />
              <Tooltip
                formatter={(value: number, name: string) => [formatAmount(value), `${name}년`]}
                contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }}
              />
              <Legend />
              {filteredData.map((yd) => (
                <Line
                  key={yd.year}
                  type="monotone"
                  dataKey={yd.year}
                  name={`${yd.year}년`}
                  stroke={YEAR_COLORS[yd.year] || '#4f46e5'}
                  strokeWidth={yd.year === latestYearData?.year ? 3 : 2}
                  dot={{ r: yd.year === latestYearData?.year ? 4 : 3 }}
                  activeDot={{ r: 6 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* 연도별 누계 막대 차트 */}
      <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-4">📊 연도별 누계 비교</h2>
        <div className="h-64 md:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={yearlyTotalData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="year" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => formatAmount(v, true)} />
              <Tooltip
                formatter={(value: number) => [formatAmount(value), '누계']}
                contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb' }}
              />
              <Bar dataKey="total" name="누계" radius={[8, 8, 0, 0]}>
                {yearlyTotalData.map((item) => (
                  <Cell key={item.year} fill={YEAR_COLORS[item.year] || '#4f46e5'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* 상세 테이블 */}
      <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
        <h2 className="text-lg font-bold text-gray-800 mb-4">📋 {currentSection?.title || '상세'} — 연도 × 월별 데이터</h2>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gradient-to-r from-amber-50 to-orange-50">
              <tr>
                <th className="text-left px-3 py-3 font-semibold text-amber-800 sticky left-0 bg-amber-50 z-10">연도</th>
                <th className="text-right px-3 py-3 font-semibold text-amber-800">누계</th>
                {MONTH_LABELS.map((m) => (
                  <th key={m} className="text-right px-3 py-3 font-semibold text-amber-800 whitespace-nowrap">{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredData.map((yd, idx) => (
                <tr key={yd.year} className={`border-t border-gray-100 ${idx === filteredData.length - 1 ? 'bg-amber-50/40 font-bold' : 'hover:bg-amber-50/30'}`}>
                  <td className="px-3 py-3 font-bold sticky left-0 bg-white z-10" style={{ color: YEAR_COLORS[yd.year] || '#4f46e5' }}>
                    {yd.year}
                  </td>
                  <td className="text-right px-3 py-3 font-bold text-gray-900">{formatAmount(yd.total)}</td>
                  {yd.months.map((val, mi) => (
                    <td key={mi} className="text-right px-3 py-3 whitespace-nowrap">
                      {val > 0 ? formatAmount(val) : <span className="text-gray-300">-</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 전체 섹션 요약 (모든 섹션 한 눈에) */}
      {data.sections.length > 1 && (
        <section className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">📌 전체 섹션 요약</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.sections.map((sec, idx) => {
              const latest = sec.data.length > 0 ? sec.data[sec.data.length - 1] : null;
              return (
                <div key={idx}
                  onClick={() => setSelectedSection(idx)}
                  className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${selectedSection === idx ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-amber-300 hover:bg-amber-50/30'}`}>
                  <h3 className="font-bold text-gray-800 text-sm mb-2">{sec.title.replace(/^[IVX]+\.\s*/, '')}</h3>
                  {sec.unit && <p className="text-xs text-gray-400 mb-1">{sec.unit}</p>}
                  {latest && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">{latest.year} 누계</span>
                        <span className="font-bold text-amber-700">{formatAmount(latest.total, true)}</span>
                      </div>
                      {(() => {
                        let lastMonth = -1;
                        for (let i = 11; i >= 0; i--) { if (latest.months[i] > 0) { lastMonth = i; break; } }
                        return lastMonth >= 0 ? (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-600">{lastMonth + 1}월</span>
                            <span className="font-bold text-indigo-700">{formatAmount(latest.months[lastMonth], true)}</span>
                          </div>
                        ) : null;
                      })()}
                    </div>
                  )}
                  <p className="text-[10px] text-gray-400 mt-2">{sec.data.map((d) => d.year).join(', ')}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 원본 데이터 (디버깅) */}
      <details className="bg-white rounded-2xl shadow-lg border border-gray-200/60 p-6">
        <summary className="text-sm text-indigo-600 cursor-pointer font-medium">📋 원본 데이터 확인 (B179:Q211, {data.totalRows}행)</summary>
        <div className="mt-4 max-h-[400px] overflow-auto">
          <table className="w-full text-xs border">
            <tbody>
              {data.rawRows.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-1 bg-gray-50 font-mono text-gray-500 sticky left-0">{179 + i}</td>
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 border-l max-w-[120px] truncate">{cell || <span className="text-gray-300">-</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
