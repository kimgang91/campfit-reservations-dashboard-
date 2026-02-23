// 캠핏 예약팀용 Google Sheets 연동 및 데이터 전처리 유틸
// - 공개 CSV export 방식 사용
// - B~K 컬럼을 타입 세이프한 객체로 변환

export type PeriodUnit = 'day' | 'week' | 'month';

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
  // 전체 원본 컬럼도 유지 (확장 대비)
  raw: Record<string, string>;
}

const CAMPFIT_SPREADSHEET_ID = '1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M';
const CAMPFIT_SHEET_ID = '1871420372'; // gid

function getCSVUrl(sheetId: string) {
  return `https://docs.google.com/spreadsheets/d/${CAMPFIT_SPREADSHEET_ID}/export?format=csv&gid=${sheetId}`;
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

    const { headerRowIndex, headers } = detectHeaderRow(rows);
    const columnMap = buildColumnIndexMap(headers);

    console.log('[Campfit] Header row index:', headerRowIndex + 1);
    console.log('[Campfit] Headers:', headers);

    const idxCampground = findColumnIndex(headers, columnMap, ['캠핑장명'], 1);
    const idxOperateStatus = findColumnIndex(headers, columnMap, ['운영상태'], 2);
    const idxDetailPlan = findColumnIndex(headers, columnMap, ['세부플랜명', '세부 플랜명'], 3);
    const idxMainPlan = findColumnIndex(headers, columnMap, ['대표플랜명', '대표 플랜명'], 4);
    const idxBundleSub = findColumnIndex(headers, columnMap, ['결합형 소분류', '결합형소분류'], 5);
    const idxEasyCamping = findColumnIndex(headers, columnMap, ['이지캠핑', '이지 캠핑'], 6);
    const idxPlanStatus = findColumnIndex(headers, columnMap, ['플랜상태'], 7);
    const idxStartDate = findColumnIndex(headers, columnMap, ['플랜등록일', '플랜 등록일', '시작일'], 8);
    const idxEndDate = findColumnIndex(headers, columnMap, ['플랜취소일', '플랜 취소일', '종료일'], 9);
    const idxMd = findColumnIndex(headers, columnMap, ['담당 MD', '담당MD', 'MD'], 10);

    const dataStartIndex = headerRowIndex + 1;
    const dataRows = rows.slice(dataStartIndex);

    const records: CampfitPlanRecord[] = [];

    dataRows.forEach((row, i) => {
      const rowNumber = dataStartIndex + i + 1;

      const campgroundName =
        (idxCampground != null && row[idxCampground] ? row[idxCampground].trim() : '') || '';
      if (!campgroundName) {
        return;
      }

      const raw: Record<string, string> = {};
      headers.forEach((h, idx) => {
        const key = h?.trim();
        if (!key) return;
        raw[key] = String(row[idx] ?? '').trim();
      });

      const record: CampfitPlanRecord = {
        rowNumber,
        campgroundName,
        operateStatus:
          idxOperateStatus != null && row[idxOperateStatus] ? row[idxOperateStatus].trim() : undefined,
        detailPlanName:
          idxDetailPlan != null && row[idxDetailPlan] ? row[idxDetailPlan].trim() : undefined,
        mainPlanName: idxMainPlan != null && row[idxMainPlan] ? row[idxMainPlan].trim() : undefined,
        bundleSubType:
          idxBundleSub != null && row[idxBundleSub] ? row[idxBundleSub].trim() : undefined,
        easyCamping:
          idxEasyCamping != null && row[idxEasyCamping] ? row[idxEasyCamping].trim() : undefined,
        planStatus:
          idxPlanStatus != null && row[idxPlanStatus] ? row[idxPlanStatus].trim() : undefined,
        planStartDate:
          idxStartDate != null && row[idxStartDate] ? toISODate(row[idxStartDate]) : null,
        planEndDate: idxEndDate != null && row[idxEndDate] ? toISODate(row[idxEndDate]) : null,
        md: idxMd != null && row[idxMd] ? row[idxMd].trim() : undefined,
        raw,
      };

      records.push(record);
    });

    console.log(`[Campfit] Parsed records: ${records.length}`);
    return records;
  } catch (error: any) {
    console.error('[Campfit] Error fetching campfit plans:', error);
    throw new Error(error?.message || '캠핏 예약팀 데이터를 불러오는 중 오류가 발생했습니다.');
  }
}

