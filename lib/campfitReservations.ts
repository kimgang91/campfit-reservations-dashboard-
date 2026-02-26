// 캠핏 예약팀용 Google Sheets 연동 및 데이터 전처리 유틸
// - 공개 CSV export 방식 사용
// - B~K 컬럼을 타입 세이프한 객체로 변환

export type PeriodUnit = 'day' | 'week' | 'month';

// 유형 우선순위 (N열 보유존 타입에서 대표 유형 1개 자동 분류)
const TYPE_PRIORITY = ['오토캠핑', '글램핑', '카라반', '펜션', '방가로', '차박'] as const;
export type CampgroundType = (typeof TYPE_PRIORITY)[number] | '기타';

/** N열(보유존 타입)에서 대표 유형 1개를 우선순위 기반으로 추출 */
export function classifyCampgroundType(zoneType?: string): CampgroundType {
  if (!zoneType) return '기타';
  const normalized = zoneType.trim();
  for (const t of TYPE_PRIORITY) {
    if (normalized.includes(t)) return t;
  }
  return '기타';
}

// 원시 시트 행을 전처리한 레코드 타입
export interface CampfitPlanRecord {
  rowNumber: number; // 시트 내 실제 행 번호 (디버깅용)
  campgroundName: string; // B: 캠핑장명
  operateStatus?: string; // C: 운영상태
  detailPlanName?: string; // D: 세부플랜명
  mainPlanName?: string; // E: 대표플랜명
  bundleSubType?: string; // F: 결합형 소분류
  easyCamping?: string; // G: 이지캠핑 (Y/N)
  planStatus?: string; // H: 플랜상태
  planStartDate?: string | null; // I: 플랜등록일 (ISO YYYY-MM-DD 또는 null)
  planEndDate?: string | null; // J: 플랜취소일 (ISO YYYY-MM-DD 또는 null)
  md?: string; // K: 담당 MD
  zoneType?: string; // N: 보유존 타입 (원본)
  campgroundType: CampgroundType; // N에서 파생: 대표 유형
  grade?: string; // O: 등급
  // 전체 원본 컬럼도 유지 (확장 대비)
  raw: Record<string, string>;
}

const CAMPFIT_SPREADSHEET_ID = '1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M';
const CAMPFIT_SHEET_ID = '1871420372'; // gid

function getCSVUrl(sheetId: string) {
  // Google Sheets CSV export는 기본적으로 제한이 있을 수 있으므로,
  // 전체 데이터를 가져오기 위해 범위를 명시하지 않고 전체 시트를 가져오도록 설정
  // 참고: Google Sheets CSV export는 기본적으로 최대 10,000행까지 지원하지만,
  // 실제로는 더 적을 수 있으므로 로그로 확인 필요
  return `https://docs.google.com/spreadsheets/d/${CAMPFIT_SPREADSHEET_ID}/export?format=csv&gid=${sheetId}&single=true`;
}

// 간단한 CSV 파서
function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  const lines = csvText.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const row: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    row.push(current.trim());
    rows.push(row);
  }

  return rows;
}

// 날짜 문자열을 ISO(YYYY-MM-DD) 로 최대한 안전하게 변환
function toISODate(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .split(' ')[0];

  const parts = normalized.split('-');
  if (parts.length === 3) {
    const [y, m, d] = parts;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      year > 1900 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return `${year}-${mm}-${dd}`;
    }
  }

  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 헤더 행을 찾아 컬럼명 → 인덱스 매핑 생성
function detectHeaderRow(rows: string[][]): { headerRowIndex: number; headers: string[] } {
  if (!rows.length) {
    throw new Error('시트에 데이터가 없습니다.');
  }

  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const row = rows[i];
    const joined = row.join(' ');
    if (joined.includes('캠핑장명') && joined.includes('세부플랜')) {
      return { headerRowIndex: i, headers: row };
    }
  }

  return { headerRowIndex: 0, headers: rows[0] };
}

function buildColumnIndexMap(headers: string[]) {
  const map: Record<string, number> = {};
  headers.forEach((h, idx) => {
    const key = h.trim();
    if (!key) return;
    map[key] = idx;
  });
  return map;
}

