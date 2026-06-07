# 마피아

마피아, AI 축구 베팅, 직접 축구, 미니게임을 같은 서버에서 실행하는 웹 게임입니다.

## 실행

Windows에서는 `START_MAFIA_SERVER.bat`를 실행하면 로컬 서버가 열립니다.

```text
http://127.0.0.1:8787
```

Render 배포 설정:

- Build Command: `npm install`
- Start Command: `node server.js`
- Root Directory: 비워두기

## 계정

서버 시작 시 기본 관리자 계정이 생성됩니다.

- 아이디: `admin`
- 표시 닉네임: `운영자`

사용자 계정 데이터는 `data/users.json`에 저장되며 GitHub에는 올리지 않습니다.

## 자동 배포

`DEPLOY_NOW.bat`를 실행하면 현재 파일을 GitHub에 바로 업로드합니다. Render에서 Auto Deploy가 켜져 있으면 업로드 후 웹 링크에도 자동 반영됩니다.

주의:

- `.deploy/` 폴더는 GitHub 토큰이 들어 있으므로 올리지 않습니다.
- `data/` 폴더는 계정 데이터가 들어 있으므로 올리지 않습니다.
