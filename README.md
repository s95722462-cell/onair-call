# 온에어 호출대기

식당 번호 호출 · 줄 서기 · 손님 휴대폰 알림 · TV 번호판. 가게마다 설정 파일 하나.

## 주소 (`<코드>` = 가게코드)
- 직원 화면: `?s=<코드>`
- 손님 줄 서기 (카운터 QR): `?s=<코드>&q`
- 손님 번호로 기다리기: `?s=<코드>&n=15`
- TV 번호판: `?s=<코드>&board`
- QR 안내판 인쇄 (A5): `?s=<코드>&sign`

## 새 가게 추가
1. 길고 무작위인 가게코드 만들기 (영소문자·숫자 16~40자).
2. `shops/<코드>.json` 복사해서 이름·색·멘트·`expires`(YYYY-MM-DD) 고치기.
3. 고칠 때마다 `sw.js` 의 `CACHE` 번호 올리기.

## 설정 한 곳 (`app.js` 맨 위)
- `DEFAULT_RELAY` 중계 서버 (지금 ntfy.sh 무료) · `SUPPORT` 연장 문의 연락처 · `GRACE_DAYS` 유예 일수.
- 구독 확인은 `checkSubscription()` 하나 — 나중에 서버 확인으로 바꿀 때 여기만.

## 시험
`node tests/e2e.js` (가짜 중계) · `node tests/e2e.js --real` (실제 ntfy.sh 2건 추가)
