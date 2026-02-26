/**
 * Google Sheets API를 통한 이력관리 모듈
 *
 * 같은 스프레드시트에 "스냅샷" / "이력관리" 시트를 자동 생성하고,
 * 이탈/재입점/신규 이벤트를 기록합니다.
 *
 * 필요 환경변수:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — 서비스 계정 JSON 키 (전체 JSON 문자열)
 *
 * 서비스 계정 이메일에 해당 스프레드시트 편집 권한을 부여해야 합니다.
 */

import { google } from 'googleapis';

const SPREADSHEET_ID = '1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M';
const SNAPSHOT_SHEET = '스냅샷';
const HISTORY_SHEET = '이력관리';

// ─── 인증 ───

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다. ' +
      'Google Cloud 서비스 계정의 JSON 키를 환경변수로 등록해 주세요.',
    );
  }

  let key: any;
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY JSON 파싱에 실패했습니다. 올바른 JSON인지 확인해 주세요.');
  }

  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ─── 시트 존재 확인 / 자동 생성 ───

export async function ensureSheets(): Promise<void> {
  const sheets = await getSheetsClient();

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties.title',
  });

  const existingTitles = spreadsheet.data.sheets?.map((s) => s.properties?.title) || [];

  const requests: any[] = [];

  if (!existingTitles.includes(SNAPSHOT_SHEET)) {
    requests.push({ addSheet: { properties: { title: SNAPSHOT_SHEET } } });
  }

  if (!existingTitles.includes(HISTORY_SHEET)) {
    requests.push({ addSheet: { properties: { title: HISTORY_SHEET } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  // 이력관리 시트에 헤더가 없으면 추가
  if (!existingTitles.includes(HISTORY_SHEET)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${HISTORY_SHEET}'!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['날짜시간', '캠핑장명', '이벤트유형', '담당MD', '비고']],
      },
    });
  }

  console.log('[SheetsAPI] 스냅샷/이력관리 시트 확인 완료');
}

// ─── 스냅샷 읽기 ───

export async function readSnapshot(): Promise<string[]> {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SNAPSHOT_SHEET}'!A:A`,
    });

    const names = (result.data.values || []).flat().filter(Boolean);
    console.log(`[SheetsAPI] 스냅샷 읽기 완료: ${names.length}개 캠핑장`);
    return names;
  } catch (error: any) {
    // 시트가 없는 경우 빈 배열 반환
    if (error?.code === 400 || error?.status === 400) {
      console.log('[SheetsAPI] 스냅샷 시트가 없습니다. 빈 배열 반환');
      return [];
    }
    throw error;
  }
}

// ─── 스냅샷 덮어쓰기 ───

export async function writeSnapshot(names: string[]): Promise<void> {
  const sheets = await getSheetsClient();

  // 기존 데이터 클리어
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SNAPSHOT_SHEET}'!A:A`,
    });
  } catch {
    // 시트가 비어있거나 없는 경우 무시
  }

  if (names.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SNAPSHOT_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: names.map((n) => [n]),
      },
    });
  }

  console.log(`[SheetsAPI] 스냅샷 저장 완료: ${names.length}개 캠핑장`);
}

// ─── 이벤트 유형 ───

export interface HistoryEvent {
  campground: string;
  type: '신규발견' | '이탈' | '재입점';
  md?: string;
  note?: string;
}

// ─── 이력 추가 (append) ───

export async function appendHistory(events: HistoryEvent[]): Promise<void> {
  if (events.length === 0) return;

  const sheets = await getSheetsClient();
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${HISTORY_SHEET}'!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: events.map((e) => [
        timestamp,
        e.campground,
        e.type,
        e.md || '',
        e.note || '',
      ]),
    },
  });

  console.log(`[SheetsAPI] 이력 ${events.length}건 기록 완료`);
}

// ─── 이력 전체 읽기 ───

export interface HistoryRecord {
  date: string;
  campground: string;
  type: string;
  md: string;
  note: string;
}

export async function readHistory(): Promise<HistoryRecord[]> {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${HISTORY_SHEET}'!A:E`,
    });

    const rows = result.data.values || [];
    // 첫 행은 헤더, 나머지가 데이터
    return rows.slice(1).map((row) => ({
      date: row[0] || '',
      campground: row[1] || '',
      type: row[2] || '',
      md: row[3] || '',
      note: row[4] || '',
    }));
  } catch (error: any) {
    if (error?.code === 400 || error?.status === 400) {
      return [];
    }
    throw error;
  }
}

// ─── 서비스 계정 설정 여부 확인 ───

export function isConfigured(): boolean {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}
