# 마피아 서버

## 실행

`START_MAFIA_SERVER.bat`을 더블클릭하세요.

자동으로 열립니다:

- 게임 화면
- `CONNECT_ADDRESS.html` 접속 안내 페이지

## 다른 기기 접속

1. 모든 기기를 같은 Wi-Fi에 연결합니다.
2. `CONNECT_ADDRESS.html`에 나온 주소를 폰/패드/다른 컴퓨터 브라우저에 입력합니다.
3. QR 코드가 보이면 폰으로 스캔해도 됩니다.
4. 방을 만들고 방 코드나 초대 링크를 공유합니다.

## 방 나가기

게임 화면 오른쪽 위의 `방 나가기` 버튼을 누르면 방에서 나갑니다.

방장이 나가면 다음 참가자가 자동으로 방장이 됩니다.

## 폰/패드끼리만 하기

폰/패드끼리만 하려면 Render 같은 온라인 서버에 배포해야 합니다.

Render 설정:

- Build Command: `npm install`
- Start Command: `node server.js`
- Root Directory: `package.json`과 `server.js`가 있는 폴더

## 서버 끄기

`STOP_MAFIA_SERVER.bat`을 실행하세요.
