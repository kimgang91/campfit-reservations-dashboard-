/**
 * 캠핏 이력관리 API
 *
 * GET    → 이전 스냅샷 + 이력 조회 + 설정 상태 진단
 * POST   → 현재 캠핑장 목록과 비교 → 이탈/재입점 판별 → 기록 → 결과 반환
 * DELETE → 이력 초기화 (스냅샷 + 이력 시트 전체 삭제)
 *
 * ⚠️ POST는 새로고침 버튼 클릭 시에만 호출됩니다 (초기 로드 시 호출하지 않음).
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─── GET: 스냅샷 + 이력 조회 ───

export async function GET() {
  try {
    const { isConfigured, getConfigStatus } = await import('@/lib/sheetsApi');
    const configStatus = getConfigStatus();

    console.log('[API] campfit-history GET - config status:', JSON.stringify(configStatus));

    if (!isConfigured()) {
      return NextResponse.json({
        configured: false,
        snapshot: [],
        history: [],
        configStatus,
        message: configStatus.error || '서비스 계정 키를 찾을 수 없습니다.',
      });
    }

    const { readSnapshot, readHistory, ensureSheets } = await import('@/lib/sheetsApi');

    await ensureSheets();
    const [snapshot, history] = await Promise.all([readSnapshot(), readHistory()]);

    return NextResponse.json({
      configured: true,
      configStatus,
      snapshot,
      history,
    });
  } catch (error: any) {
    console.error('[API] campfit-history GET error:', error);

    // ★ 핵심 수정: 설정은 되어 있지만 런타임 오류인 경우를 구분
    let isKeyConfigured = false;
    try {
      const { isConfigured } = await import('@/lib/sheetsApi');
      isKeyConfigured = isConfigured();
    } catch { /* ignore */ }

    return NextResponse.json({
      configured: isKeyConfigured, // 키가 있으면 true 유지
      runtimeError: true,          // 런타임 오류 플래그
      error: error?.message || '이력 조회 중 오류가 발생했습니다.',
      errorDetail: String(error),
      snapshot: [],
      history: [],
    }, { status: isKeyConfigured ? 200 : 500 }); // 키가 있으면 200으로 (프론트가 데이터 처리 가능하도록)
  }
}

// ─── DELETE: 이력 초기화 ───

export async function DELETE() {
  try {
    const { isConfigured, getConfigStatus } = await import('@/lib/sheetsApi');
    const configStatus = getConfigStatus();

    if (!isConfigured()) {
      return NextResponse.json({ configured: false, message: configStatus.error || '서비스 계정 미설정' });
    }

    const { ensureSheets, clearAllHistory } = await import('@/lib/sheetsApi');
    await ensureSheets();
    await clearAllHistory();

    return NextResponse.json({ configured: true, success: true, message: '이력 초기화 완료' });
  } catch (error: any) {
    console.error('[API] campfit-history DELETE error:', error);
    return NextResponse.json({ configured: false, error: error?.message || '초기화 실패' }, { status: 500 });
  }
}

// ─── POST: 비교 + 기록 + 스냅샷 업데이트 ───
// ⚠️ 새로고침 버튼 클릭 시에만 호출됩니다

export async function POST(request: Request) {
  try {
    const { isConfigured, getConfigStatus } = await import('@/lib/sheetsApi');
    const configStatus = getConfigStatus();

    console.log('[API] campfit-history POST - config status:', JSON.stringify(configStatus));

    if (!isConfigured()) {
      return NextResponse.json({
        configured: false,
        lost: [],
        rejoined: [],
        configStatus,
        message: configStatus.error || '서비스 계정 키를 찾을 수 없습니다.',
      });
    }

    const body = await request.json();
    const currentNames: string[] = body.currentNames || [];
    const mdMap: Record<string, string> = body.mdMap || {};

    const {
      ensureSheets,
      readSnapshot,
      writeSnapshot,
      appendHistory,
    } = await import('@/lib/sheetsApi');
    type HistoryEvent = import('@/lib/sheetsApi').HistoryEvent;

    await ensureSheets();

    // 1) 이전 스냅샷 읽기
    const prevNames = await readSnapshot();

    const prevSet = new Set(prevNames);
    const currSet = new Set(currentNames);

    const lost: string[] = [];
    const rejoined: string[] = [];
    const events: HistoryEvent[] = [];

    // 2) 이탈: 이전에 있었는데 지금 없는 캠핑장
    prevSet.forEach((name) => {
      if (!currSet.has(name)) {
        lost.push(name);
        events.push({
          campground: name,
          type: '이탈',
          md: mdMap[name] || '',
          note: '이전 스냅샷에 있었으나 현재 시트에서 사라짐',
        });
      }
    });

    // 3) 재입점: 지금 있는데 이전에 없었고, 과거 이탈 이력이 있는 캠핑장
    const { readHistory } = await import('@/lib/sheetsApi');
    const allHistory = await readHistory();
    const everChurnedSet = new Set(
      allHistory.filter((h) => h.type === '이탈').map((h) => h.campground),
    );

    currSet.forEach((name) => {
      if (!prevSet.has(name) && prevNames.length > 0) {
        if (everChurnedSet.has(name)) {
          rejoined.push(name);
          events.push({
            campground: name,
            type: '재입점',
            md: mdMap[name] || '',
            note: '이전에 이탈했다가 다시 시트에 등장',
          });
        }
        // ※ 신규발견(시트에 처음 등장)은 더 이상 이력에 기록하지 않음
      }
    });

    // 4) 이력 기록
    if (events.length > 0) {
      await appendHistory(events);
    }

    // 5) 스냅샷 업데이트
    await writeSnapshot(currentNames);

    console.log(
      `[API] campfit-history POST 완료 — 이탈: ${lost.length}, 재입점: ${rejoined.length}`,
    );

    return NextResponse.json({
      configured: true,
      lost,
      rejoined,
      eventsRecorded: events.length,
    });
  } catch (error: any) {
    console.error('[API] campfit-history POST error:', error);

    // ★ 핵심 수정: 설정은 되어 있지만 런타임 오류인 경우를 구분
    let isKeyConfigured = false;
    try {
      const { isConfigured } = await import('@/lib/sheetsApi');
      isKeyConfigured = isConfigured();
    } catch { /* ignore */ }

    return NextResponse.json({
      configured: isKeyConfigured,
      runtimeError: true,
      error: error?.message || '이력 기록 중 오류가 발생했습니다.',
      errorDetail: String(error),
      lost: [],
      rejoined: [],
    }, { status: isKeyConfigured ? 200 : 500 });
  }
}
