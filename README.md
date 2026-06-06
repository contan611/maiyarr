# 마피아 / AI 축구 서버

마피아와 AI 축구 베팅을 같은 서버에서 실행하는 웹 게임입니다.

## 로컬 실행

`START_MAFIA_SERVER.bat`을 실행하면 로컬 서버가 열립니다.

주소:

```text
http://127.0.0.1:8787
```

## 온라인 배포

Render 설정:

- Build Command: 비워두거나 `npm install`
- Start Command: `node server.js`
- Root Directory: 비워두기

저장소 루트 구조:

```text
server.js
package.json
render.yaml
README.md
public/
  index.html
  app.js
  styles.css
```

## 자동 배포

한 번만 `SETUP_AUTO_DEPLOY.bat`을 실행해서 GitHub 토큰, 저장소, 브랜치를 저장하세요.

그 다음부터는:

- `DEPLOY_NOW.bat`: 지금 파일을 GitHub에 바로 업로드합니다.
- `WATCH_AUTO_DEPLOY.bat`: 켜두면 파일이 바뀔 때 자동으로 GitHub에 업로드합니다.

Render가 GitHub 저장소와 연결되어 있고 Auto Deploy가 켜져 있으면 GitHub 업로드 후 웹 서버에 자동 반영됩니다.

주의:

- `.deploy` 폴더에는 암호화된 GitHub 토큰이 들어가므로 GitHub에 올리지 마세요.
- `data/users.json`은 계정 데이터라서 GitHub에 올리지 마세요.

## 관리자 로그인

```text
아이디: admin
비밀번호: tksxh1357!
```

서버 시작 시 `admin` 계정은 자동 생성되고 관리자 권한이 부여됩니다.
