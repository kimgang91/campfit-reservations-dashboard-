import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '캠핏 예약팀 대시보드',
  description: '캠핏 예약팀의 입점/플랜/MD 성과 분석 대시보드',
  viewport: 'width=device-width, initial-scale=1',
  themeColor: '#4f46e5',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}

