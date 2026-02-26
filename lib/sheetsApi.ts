/**
 * Google Sheets API를 통한 이력관리 모듈
 *
 * 같은 스프레드시트에 "스냅샷" / "이력관리" 시트를 자동 생성하고,
 * 이탈/재입점/신규 이벤트를 기록합니다.
 *
 * 인증 방법 (우선순위):
 *   1. GOOGLE_SERVICE_ACCOUNT_KEY 환경변수 (JSON 문자열)
 *   2. 프로젝트 루트의 서비스 계정 JSON 파일 (dashboard-*.json 또는 *-service-account*.json)
 *
 * 서비스 계정 이메일에 해당 스프레드시트 편집 권한을 부여해야 합니다.
 */

import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

const SPREADSHEET_ID = '1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M';
const SNAPSHOT_SHEET = '스냅샷';
const HISTORY_SHEET = '이력관리';

// ─── 인증 ───

/** 서비스 계정 키를 환경변수 또는 로컬 JSON 파일에서 로드 */
function loadServiceAccountKey(): any {
  // 1) 환경변수에서 읽기
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    try {
      const parsed = JSON.parse(keyJson);
      console.log('[SheetsAPI] 환경변수에서 서비스 계정 키 로드 성공 (client_email:', parsed.client_email, ')');
      return parsed;
    } catch (e) {
      console.error('[SheetsAPI] GOOGLE_SERVICE_ACCOUNT_KEY 환경변수 JSON 파싱 실패:', e);
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY JSON 파싱에 실패했습니다. 올바른 JSON인지 확인해 주세요.');
    }
  }

  // 2) 프로젝트 루트에서 JSON 키 파일 검색
  const projectRoot = process.cwd();
  console.log('[SheetsAPI] 환경변수 미설정, 프로젝트 루트에서 JSON 키 파일 검색:', projectRoot);

  try {
    const files = fs.readdirSync(projectRoot);
    const keyFile = files.find(
      (f) =>
        f.endsWith('.json') &&
        (f.includes('dashboard-') || f.includes('service-account') || f.includes('service_account')) &&
        !f.startsWith('package') &&
        !f.startsWith('tsconfig'),
    );

    if (keyFile) {
      const filePath = path.join(projectRoot, keyFile);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.client_email && parsed.private_key) {
        console.log('[SheetsAPI] 로컬 JSON 키 파일에서 서비스 계정 키 로드 성공:', keyFile, '(client_email:', parsed.client_email, ')');
        return parsed;
      }
    }
  } catch (e) {
    console.error('[SheetsAPI] 로컬 JSON 키 파일 검색/읽기 실패:', e);
  }

  return null;
}

function getAuth() {
  const key = loadServiceAccountKey();
  if (!key) {
    throw new Error(
      'Google 서비스 계정 키를 찾을 수 없습니다. ' +
      '다음 중 하나를 설정해 주세요:\n' +
      '1. GOOGLE_SERVICE_ACCOUNT_KEY 환경변수 (Vercel)\n' +
      '2. 프로젝트 루트에 서비스 계정 JSON 키 파일 배치 (로컬)',
    );
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
  // 환경변수 체크
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return true;

  // 로컬 JSON 파일 체크
  try {
    const projectRoot = process.cwd();
    const files = fs.readdirSync(projectRoot);
    const keyFile = files.find(
      (f) =>
        f.endsWith('.json') &&
        (f.includes('dashboard-') || f.includes('service-account') || f.includes('service_account')) &&
        !f.startsWith('package') &&
        !f.startsWith('tsconfig'),
    );
    if (keyFile) {
      const content = fs.readFileSync(path.join(projectRoot, keyFile), 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.client_email && parsed.private_key) return true;
    }
  } catch {
    // 파일 검색 실패 시 false
  }

  return false;
}

/** 연동 상태를 상세히 반환 (디버깅용) */
export function getConfigStatus(): { configured: boolean; source: string; email?: string; error?: string } {
  // 환경변수
  const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (envKey) {
    try {
      const parsed = JSON.parse(envKey);
      return { configured: true, source: 'environment', email: parsed.client_email };
    } catch (e: any) {
      return { configured: false, source: 'environment', error: `환경변수 JSON 파싱 실패: ${e.message}` };
    }
  }

  // 로컬 JSON 파일
  try {
    const projectRoot = process.cwd();
    const files = fs.readdirSync(projectRoot);
    const keyFile = files.find(
      (f) =>
        f.endsWith('.json') &&
        (f.includes('dashboard-') || f.includes('service-account') || f.includes('service_account')) &&
        !f.startsWith('package') &&
        !f.startsWith('tsconfig'),
    );
    if (keyFile) {
      const content = fs.readFileSync(path.join(projectRoot, keyFile), 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.client_email && parsed.private_key) {
        return { configured: true, source: `file:${keyFile}`, email: parsed.client_email };
      }
      return { configured: false, source: `file:${keyFile}`, error: 'JSON에 client_email 또는 private_key가 없습니다' };
    }
  } catch (e: any) {
    return { configured: false, source: 'file-search', error: `파일 검색 실패: ${e.message}` };
  }

  return { configured: false, source: 'none', error: '환경변수도 없고, 로컬 JSON 키 파일도 찾을 수 없습니다.' };
}
