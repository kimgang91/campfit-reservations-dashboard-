import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 p-4">
      <div className="max-w-xl w-full bg-white rounded-2xl shadow-xl border border-gray-100 p-6 space-y-4">
        <h1 className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
          캠핏 예약팀 대시보드
        </h1>
        <p className="text-sm md:text-base text-gray-600">
          Google 스프레드시트 기반으로 입점 현황, 플랜 변화, MD 성과를 분석하는 전용 대시보드입니다.
        </p>
        <Link
          href="/campfit"
          className="inline-flex items-center justify-center px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm md:text-base font-medium shadow-md hover:from-blue-700 hover:to-indigo-700 transition"
        >
          대시보드 열기
        </Link>
      </div>
    </main>
  );
}

