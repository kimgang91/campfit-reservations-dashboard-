import { NextResponse } from 'next/server';
import { getCampfitTransactions } from '@/lib/campfitTransactions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const startTime = Date.now();
  console.log(`[API] GET /api/campfit-transactions - ${new Date().toISOString()}`);

  try {
    const data = await getCampfitTransactions();
    const elapsed = Date.now() - startTime;

    return NextResponse.json(
      { data },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          'X-Response-Time': String(elapsed),
        },
      },
    );
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error('[API] /api/campfit-transactions error:', error);

    return NextResponse.json(
      {
        error: error?.message || '거래액/매출 데이터를 불러오는 중 오류가 발생했습니다.',
        timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
          'X-Response-Time': String(elapsed),
        },
      },
    );
  }
}
