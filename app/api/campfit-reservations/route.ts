import { NextResponse } from 'next/server';
import { getCampfitPlans } from '@/lib/campfitReservations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const startTime = Date.now();
  console.log(`[API] GET /api/campfit-reservations - ${new Date().toISOString()}`);

  try {
    const data = await getCampfitPlans();
    const elapsed = Date.now() - startTime;

    return NextResponse.json(
      { data },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          'X-Data-Count': String(data.length),
          'X-Response-Time': String(elapsed),
        },
      },
    );
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error('[API] /api/campfit-reservations error:', error);

    return NextResponse.json(
      {
        error: error?.message || '캠핏 예약팀 데이터를 불러오는 중 오류가 발생했습니다.',
        timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
          'X-Error': 'true',
          'X-Response-Time': String(elapsed),
        },
      },
    );
  }
}