function findColumnIndex(
  headers: string[],
  map: Record<string, number>,
  candidates: string[],
  fallbackIndex?: number,
): number | null {
  for (const name of candidates) {
    if (map[name] !== undefined) return map[name];
  }

  for (const name of candidates) {
    for (const header of headers) {
      if (!header) continue;
      if (header.includes(name) || name.includes(header)) {
        return map[header];
      }
    }
  }

  if (fallbackIndex !== undefined) {
    return fallbackIndex;
  }

  return null;
}

// 시트에서 캠핏 예약팀 데이터 가져오기
// 🔸 요구사항: 시트에 있는 캠핑장(플랜) 데이터를 최대한 모두 가져온다
// 🔸 단순하고 확실한 방식으로 B~K 컬럼 인덱스를 고정해서 파싱
export async function getCampfitPlans(): Promise<CampfitPlanRecord[]> {
  try {
    const csvUrl = getCSVUrl(CAMPFIT_SHEET_ID);
    console.log(`[Campfit] Fetching CSV from: ${csvUrl}`);

    const response = await fetch(csvUrl, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          'Google Sheets에 접근할 수 없습니다. 문서를 \"링크가 있는 모든 사용자(보기 가능)\"로 공유했는지 확인해주세요.',
        );
      }
      throw new Error(`Google Sheets 요청 실패 (status: ${response.status})`);
    }

    const csvText = await response.text();
    const rows = parseCSV(csvText);

    if (!rows.length) {
      console.warn('[Campfit] CSV 에 데이터가 없습니다.');
      return [];
    }

    // 1행을 헤더로 간주하고, 2행부터 데이터를 사용 (스펙: B~K 컬럼 고정)
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    console.log('[Campfit] Total CSV rows:', rows.length);
    console.log('[Campfit] Header row:', headers);
    console.log('[Campfit] Data rows (excluding header):', dataRows.length);

    // B~K + N, O 컬럼 인덱스 (0-based)
    const IDX_B = 1; // 캠핑장명
    const IDX_C = 2; // 운영상태
    const IDX_D = 3; // 세부플랜명
    const IDX_E = 4; // 대표플랜명
    const IDX_F = 5; // 결합형 소분류
    const IDX_G = 6; // 이지캠핑
    const IDX_H = 7; // 플랜상태
    const IDX_I = 8; // 플랜등록일
    const IDX_J = 9; // 플랜취소일
    const IDX_K = 10; // 담당 MD
    const IDX_N = 13; // 보유존 타입
    const IDX_O = 14; // 등급

    const records: CampfitPlanRecord[] = [];

    dataRows.forEach((row, i) => {
      const rowNumber = i + 2; // 1-based, 헤더 다음 행부터

      // 캠핑장명(B)이 비어있으면 스킵 (타이틀/빈 행)
      const campgroundName = (row[IDX_B] || '').trim();
      if (!campgroundName || campgroundName === '캠핑장명') {
        return;
      }

      const operateStatus = (row[IDX_C] || '').trim() || undefined;
      const detailPlanName = (row[IDX_D] || '').trim() || undefined;
      const mainPlanName = (row[IDX_E] || '').trim() || undefined;
      const bundleSubType = (row[IDX_F] || '').trim() || undefined;
      const easyCamping = (row[IDX_G] || '').trim() || undefined;
      const planStatus = (row[IDX_H] || '').trim() || undefined;
      const planStartDate = row[IDX_I] ? toISODate(row[IDX_I]) : null;
      const planEndDate = row[IDX_J] ? toISODate(row[IDX_J]) : null;
      const md = (row[IDX_K] || '').trim() || undefined;
      const zoneType = (row[IDX_N] || '').trim() || undefined;
      const grade = (row[IDX_O] || '').trim() || undefined;
      const campgroundType = classifyCampgroundType(zoneType);

      const raw: Record<string, string> = {};
      headers.forEach((h, idx) => {
        const key = String(h || '').trim();
        if (!key) return;
        raw[key] = String(row[idx] ?? '').trim();
      });

      records.push({
        rowNumber,
        campgroundName,
        operateStatus,
        detailPlanName,
        mainPlanName,
        bundleSubType,
        easyCamping,
        planStatus,
        planStartDate,
        planEndDate,
        md,
        zoneType,
        campgroundType,
        grade,
        raw,
      });
    });

    console.log(`[Campfit] Parsed records: ${records.length}`);
    return records;
  } catch (error: any) {
    console.error('[Campfit] Error fetching campfit plans:', error);
    throw new Error(error?.message || '캠핏 예약팀 데이터를 불러오는 중 오류가 발생했습니다.');
  }
}

