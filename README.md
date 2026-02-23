# 캠핏 예약팀 대시보드 (Campfit Reservations Dashboard)

캠핏 예약팀의 입점 현황, 플랜 변화, MD 성과를 **Google 스프레드시트** 기반으로 분석하는 전용 Next.js 대시보드입니다.

## 1. 기술 스택

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Recharts
- date-fns

## 2. 데이터 소스

- Google 스프레드시트 (공개 CSV export 방식)
- URL 예시:

> `https://docs.google.com/spreadsheets/d/1lLUbwO8TATN1wRG6TuQel0m7arNudnfxW3pdchYXn8M/edit?gid=1871420372#gid=1871420372`

`lib/campfitReservations.ts` 에서 해당 스프레드시트 ID / gid 를 사용해 CSV 를 가져옵니다.

## 3. 주요 기능

- **기간 단위 선택**: 일 / 주 / 월
- **기간 필터**: 시작일 ~ 종료일
- **MD / 대표플랜 / 결합형 소분류 / 이지캠핑 필터**
- **KPI 카드**
  - 총 운영 캠핑장 수
  - 이번 달 신규 입점 / 종료 / 순증감
  - MD별 1위 (신규 입점 기준)
- **차트**
  - 기간별 신규 / 종료 / 순증감 (라인 차트)
  - 현재 운영 플랜 비중 (대표플랜 기준 파이 차트)
  - MD별 신규 / 순증감 (막대 차트)
  - 플랜별 신규 / 종료 / 플랜 전환 (막대 차트)
- **목록 테이블**
  - 캠핑장명, 세부플랜명, 대표플랜명, 담당 MD, 시작/종료일, 플랜상태

## 4. 로컬 실행 방법

```bash
cd campfit-reservations-dashboard
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후, **"대시보드 열기"** 버튼을 클릭하거나 `http://localhost:3000/campfit` 로 바로 접근합니다.

## 5. GitLab & Vercel 배포

1. 이 디렉터리(`campfit-reservations-dashboard`)를 GitLab 리포지토리로 푸시합니다.
2. Vercel 대시보드에서 **New Project → GitLab repo 선택** 후 연결합니다.
3. Framework 는 **Next.js**, root directory 는 **`campfit-reservations-dashboard`** 로 설정합니다.
4. 별도 환경변수는 필요 없으며, 빌드 커맨드는 기본값(`next build`), 출력 디렉터리는 `.next` 를 사용합니다.

배포 후 `/campfit` 경로에서 대시보드를 바로 사용할 수 있습니다.

## 6. 주의 사항

- 스프레드시트는 **"링크가 있는 모든 사용자(보기 가능)"** 로 공유되어 있어야 합니다.
- 인증이 필요한 비공개 스프레드시트로 변경하고 싶다면, 서비스 계정 방식으로 확장할 수 있도록 `lib/campfitReservations.ts` 를 감싸는 별도 클라이언트를 추가하면 됩니다. 

