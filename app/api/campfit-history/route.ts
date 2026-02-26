/**
 * 캠핏 이력관리 API
 *
 * GET  → 이전 스냅샷 + 이력 조회
 * POST → 현재 캠핑장 목록과 비교 → 이탈/재입점/신규 판별 → 기록 → 결과 반환
 *
 * GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 없으면 configured: false 를 반환하고,
 * 프론트엔드에서 localStorage 폴백을 사용하도록 안내합니다.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─── GET: 스냅샷 + 이력 조회 ───

export async function GET() {
  try {
    const { isConfigured } = await import('@/lib/sheetsApi');

    if (!isConfigured()) {
      return NextResponse.json({
        configured: false,
        snapshot: [],
        history: [],
        message: 'GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다.',
      });
    }

    const { readSnapshot, readHistory, ensureSheets } = await import('@/lib/sheetsApi');

    await ensureSheets();
    const [snapshot, history] = await Promise.all([readSnapshot(), readHistory()]);

    return NextResponse.json({
      configured: true,
      snapshot,
      history,
    });
  } catch (error: any) {
    console.error('[API] campfit-history GET error:', error);
    return NextResponse.json(
      { error: error?.message || '이력 조회 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}

// ─── POST: 비교 + 기록 + 스냅샷 업데이트 ───

export async function POST(request: Request) {
  try {
    const { isConfigured } = await import('@/lib/sheetsApi');

    if (!isConfigured()) {
      return NextResponse.json({
        configured: false,
        lost: [],
        rejoined: [],
        newlyFound: [],
        message: 'GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다.',
      });
    }

    const body = await request.json();
    const currentNames: string[] = body.currentNames || [];
    // MD 매핑: { campgroundName: md } — 이력 기록 시 담당MD 함께 저장
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
    const newlyFound: string[] = [];
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

    // 3) 신규 발견 / 재입점: 지금 있는데 이전에 없었던 캠핑장
    //    재입점 판별을 위해 전체 이력에서 이탈 이력이 있는지 확인
    const { readHistory } = await import('@/lib/sheetsApi');
    const allHistory = await readHistory();
    const everChurnedSet = new Set(
      allHistory.filter((h) => h.type === '이탈').map((h) => h.campground),
    );

    currSet.forEach((name) => {
      if (!prevSet.has(name)) {
        if (everChurnedSet.has(name)) {
          // 과거에 이탈한 적 있는 캠핑장이 다시 나타남 = 재입점
          rejoined.push(name);
          events.push({
            campground: name,
            type: '재입점',
            md: mdMap[name] || '',
            note: '이전에 이탈했다가 다시 시트에 등장',
          });
        } else if (prevNames.length > 0) {
          // 이전 스냅샷이 존재하는 상황에서 처음 등장 = 신규 발견
          newlyFound.push(name);
          events.push({
            campground: name,
            type: '신규발견',
            md: mdMap[name] || '',
            note: '시트에 처음 등장한 캠핑장',
          });
        }
      }
    });

    // 4) 이력 기록
    if (events.length > 0) {
      await appendHistory(events);
    }

    // 5) 스냅샷 업데이트
    await writeSnapshot(currentNames);

    console.log(
      `[API] campfit-history POST 완료 — 이탈: ${lost.length}, 재입점: ${rejoined.length}, 신규발견: ${newlyFound.length}`,
    );

    return NextResponse.json({
      configured: true,
      lost,
      rejoined,
      newlyFound,
      eventsRecorded: events.length,
    });
  } catch (error: any) {
    console.error('[API] campfit-history POST error:', error);
    return NextResponse.json(
      { error: error?.message || '이력 기록 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
