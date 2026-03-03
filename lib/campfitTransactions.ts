/**
 * 캠핏 예약팀 거래액/매출 데이터 가져오기
 * - [지표] 요약 시트 (gid=1427269904)에서 B179:Q211 범위를 읽음
 * - 연도별/월별 예약건수, 거래액, 매출액 데이터 파싱
 */

const SPREADSHEET_ID = '1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M';
const SUMMARY_SHEET_GID = '1427269904'; // [지표] 요약 시트

// ─── 타입 정의 ───

export interface YearlyMonthlyData {
  year: string;           // 연도 (예: "2021", "2022", ...)
  total: number;          // 누계
  months: number[];       // [01월, 02월, ..., 12월] (인덱스 0 = 1월)
}

export interface TransactionSection {
  title: string;          // 섹션 제목 (예: "예약 건수", "거래액", "매출액")
  unit?: string;          // 단위 (예: "건", "원")
  data: YearlyMonthlyData[];
}

export interface TransactionData {
  sections: TransactionSection[];
  rawRows: string[][];    // 원본 데이터 (디버깅용)
  totalRows: number;
}

// ─── CSV 파서 (멀티라인 대응) ───

function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  const row: string[] = [];

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (char === '"') {
      if (inQuotes && i + 1 < csvText.length && csvText[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && i + 1 < csvText.length && csvText[i + 1] === '\n') {
        i++; // skip \r\n
      }
      row.push(current.trim());
      if (row.some((cell) => cell !== '')) {
        rows.push([...row]);
      }
      row.length = 0;
      current = '';
    } else {
      current += char;
    }
  }

  // 마지막 행
  row.push(current.trim());
  if (row.some((cell) => cell !== '')) {
    rows.push([...row]);
  }

  return rows;
}

// ─── 숫자 파싱 (쉼표 제거, 빈 값은 0) ───

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/,/g, '').replace(/\s/g, '').replace(/원/g, '').replace(/건/g, '').replace(/₩/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// ─── 데이터 가져오기 ───

export async function getCampfitTransactions(): Promise<TransactionData> {
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SUMMARY_SHEET_GID}&single=true`;
    console.log(`[Transactions] Fetching CSV from gid=${SUMMARY_SHEET_GID}`);

    const response = await fetch(csvUrl, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Google Sheets에 접근할 수 없습니다. 문서가 공개되어 있는지 확인해주세요.');
      }
      throw new Error(`Google Sheets 요청 실패 (status: ${response.status})`);
    }

    const csvText = await response.text();
    const allRows = parseCSV(csvText);

    console.log(`[Transactions] Total CSV rows: ${allRows.length}`);

    // B179:Q211 추출 (0-based: row 178~210, col 1~16)
    // B=1, C=2, ..., Q=16
    const START_ROW = 178; // 0-based (179행 = index 178)
    const END_ROW = 210;   // 0-based (211행 = index 210)
    const START_COL = 1;   // B열
    const END_COL = 16;    // Q열

    const targetRows: string[][] = [];
    for (let r = START_ROW; r <= Math.min(END_ROW, allRows.length - 1); r++) {
      const row = allRows[r] || [];
      const sliced = row.slice(START_COL, END_COL + 1);
      targetRows.push(sliced);
    }

    console.log(`[Transactions] Target rows (B179:Q211): ${targetRows.length}`);
    // 디버깅: 처음 5행 출력
    targetRows.slice(0, 5).forEach((row, i) => {
      console.log(`[Transactions] Row ${i}: ${JSON.stringify(row.slice(0, 5))}...`);
    });

    // ─── 섹션 파싱 ───
    // 구조: 각 섹션은 제목행 → 단위행(선택) → 헤더행(구분, 누계, 01월, ...) → 데이터행들
    const sections: TransactionSection[] = [];
    let i = 0;

    while (i < targetRows.length) {
      const row = targetRows[i];
      const firstCell = (row[0] || '').trim();

      // 빈 행 스킵
      if (!firstCell) {
        i++;
        continue;
      }

      // 섹션 제목 탐지: 숫자가 아니고, "구분"이 아닌 행
      // 제목 패턴: "III. 예약 건수", "I. 총 거래액" 등
      if (
        firstCell.match(/^[IVX]+\./) ||
        firstCell.includes('거래액') ||
        firstCell.includes('매출') ||
        firstCell.includes('예약') ||
        firstCell.includes('건수')
      ) {
        const section: TransactionSection = {
          title: firstCell,
          data: [],
        };

        i++;

        // 단위행 체크
        if (i < targetRows.length) {
          const nextCell = (targetRows[i][0] || '').trim();
          if (nextCell.includes('단위') || nextCell.includes('원') || nextCell.includes('건')) {
            section.unit = nextCell;
            i++;
          }
        }

        // 헤더행 스킵 (구분, 누계, 01월, ...)
        if (i < targetRows.length) {
          const headerCell = (targetRows[i][0] || '').trim();
          if (headerCell === '구분' || headerCell.includes('구분')) {
            i++;
          }
        }

        // 데이터행 읽기 (연도가 나오는 동안)
        while (i < targetRows.length) {
          const dataRow = targetRows[i];
          const yearCell = (dataRow[0] || '').trim();

          // 연도 패턴 (2019, 2020, ..., 2026) 또는 빈 행이면 섹션 종료
          if (!yearCell || (!yearCell.match(/^\d{4}$/) && !yearCell.includes('2'))) {
            break;
          }

          // 연도에서 순수 숫자만 추출
          const yearMatch = yearCell.match(/\d{4}/);
          if (yearMatch) {
            const yearlyData: YearlyMonthlyData = {
              year: yearMatch[0],
              total: parseNumber(dataRow[1]), // 누계
              months: [],
            };

            // 01월~12월 (인덱스 2~13)
            for (let m = 2; m <= 13; m++) {
              yearlyData.months.push(parseNumber(dataRow[m]));
            }

            section.data.push(yearlyData);
          }

          i++;
        }

        if (section.data.length > 0) {
          sections.push(section);
        }

        continue;
      }

      // 연도 데이터가 직접 나오는 경우 (제목 없이)
      if (firstCell.match(/^\d{4}$/)) {
        // 이전 섹션에 추가하거나 새 섹션 생성
        const section: TransactionSection = {
          title: '기타',
          data: [],
        };

        while (i < targetRows.length) {
          const dataRow = targetRows[i];
          const yearCell = (dataRow[0] || '').trim();
          const yearMatch = yearCell.match(/\d{4}/);

          if (!yearMatch) break;

          const yearlyData: YearlyMonthlyData = {
            year: yearMatch[0],
            total: parseNumber(dataRow[1]),
            months: [],
          };

          for (let m = 2; m <= 13; m++) {
            yearlyData.months.push(parseNumber(dataRow[m]));
          }

          section.data.push(yearlyData);
          i++;
        }

        if (section.data.length > 0) {
          sections.push(section);
        }

        continue;
      }

      i++;
    }

    console.log(`[Transactions] Parsed ${sections.length} sections:`);
    sections.forEach((s) => {
      console.log(`  - "${s.title}": ${s.data.length} years (${s.data.map((d) => d.year).join(', ')})`);
    });

    return {
      sections,
      rawRows: targetRows,
      totalRows: targetRows.length,
    };
  } catch (error: any) {
    console.error('[Transactions] Error:', error);
    throw new Error(error?.message || '거래액/매출 데이터를 불러오는 중 오류가 발생했습니다.');
  }
}
